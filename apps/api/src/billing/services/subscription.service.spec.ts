import { Prisma, SubscriptionStatus } from '@prisma/client';

import {
  ConcurrentSubscriptionChangeError,
  InvalidSubscriptionTransitionError,
} from '../billing.errors';
import { SubscriptionStateService } from './subscription-state.service';
import { SubscriptionService } from './subscription.service';

function createPrismaMock() {
  const prisma: any = {
    plan: { findMany: jest.fn() },
    subscription: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(({ data }: any) => ({ id: 's1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  // A transação própria do serviço roda sobre o mesmo dublê.
  prisma.$transaction = jest.fn((work: (tx: unknown) => unknown) => work(prisma));
  return prisma;
}

describe('SubscriptionService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { record: jest.Mock };
  let service: SubscriptionService;

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { record: jest.fn().mockResolvedValue({}) };
    service = new SubscriptionService(prisma as any, new SubscriptionStateService(), audit as any);
  });

  describe('createSubscription', () => {
    it('calcula trialEndsAt ao iniciar em trialing e audita', async () => {
      prisma.subscription.create.mockImplementation(({ data }: any) => ({ id: 's1', ...data }));

      const result = await service.createSubscription({
        userId: 'u1',
        planId: 'p1',
        status: SubscriptionStatus.trialing,
      });

      const createArg = prisma.subscription.create.mock.calls[0][0];
      expect(createArg.data.trialEndsAt).toBeInstanceOf(Date);
      expect(result.status).toBe('trialing');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'created', newStatus: 'trialing' }),
      );
    });

    it('default status pending sem trial', async () => {
      prisma.subscription.create.mockImplementation(({ data }: any) => ({ id: 's1', ...data }));

      await service.createSubscription({ userId: 'u1', planId: 'p1' });

      const createArg = prisma.subscription.create.mock.calls[0][0];
      expect(createArg.data.status).toBe('pending');
      expect(createArg.data.trialEndsAt).toBeNull();
    });
  });

  describe('prepareCheckoutSubscription', () => {
    const fresh = {
      planId: 'plan_2',
      providerCheckoutId: null,
      checkoutExpiresAt: null,
      cancelAtPeriodEnd: false,
    };

    it('reusa a tentativa pending, trocando o plano e largando o checkout anterior', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'pending',
        providerSubscriptionId: null,
      });
      prisma.subscription.findUniqueOrThrow.mockResolvedValue({ id: 's1', status: 'pending' });

      const result = await service.prepareCheckoutSubscription('u1', 'plan_2', 'cus_1');

      // Condicional: só se a linha ainda estiver como foi lida.
      expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: 'pending', providerSubscriptionId: null },
        data: { ...fresh, providerCustomerId: 'cus_1' },
      });
      expect(result).toMatchObject({ id: 's1' });
      expect(prisma.subscription.create).not.toHaveBeenCalled();
    });

    it('sem cliente do PSP ainda, não apaga o que a linha já tinha', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'pending',
        providerSubscriptionId: null,
      });
      prisma.subscription.findUniqueOrThrow.mockResolvedValue({ id: 's1', status: 'pending' });

      await service.prepareCheckoutSubscription('u1', 'plan_2', null);

      const [{ data }] = prisma.subscription.updateMany.mock.calls[0];
      expect(data).not.toHaveProperty('providerCustomerId');
    });

    it('reabre a tentativa expirada que nunca foi paga, em vez de criar outra linha', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'expired',
        providerSubscriptionId: null,
      });
      prisma.subscription.findUniqueOrThrow.mockResolvedValue({ id: 's1', status: 'expired' });

      await service.prepareCheckoutSubscription('u1', 'plan_2', 'cus_1');

      expect(prisma.subscription.create).not.toHaveBeenCalled();
      expect(prisma.subscription.update).toHaveBeenLastCalledWith({
        where: { id: 's1', status: 'expired' },
        data: { status: 'pending' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'transition:expired->pending', actor: 'checkout' }),
        prisma,
      );
    });

    it('se a linha mudou desde a leitura (expirada pela varredura, paga), nasce outra', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'pending',
        providerSubscriptionId: null,
      });
      prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
      prisma.subscription.create.mockImplementation(({ data }: any) => ({ id: 's2', ...data }));

      const created = await service.prepareCheckoutSubscription('u1', 'plan_2', 'cus_1');

      expect(created).toMatchObject({ id: 's2', status: 'pending' });
    });

    it.each([
      [
        'expirada que já teve assinatura no PSP',
        { status: 'expired', providerSubscriptionId: 'sub_1' },
      ],
      // O aviso de criação da assinatura chega antes do pagamento.
      [
        'pending já ligada a uma assinatura do PSP',
        { status: 'pending', providerSubscriptionId: 'sub_1' },
      ],
      ['inadimplente', { status: 'past_due', providerSubscriptionId: 'sub_1' }],
      ['cancelada', { status: 'canceled', providerSubscriptionId: 'sub_1' }],
    ])('cria uma linha nova quando a última é %s', async (_label, last) => {
      prisma.subscription.findFirst.mockResolvedValue({ id: 's1', ...last });
      prisma.subscription.create.mockImplementation(({ data }: any) => ({ id: 's2', ...data }));

      const created = await service.prepareCheckoutSubscription('u1', 'plan_2', 'cus_1');

      expect(created).toMatchObject({ id: 's2', status: 'pending', providerCustomerId: 'cus_1' });
      expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    });
  });

  it('attachCheckout grava o checkout e o vencimento dele na assinatura', async () => {
    const expiresAt = new Date('2026-10-13T13:00:00Z');

    await service.attachCheckout('s1', { providerCheckoutId: 'chk_1', expiresAt });

    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { providerCheckoutId: 'chk_1', checkoutExpiresAt: expiresAt },
    });
  });

  describe('expireCheckout', () => {
    it('expira a assinatura pending e audita', async () => {
      prisma.subscription.findUnique.mockResolvedValue({ id: 's1', status: 'pending' });
      prisma.subscription.findUniqueOrThrow.mockResolvedValue({ id: 's1', status: 'pending' });

      const expired = await service.expireCheckout('s1', 'reconciliation', 'checkout vencido');

      expect(expired).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'transition:pending->expired',
          actor: 'reconciliation',
          reason: 'checkout vencido',
        }),
        prisma,
      );
    });

    it.each(['active', 'unpaid', 'expired'])('não mexe em assinatura %s', async (status) => {
      prisma.subscription.findUnique.mockResolvedValue({ id: 's1', status });

      expect(await service.expireCheckout('s1', 'reconciliation', 'x')).toBe(false);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('pagamento chegando entre a leitura e a escrita não é erro: só não expira', async () => {
      prisma.subscription.findUnique.mockResolvedValue({ id: 's1', status: 'pending' });
      prisma.subscription.findUniqueOrThrow.mockResolvedValue({ id: 's1', status: 'pending' });
      prisma.subscription.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('não encontrado', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      expect(await service.expireCheckout('s1', 'reconciliation', 'x')).toBe(false);
    });
  });

  describe('transitionTo', () => {
    const current = (status: SubscriptionStatus) => ({ id: 's1', status });

    it('aplica transição válida, atualiza campos e audita', async () => {
      prisma.subscription.findUniqueOrThrow.mockResolvedValue(current('active'));

      const result = await service.transitionTo('s1', SubscriptionStatus.canceled, {
        actor: 'webhook',
        reason: 'cancel_at_period_end',
        data: { cancelAtPeriodEnd: true },
      });

      // O estado lido entra no `where`: a escrita só vale se ele ainda for esse.
      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 's1', status: 'active' },
        data: { status: 'canceled', cancelAtPeriodEnd: true },
      });
      expect(result.status).toBe('canceled');
      // Uma leitura só: a linha devolvida é a do próprio `update`.
      expect(prisma.subscription.findUniqueOrThrow).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'transition:active->canceled',
          previousStatus: 'active',
          newStatus: 'canceled',
          actor: 'webhook',
        }),
        prisma,
      );
    });

    it('sem transação de quem chama, abre a própria: mudança e auditoria no mesmo commit', async () => {
      prisma.subscription.findUniqueOrThrow.mockResolvedValue(current('active'));

      await service.transitionTo('s1', SubscriptionStatus.past_due, { actor: 'webhook' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('com a transação de quem chama, grava nela e não abre outra', async () => {
      const tx = createPrismaMock();
      tx.subscription.findUniqueOrThrow.mockResolvedValue(current('active'));

      await service.transitionTo('s1', SubscriptionStatus.past_due, { actor: 'webhook' }, tx);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(tx.subscription.update).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(expect.anything(), tx);
    });

    it('rejeita transição inválida sem persistir nem auditar', async () => {
      prisma.subscription.findUniqueOrThrow.mockResolvedValue(current('expired'));

      await expect(
        service.transitionTo('s1', SubscriptionStatus.past_due, { actor: 'webhook' }),
      ).rejects.toBeInstanceOf(InvalidSubscriptionTransitionError);

      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('não grava por cima quando o estado mudou depois da leitura', async () => {
      prisma.subscription.findUniqueOrThrow.mockResolvedValue(current('active'));
      // Outra escrita já tirou a assinatura de `active`: o `where` não casa.
      prisma.subscription.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('não encontrado', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.transitionTo('s1', SubscriptionStatus.past_due, { actor: 'webhook' }),
      ).rejects.toBeInstanceOf(ConcurrentSubscriptionChangeError);

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('os demais erros de escrita sobem como vieram', async () => {
      prisma.subscription.findUniqueOrThrow.mockResolvedValue(current('active'));
      prisma.subscription.update.mockRejectedValue(new Error('banco fora'));

      await expect(
        service.transitionTo('s1', SubscriptionStatus.past_due, { actor: 'webhook' }),
      ).rejects.toThrow('banco fora');
    });
  });
});

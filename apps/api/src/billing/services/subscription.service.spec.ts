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
      create: jest.fn(),
      update: jest.fn(({ data }: any) => ({ id: 's1', ...data })),
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

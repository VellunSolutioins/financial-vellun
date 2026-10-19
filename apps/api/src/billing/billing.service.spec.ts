import { BadRequestException, NotFoundException } from '@nestjs/common';

import { BillingService } from './billing.service';

function setup(env: Record<string, string | undefined> = {}) {
  const provider = {
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_1' }),
    createCheckout: jest.fn().mockResolvedValue({
      checkoutUrl: 'https://asaas/checkout/1',
      providerCheckoutId: 'chk_1',
      expiresAt: new Date('2026-10-13T13:00:00Z'),
    }),
    createPaymentMethodUpdateSession: jest.fn(),
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    plan: { findUnique: jest.fn().mockResolvedValue(PLAN) },
    user: { findUniqueOrThrow: jest.fn().mockResolvedValue(USER) },
    // Pagamento de checkout anterior em análise: nenhum, salvo o teste dizer.
    subscription: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const subscriptions = {
    getActivePlans: jest.fn(),
    prepareCheckoutSubscription: jest.fn().mockResolvedValue({ id: 's_new' }),
    attachCustomer: jest.fn().mockResolvedValue({}),
    attachCheckout: jest.fn().mockResolvedValue({}),
    expireCheckout: jest.fn().mockResolvedValue(true),
    activateFreeSubscription: jest.fn().mockResolvedValue({}),
    scheduleCancellation: jest.fn().mockResolvedValue({}),
  };
  // Regra de acesso real o bastante para o serviço: só `active` e teste válido.
  const access = {
    currentSubscription: jest.fn().mockResolvedValue(null),
    evaluate: jest.fn((sub: { status: string } | null) => ({
      allowed: sub?.status === 'active' || sub?.status === 'trialing',
      reason: 'x',
    })),
  };
  const values: Record<string, string | undefined> = { WEB_URL: 'http://localhost:3000', ...env };
  const config = { get: jest.fn((key: string) => values[key]) };

  const service = new BillingService(
    provider as any,
    prisma as any,
    subscriptions as any,
    access as any,
    config as any,
  );
  return { service, provider, prisma, subscriptions, access };
}

const PLAN = {
  id: 'plan_1',
  code: 'vellun-mensal',
  isActive: true,
  interval: 'monthly',
  price: { toString: () => '49.90' },
  currency: 'BRL',
};

const USER = {
  id: 'u1',
  name: 'Fulano',
  email: 'f@x.com',
  phone: '(41) 99999-9999',
  postalCode: '80240-000',
  street: 'Rua das Flores',
  addressNumber: '123',
  complement: null,
  neighborhood: 'Centro',
  city: 'Curitiba',
  state: 'PR',
  individualProfile: { cpf: '111' },
  businessProfile: null,
};

/** Ordem em que cada dublê foi chamado pela primeira vez. */
const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];

describe('BillingService.createCheckout', () => {
  it('cria cliente e checkout sem ativar a assinatura', async () => {
    const { service, provider, subscriptions } = setup();

    const result = await service.createCheckout('u1', { planId: 'plan_1' });

    expect(provider.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        document: '111',
        postalCode: '80240-000',
        street: 'Rua das Flores',
        addressNumber: '123',
        neighborhood: 'Centro',
      }),
    );
    expect(provider.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ planCode: 'vellun-mensal', providerCustomerId: 'cus_1' }),
    );
    expect(subscriptions.activateFreeSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({ checkoutUrl: 'https://asaas/checkout/1' });
  });

  it('grava a assinatura local antes do PSP, o cliente assim que existe, e o checkout por último', async () => {
    const { service, provider, subscriptions } = setup();

    await service.createCheckout('u1', { planId: 'plan_1' });

    expect(subscriptions.prepareCheckoutSubscription).toHaveBeenCalledWith('u1', 'plan_1', null);
    expect(subscriptions.attachCustomer).toHaveBeenCalledWith('s_new', 'cus_1');
    expect(subscriptions.attachCheckout).toHaveBeenCalledWith('s_new', {
      providerCheckoutId: 'chk_1',
      expiresAt: new Date('2026-10-13T13:00:00Z'),
    });
    // É o id da assinatura local que identifica o checkout no PSP.
    expect(provider.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ externalReference: 's_new' }),
    );

    expect(order(subscriptions.prepareCheckoutSubscription)).toBeLessThan(
      order(provider.createCustomer),
    );
    expect(order(provider.createCustomer)).toBeLessThan(order(subscriptions.attachCustomer));
    expect(order(subscriptions.attachCustomer)).toBeLessThan(order(provider.createCheckout));
    expect(order(provider.createCheckout)).toBeLessThan(order(subscriptions.attachCheckout));
  });

  it('reusa providerCustomerId existente', async () => {
    const { service, provider, subscriptions, access } = setup();
    access.currentSubscription.mockResolvedValue({
      providerCustomerId: 'cus_existing',
      status: 'canceled',
    });

    await service.createCheckout('u1', { planId: 'plan_1' });

    expect(provider.createCustomer).not.toHaveBeenCalled();
    expect(subscriptions.attachCustomer).not.toHaveBeenCalled();
    expect(subscriptions.prepareCheckoutSubscription).toHaveBeenCalledWith(
      'u1',
      'plan_1',
      'cus_existing',
    );
    expect(provider.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerId: 'cus_existing' }),
    );
  });

  it('falha ao abrir o checkout no PSP não deixa a assinatura presa em pending', async () => {
    const { service, provider, subscriptions } = setup();
    provider.createCheckout.mockRejectedValue(new Error('PSP fora'));

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toThrow('PSP fora');

    // O cliente criado antes da falha já ficou gravado: a próxima tentativa o reusa.
    expect(subscriptions.attachCustomer).toHaveBeenCalledWith('s_new', 'cus_1');
    expect(subscriptions.expireCheckout).toHaveBeenCalledWith(
      's_new',
      'checkout',
      expect.any(String),
    );
  });

  it('se nem a expiração puder ser gravada, o erro que sobe é o do PSP', async () => {
    const { service, provider, subscriptions } = setup();
    provider.createCheckout.mockRejectedValue(new Error('PSP fora'));
    subscriptions.expireCheckout.mockRejectedValue(new Error('banco fora'));

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toThrow('PSP fora');
  });

  it('rejeita quando o endereço de cobrança está incompleto, antes de criar qualquer coisa', async () => {
    const { service, provider, prisma, subscriptions } = setup();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      ...USER,
      postalCode: null,
      street: null,
      addressNumber: null,
      neighborhood: null,
    });

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(subscriptions.prepareCheckoutSubscription).not.toHaveBeenCalled();
    expect(provider.createCustomer).not.toHaveBeenCalled();
  });

  it('rejeita quando já há assinatura ativa', async () => {
    const { service, subscriptions, access } = setup();
    access.currentSubscription.mockResolvedValue({ status: 'active' });

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejeita durante o período de teste ainda válido', async () => {
    const { service, subscriptions, access } = setup();
    access.currentSubscription.mockResolvedValue({ status: 'trialing' });

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each(['past_due', 'unpaid', 'pending', 'expired', 'canceled'])(
    'quem está %s pode abrir um checkout novo',
    async (status) => {
      const { service, subscriptions, access } = setup();
      access.currentSubscription.mockResolvedValue({
        status,
        providerCustomerId: 'cus_existing',
      });
      // Inadimplente dentro do grace ainda tem acesso, e mesmo assim pode regularizar.
      access.evaluate.mockReturnValue({ allowed: true, reason: 'grace_period' });

      await expect(service.createCheckout('u1', { planId: 'plan_1' })).resolves.toEqual({
        checkoutUrl: 'https://asaas/checkout/1',
      });
    },
  );

  it('recusa um checkout novo enquanto o pagamento do anterior está em análise no PSP', async () => {
    const { service, provider, prisma, subscriptions } = setup();
    prisma.subscription.findFirst.mockResolvedValue({ id: 's_em_analise' });

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      // Recusado o pagamento, ele não bloqueia mais uma nova tentativa.
      where: {
        userId: 'u1',
        status: 'pending',
        providerSubscriptionId: { not: null },
        lastPaymentFailureAt: null,
      },
      select: { id: true },
    });
    expect(subscriptions.prepareCheckoutSubscription).not.toHaveBeenCalled();
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('rejeita plano inexistente', async () => {
    const { service, prisma } = setup();
    prisma.plan.findUnique.mockResolvedValue(null);

    await expect(service.createCheckout('u1', { planId: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('plano gratuito', () => {
    const FREE = { ...PLAN, price: { toString: () => '0.00' } };

    it('fora de produção ativa direto, sem passar pelo PSP', async () => {
      const { service, provider, prisma, subscriptions } = setup({ NODE_ENV: 'development' });
      prisma.plan.findUnique.mockResolvedValue(FREE);

      const result = await service.createCheckout('u1', { planId: 'plan_1' });

      expect(subscriptions.activateFreeSubscription).toHaveBeenCalled();
      expect(provider.createCheckout).not.toHaveBeenCalled();
      expect(result.checkoutUrl).toContain('status=success');
    });

    it('em produção não existe: responde como plano não encontrado', async () => {
      const { service, prisma, subscriptions } = setup({ NODE_ENV: 'production' });
      prisma.plan.findUnique.mockResolvedValue(FREE);

      await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(subscriptions.activateFreeSubscription).not.toHaveBeenCalled();
    });
  });
});

describe('BillingService.getSubscriptionState', () => {
  it('devolve a última recusa de pagamento, para a tela explicar', async () => {
    const { service, access } = setup();
    const at = new Date('2026-10-19T12:00:00Z');
    access.currentSubscription.mockResolvedValue({
      id: 's1',
      status: 'unpaid',
      plan: PLAN,
      lastPaymentFailureAt: at,
      lastPaymentFailureReason: 'card_refused',
    });

    const state = await service.getSubscriptionState('u1');

    expect(state.lastPaymentFailure).toEqual({ at, reason: 'card_refused' });
  });

  it('sem recusa registrada, é nulo', async () => {
    const { service, access } = setup();
    access.currentSubscription.mockResolvedValue({ id: 's1', status: 'active', plan: PLAN });

    expect((await service.getSubscriptionState('u1')).lastPaymentFailure).toBeNull();
  });
});

describe('BillingService.cancel', () => {
  const current = {
    id: 's1',
    status: 'active',
    providerSubscriptionId: 'sub_1',
    cancelAtPeriodEnd: false,
  };

  it('grava a intenção antes de avisar o PSP', async () => {
    const { service, provider, subscriptions, access } = setup();
    access.currentSubscription.mockResolvedValue(current);

    await service.cancel('u1');

    expect(subscriptions.scheduleCancellation).toHaveBeenCalledWith('s1', 'user');
    expect(provider.cancelSubscription).toHaveBeenCalledWith({
      providerSubscriptionId: 'sub_1',
      cancelAtPeriodEnd: true,
    });
    // O aviso de cancelamento do PSP não pode chegar com a flag ainda falsa.
    expect(order(subscriptions.scheduleCancellation)).toBeLessThan(
      order(provider.cancelSubscription),
    );
  });

  it('se o PSP falha, a intenção fica gravada: o erro não diz se ele cancelou ou não', async () => {
    const { service, provider, subscriptions, access } = setup();
    access.currentSubscription
      .mockResolvedValueOnce(current)
      .mockResolvedValue({ ...current, cancelAtPeriodEnd: true, status: 'active' });
    provider.cancelSubscription.mockRejectedValue(new Error('timeout'));

    // Desfazer aqui faria o aviso de exclusão do PSP, se ele tiver cancelado,
    // derrubar na hora o acesso que o usuário ainda tem pago.
    await expect(service.cancel('u1')).resolves.toMatchObject({ cancelAtPeriodEnd: true });
    expect(subscriptions.scheduleCancellation).toHaveBeenCalledTimes(1);
  });

  it('pedido repetido não regrava a intenção, mas refaz o cancelamento no PSP', async () => {
    const { service, provider, subscriptions, access } = setup();
    access.currentSubscription.mockResolvedValue({ ...current, cancelAtPeriodEnd: true });

    await service.cancel('u1');

    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    // É o que destrava quem ficou com a flag gravada e o PSP sem ter recebido.
    expect(provider.cancelSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ providerSubscriptionId: 'sub_1' }),
    );
  });

  it('assinatura sem vínculo no PSP só agenda aqui', async () => {
    const { service, provider, subscriptions, access } = setup();
    access.currentSubscription.mockResolvedValue({ ...current, providerSubscriptionId: null });

    await service.cancel('u1');

    expect(subscriptions.scheduleCancellation).toHaveBeenCalledWith('s1', 'user');
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  it.each(['pending', 'unpaid', 'expired', 'canceled'])(
    'recusa cancelar o que não está em vigor (%s)',
    async (status) => {
      const { service, provider, subscriptions, access } = setup();
      access.currentSubscription.mockResolvedValue({ ...current, status });

      await expect(service.cancel('u1')).rejects.toBeInstanceOf(BadRequestException);
      // Uma flag gravada numa tentativa `pending` sobreviveria ao pagamento.
      expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
    },
  );

  it('lança quando não há assinatura', async () => {
    const { service } = setup();

    await expect(service.cancel('u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

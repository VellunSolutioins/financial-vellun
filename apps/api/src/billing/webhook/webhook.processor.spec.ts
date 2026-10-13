import { PaymentStatus } from '@prisma/client';

import { ChargeSyncService } from '../services/charge-sync.service';
import { SubscriptionStateService } from '../services/subscription-state.service';
import { WebhookProcessor } from './webhook.processor';

/** "Agora" dos testes: 12/10/2026, meio-dia em Brasília. */
const NOW = new Date('2026-10-12T15:00:00Z');
/** Vencimento de hoje, ancorado ao meio-dia UTC como o adapter faz. */
const DUE_TODAY = new Date('2026-10-12T12:00:00Z');

function setup() {
  const provider = {
    normalizeWebhookEvent: jest.fn(),
    getPayment: jest.fn(),
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    paymentWebhookEvent: { findUniqueOrThrow: jest.fn() },
    subscription: { findFirst: jest.fn() },
  };
  const events = {
    // `markProcessing` devolve se reivindicou: `false` significa que outro
    // processo levou o evento, e o processamento para aí.
    markProcessing: jest.fn().mockResolvedValue(true),
    markProcessed: jest.fn().mockResolvedValue({}),
    markFailed: jest.fn().mockResolvedValue({}),
    linkSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const subscriptions = { transitionTo: jest.fn().mockResolvedValue({}) };
  const payments = {
    // Sem registro local da cobrança, e nenhuma mais nova, salvo o teste dizer.
    findByProviderId: jest.fn().mockResolvedValue(null),
    hasNewerDecisiveCharge: jest.fn().mockResolvedValue(false),
    hasOpenChargeback: jest.fn().mockResolvedValue(false),
    upsertFromProvider: jest.fn().mockResolvedValue({}),
  };
  const state = new SubscriptionStateService();

  // Serviço de sincronização real: as regras de efeito da cobrança são o que
  // estes testes existem para proteger.
  const charges = new ChargeSyncService(
    provider as any,
    subscriptions as any,
    state,
    payments as any,
  );
  const processor = new WebhookProcessor(
    provider as any,
    prisma as any,
    events as any,
    subscriptions as any,
    state,
    charges,
  );
  return { processor, provider, prisma, events, subscriptions, payments };
}

function persistedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row_1',
    providerEventId: 'evt_1',
    eventType: 'PAYMENT_RECEIVED',
    status: 'received',
    sanitizedPayload: {},
    ...overrides,
  };
}

const subscription = {
  id: 's1',
  userId: 'u1',
  status: 'pending',
  providerSubscriptionId: null,
  providerCustomerId: 'cus_a',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  plan: { interval: 'monthly' },
};

/** Evento normalizado de cobrança: o processador só usa o id da cobrança. */
function chargeEvent(intent: string, providerPaymentId = 'pay_1') {
  return {
    intent,
    providerSubscriptionId: 'sub_a',
    providerCustomerId: 'cus_a',
    payment: {
      providerPaymentId,
      status: 'paid',
      amount: '49.90',
      currency: 'BRL',
      dueAt: null,
      paidAt: null,
    },
  };
}

/** Cobrança como o PSP a devolve na consulta. */
function remoteCharge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_1',
    status: 'paid',
    amount: '49.90',
    currency: 'BRL',
    dueAt: DUE_TODAY,
    paidAt: DUE_TODAY,
    providerSubscriptionId: 'sub_a',
    providerCustomerId: 'cus_a',
    providerCheckoutId: null,
    ...overrides,
  };
}

/** Arma evento, assinatura local e cobrança remota de um cenário. */
function arrange(
  ctx: ReturnType<typeof setup>,
  scenario: {
    intent: string;
    local?: Record<string, unknown>;
    remote?: Record<string, unknown>;
  },
) {
  const charge = remoteCharge(scenario.remote);
  ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
  ctx.provider.normalizeWebhookEvent.mockReturnValue(chargeEvent(scenario.intent, charge.id));
  ctx.provider.getPayment.mockResolvedValue(charge);
  ctx.prisma.subscription.findFirst.mockResolvedValue({ ...subscription, ...scenario.local });
}

describe('WebhookProcessor.process', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  it('pagamento aprovado consulta a cobrança no PSP e ativa com o período ancorado no vencimento', async () => {
    const ctx = setup();
    arrange(ctx, { intent: 'payment_succeeded' });

    await ctx.processor.process('row_1');

    expect(ctx.provider.getPayment).toHaveBeenCalledWith('pay_1');
    expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'active',
      expect.objectContaining({
        actor: 'webhook:payment_succeeded',
        data: {
          providerSubscriptionId: 'sub_a',
          currentPeriodStart: DUE_TODAY,
          currentPeriodEnd: new Date('2026-11-12T12:00:00Z'),
          graceUntil: null,
        },
      }),
    );
    expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerPaymentId: 'pay_1', status: PaymentStatus.paid }),
    );
    expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
  });

  it('registra a cobrança depois de aplicar o efeito, para um retry não achá-la "já tratada"', async () => {
    const ctx = setup();
    arrange(ctx, { intent: 'payment_succeeded' });

    await ctx.processor.process('row_1');

    const transition = ctx.subscriptions.transitionTo.mock.invocationCallOrder[0];
    const upsert = ctx.payments.upsertFromProvider.mock.invocationCallOrder[0];
    expect(transition).toBeLessThan(upsert);
  });

  it('é idempotente: não reprocessa evento já processado', async () => {
    const { processor, prisma, events, subscriptions } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(
      persistedEvent({ status: 'processed' }),
    );

    await processor.process('row_1');

    expect(events.markProcessing).not.toHaveBeenCalled();
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  describe('aviso de crédito (PAYMENT_RECEIVED) depois do pagamento já confirmado', () => {
    /** Cobrança de 15/08, paga no dia e creditada ~32 dias depois. */
    const settled = {
      dueAt: new Date('2026-08-15T12:00:00Z'),
      paidAt: new Date('2026-08-15T12:00:00Z'),
    };

    it('não transiciona quando a cobrança já estava registrada como paga', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', local: { status: 'active' } });
      ctx.payments.findByProviderId.mockResolvedValue({ status: 'paid', paidAt: DUE_TODAY });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it('não reativa assinatura inadimplente', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', local: { status: 'past_due' }, remote: settled });
      ctx.payments.findByProviderId.mockResolvedValue({ status: 'paid', paidAt: settled.paidAt });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('não reativa nem quando o pagamento original nunca foi registrado: o período dele já acabou', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', local: { status: 'past_due' }, remote: settled });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentStatus.paid }),
      );
    });

    it('não reativa assinatura cancelada', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', local: { status: 'canceled' }, remote: settled });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
    });
  });

  it('payload diz pago mas o PSP diz pendente: não ativa', async () => {
    const ctx = setup();
    arrange(ctx, { intent: 'payment_succeeded', remote: { status: 'pending', paidAt: null } });

    await ctx.processor.process('row_1');

    expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
    expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.pending, paidAt: null }),
    );
  });

  describe('correlação com a assinatura local', () => {
    it('usa os vínculos da cobrança no PSP, não os do payload', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_succeeded',
        remote: { providerSubscriptionId: 'sub_real', providerCustomerId: 'cus_real' },
      });

      await ctx.processor.process('row_1');

      expect(ctx.prisma.subscription.findFirst).toHaveBeenCalledTimes(1);
      expect(ctx.prisma.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { providerSubscriptionId: 'sub_real' } }),
      );
    });

    it('primeira cobrança de um checkout: casa pelo cliente só com linha ainda sem vínculo', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });
      ctx.prisma.subscription.findFirst
        .mockReset()
        .mockResolvedValueOnce(null) // nenhuma linha com sub_a
        .mockResolvedValueOnce({ ...subscription });

      await ctx.processor.process('row_1');

      expect(ctx.prisma.subscription.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            providerCustomerId: 'cus_a',
            providerSubscriptionId: null,
          }),
        }),
      );
      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'active',
        expect.objectContaining({
          data: expect.objectContaining({ providerSubscriptionId: 'sub_a' }),
        }),
      );
    });

    it('estorno de cobrança de outra assinatura do mesmo cliente não toca na assinatura válida', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_refunded',
        remote: { status: 'refunded', providerSubscriptionId: 'sub_duplicada' },
      });
      // A linha do cliente já está vinculada a outra assinatura do PSP: nem a
      // busca pela assinatura nem a busca por linha sem vínculo a devolvem.
      ctx.prisma.subscription.findFirst.mockReset().mockResolvedValue(null);

      await ctx.processor.process('row_1');

      expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.payments.upsertFromProvider).not.toHaveBeenCalled();
    });

    it('cobrança avulsa do cliente não é de nenhuma assinatura', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_refunded',
        remote: { status: 'refunded', providerSubscriptionId: null },
      });

      await ctx.processor.process('row_1');

      expect(ctx.prisma.subscription.findFirst).not.toHaveBeenCalled();
      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });
  });

  it('não regrava a cobrança quando ela já está registrada igual', async () => {
    const ctx = setup();
    arrange(ctx, { intent: 'payment_succeeded', local: { status: 'active' } });
    ctx.payments.findByProviderId.mockResolvedValue({
      status: 'paid',
      subscriptionId: 's1',
      amount: '49.90',
      dueAt: DUE_TODAY,
      paidAt: DUE_TODAY,
      failedAt: null,
    });

    await ctx.processor.process('row_1');

    expect(ctx.payments.upsertFromProvider).not.toHaveBeenCalled();
  });

  it.each(['paid', 'failed'])(
    'cobrança antiga (%s) não mexe na assinatura quando há outra mais nova decidida',
    async (status) => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_succeeded',
        local: { status: 'active' },
        remote: { status },
      });
      ctx.payments.hasNewerDecisiveCharge.mockResolvedValue(true);

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.payments.upsertFromProvider).toHaveBeenCalled();
    },
  );

  it('cobrança vencida em assinatura pending vai para unpaid (sem grace/acesso)', async () => {
    const ctx = setup();
    arrange(ctx, { intent: 'payment_failed', remote: { status: 'failed', paidAt: null } });

    await ctx.processor.process('row_1');

    expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'unpaid',
      expect.objectContaining({ actor: 'webhook:payment_failed' }),
    );
  });

  it('falha de renovação (active) vai para past_due com grace contado do vencimento', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_failed',
      local: { status: 'active' },
      remote: { status: 'failed', paidAt: null, dueAt: new Date('2026-10-11T12:00:00Z') },
    });

    await ctx.processor.process('row_1');

    expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'past_due',
      expect.objectContaining({
        data: { providerSubscriptionId: 'sub_a', graceUntil: new Date('2026-10-14T12:00:00Z') },
      }),
    );
  });

  it('nova cobrança vencida não dá outro grace a quem já está inadimplente', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_failed',
      local: { status: 'past_due' },
      remote: { status: 'failed', paidAt: null },
    });

    await ctx.processor.process('row_1');

    expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('evento de vencimento atrasado encontra a cobrança paga no PSP e não rebaixa', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_failed',
      local: { status: 'active', currentPeriodEnd: new Date('2026-11-12T12:00:00Z') },
    });
    ctx.payments.findByProviderId.mockResolvedValue({ status: 'paid', paidAt: DUE_TODAY });

    await ctx.processor.process('row_1');

    expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('intent ignore não toca na assinatura', async () => {
    const { processor, provider, prisma, subscriptions, events } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'ignore',
      providerSubscriptionId: null,
      providerCustomerId: null,
      payment: null,
    });

    await processor.process('row_1');

    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(provider.getPayment).not.toHaveBeenCalled();
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    expect(events.markProcessed).toHaveBeenCalledWith('row_1');
  });

  it('chargeback revoga acesso (active → unpaid) e registra pagamento', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_chargeback',
      local: { status: 'active' },
      remote: { id: 'pay_3', status: 'chargeback' },
    });

    await ctx.processor.process('row_1');

    expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerPaymentId: 'pay_3', status: PaymentStatus.chargeback }),
    );
    expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'unpaid',
      expect.objectContaining({ actor: 'webhook:payment_chargeback' }),
    );
  });

  it('estorno integral para de cobrar no PSP e depois revoga o acesso', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_refunded',
      local: { status: 'active', providerSubscriptionId: 'sub_a' },
      remote: { id: 'pay_4', status: 'refunded' },
    });

    await ctx.processor.process('row_1');

    expect(ctx.provider.cancelSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ providerSubscriptionId: 'sub_a' }),
    );
    expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'canceled',
      expect.objectContaining({
        actor: 'webhook:payment_refunded',
        data: { providerSubscriptionId: 'sub_a', canceledAt: NOW },
      }),
    );
    expect(ctx.provider.cancelSubscription.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.subscriptions.transitionTo.mock.invocationCallOrder[0],
    );
    expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerPaymentId: 'pay_4', status: PaymentStatus.refunded }),
    );
  });

  it('estorno parcial só registra o pagamento', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_refunded',
      local: { status: 'active', providerSubscriptionId: 'sub_a' },
      remote: { status: 'partially_refunded' },
    });

    await ctx.processor.process('row_1');

    expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.partially_refunded }),
    );
    expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
    expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('estorno da primeira cobrança, com a linha ainda sem vínculo, cancela a assinatura da cobrança no PSP', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_refunded',
      local: { status: 'pending', providerSubscriptionId: null },
      remote: { status: 'refunded', providerSubscriptionId: 'sub_a' },
    });

    await ctx.processor.process('row_1');

    expect(ctx.provider.cancelSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ providerSubscriptionId: 'sub_a' }),
    );
    expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'canceled',
      expect.objectContaining({
        data: expect.objectContaining({ providerSubscriptionId: 'sub_a' }),
      }),
    );
  });

  it('estorno ainda em andamento (processing) não cancela nada', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_refunded',
      local: { status: 'active', providerSubscriptionId: 'sub_a' },
      remote: { status: 'processing' },
    });

    await ctx.processor.process('row_1');

    expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
    expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  describe('chargeback', () => {
    it('de cobrança antiga revoga o acesso mesmo com a cobrança seguinte paga', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_chargeback',
        local: { status: 'active' },
        remote: { status: 'chargeback', dueAt: new Date('2026-09-12T12:00:00Z') },
      });
      ctx.payments.findByProviderId.mockResolvedValue({ status: 'paid' });
      ctx.payments.hasNewerDecisiveCharge.mockResolvedValue(true);

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'unpaid',
        expect.objectContaining({ actor: 'webhook:payment_chargeback' }),
      );
    });

    it('pagamento novo não devolve o acesso enquanto outra cobrança está em disputa', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', local: { status: 'unpaid' } });
      ctx.payments.hasOpenChargeback.mockResolvedValue(true);

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentStatus.paid }),
      );
    });
  });

  it('cancelamento no PSP transiciona para canceled', async () => {
    const { processor, provider, prisma, subscriptions } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'subscription_canceled',
      providerSubscriptionId: 'sub_a',
      providerCustomerId: 'cus_a',
      payment: null,
    });
    prisma.subscription.findFirst.mockResolvedValue({ ...subscription, status: 'active' });

    await processor.process('row_1');

    expect(subscriptions.transitionTo).toHaveBeenCalledWith('s1', 'canceled', expect.anything());
  });

  it('cancelamento agendado dentro do período pago preserva o acesso (não cancela)', async () => {
    const { processor, provider, prisma, subscriptions } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'subscription_canceled',
      providerSubscriptionId: 'sub_a',
      providerCustomerId: 'cus_a',
      payment: null,
    });
    prisma.subscription.findFirst.mockResolvedValue({
      ...subscription,
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000), // amanhã
    });

    await processor.process('row_1');

    // Acesso preservado: nenhuma transição para canceled enquanto dentro do período.
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('indisponibilidade do PSP na consulta da cobrança propaga erro (reprocessável)', async () => {
    const ctx = setup();
    arrange(ctx, { intent: 'payment_succeeded' });
    ctx.provider.getPayment.mockRejectedValue(new Error('PSP indisponível'));

    await expect(ctx.processor.process('row_1')).rejects.toThrow('PSP indisponível');
    expect(ctx.events.markProcessed).not.toHaveBeenCalled();
  });

  it('cancelamento de assinatura do PSP ainda sem vínculo local casa pelo cliente', async () => {
    const { processor, provider, prisma, subscriptions } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'subscription_canceled',
      providerSubscriptionId: 'sub_nova',
      providerCustomerId: 'cus_a',
      payment: null,
    });
    prisma.subscription.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...subscription, status: 'pending' });

    await processor.process('row_1');

    expect(prisma.subscription.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerCustomerId: 'cus_a',
          providerSubscriptionId: null,
        }),
      }),
    );
    expect(subscriptions.transitionTo).toHaveBeenCalledWith('s1', 'canceled', expect.anything());
  });

  it('cancelamento de outra assinatura do mesmo cliente não cancela a assinatura válida', async () => {
    const { processor, provider, prisma, subscriptions, events } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'subscription_canceled',
      providerSubscriptionId: 'sub_duplicada',
      providerCustomerId: 'cus_a',
      payment: null,
    });
    prisma.subscription.findFirst.mockResolvedValue(null);

    await processor.process('row_1');

    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    expect(events.markProcessed).toHaveBeenCalledWith('row_1');
  });
});

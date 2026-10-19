import { Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

import { UncorrelatedPaymentEventError } from '../billing.errors';
import { ChargeSyncService } from '../services/charge-sync.service';
import { SubscriptionStateService } from '../services/subscription-state.service';
import { WebhookProcessor } from './webhook.processor';

/** "Agora" dos testes: 12/10/2026, meio-dia em Brasília. */
const NOW = new Date('2026-10-12T15:00:00Z');
/** Quando o aviso chegou: anterior ao processamento, que pode ser um retry. */
const RECEIVED_AT = new Date('2026-10-12T14:40:00Z');
/** Vencimento de hoje, ancorado ao meio-dia UTC como o adapter faz. */
const DUE_TODAY = new Date('2026-10-12T12:00:00Z');

function setup() {
  const provider = {
    name: 'asaas',
    normalizeWebhookEvent: jest.fn(),
    getPayment: jest.fn(),
    // Consultada na primeira ativação, para saber o ciclo contratado.
    getSubscription: jest.fn().mockResolvedValue({ interval: 'monthly' }),
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const prisma: any = {
    paymentWebhookEvent: { findUniqueOrThrow: jest.fn() },
    subscription: { findFirst: jest.fn() },
    plan: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // Cliente da transação do evento. Por padrão, a releitura sob a trava devolve a
  // mesma linha que a correlação achou; o teste troca quando quer simular uma
  // mudança feita por outro evento nesse meio-tempo.
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    subscription: {
      findUniqueOrThrow: jest.fn(async () => {
        const located = await Promise.all(
          prisma.subscription.findFirst.mock.results.map((result: any) => result.value),
        );
        return located.filter(Boolean).pop();
      }),
      findUnique: jest.fn(async () => {
        const located = await Promise.all(
          prisma.subscription.findFirst.mock.results.map((result: any) => result.value),
        );
        return located.filter(Boolean).pop();
      }),
      update: jest.fn().mockResolvedValue({}),
      // Assinaturas anteriores do usuário ainda abertas: nenhuma, salvo o teste dizer.
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    plan: { findMany: jest.fn().mockResolvedValue([]) },
  };
  prisma.$transaction = jest.fn(async (work: (client: typeof tx) => unknown) => work(tx));

  // Cliente de banco usado em cada escrita, na ordem: o que interessa é se foi `tx`.
  const writes: unknown[] = [];
  const spies = {
    transitionTo: jest.fn().mockResolvedValue({}),
    upsertFromProvider: jest.fn().mockResolvedValue({}),
    markProcessed: jest.fn().mockResolvedValue({}),
    expireCheckout: jest.fn().mockResolvedValue(true),
    /** Assinatura a que o evento foi ligado ao ser fechado. */
    linkedTo: jest.fn(),
  };

  const events = {
    // `markProcessing` devolve se reivindicou: `false` significa que outro
    // processo levou o evento, e o processamento para aí.
    markProcessing: jest.fn().mockResolvedValue(true),
    markFailed: jest.fn().mockResolvedValue({}),
    markUnprocessable: jest.fn().mockResolvedValue({}),
    observeProcessed: jest.fn(),
    markProcessed: (id: string, subscriptionId: string | null, db: unknown) => {
      writes.push(db);
      spies.linkedTo(subscriptionId);
      return spies.markProcessed(id);
    },
  };
  const subscriptions = {
    transitionTo: (id: string, to: string, input: unknown, db: unknown) => {
      writes.push(db);
      return spies.transitionTo(id, to, input);
    },
    expireCheckout: (id: string, actor: string, _reason: string, db: unknown) => {
      writes.push(db);
      return spies.expireCheckout(id, actor);
    },
  };
  const payments = {
    // Sem registro local da cobrança, e nenhuma mais nova, salvo o teste dizer.
    findByProviderId: jest.fn().mockResolvedValue(null),
    hasNewerDecisiveCharge: jest.fn().mockResolvedValue(false),
    hasOpenChargeback: jest.fn().mockResolvedValue(false),
    upsertFromProvider: (record: unknown, db: unknown) => {
      writes.push(db);
      return spies.upsertFromProvider(record);
    },
  };
  const state = new SubscriptionStateService();

  // Serviço de sincronização real: as regras de efeito da cobrança são o que
  // estes testes existem para proteger.
  const charges = new ChargeSyncService(
    provider as any,
    prisma,
    subscriptions as any,
    state,
    payments as any,
  );
  const processor = new WebhookProcessor(
    provider as any,
    prisma,
    events as any,
    subscriptions as any,
    state,
    charges,
  );
  return {
    processor,
    provider,
    prisma,
    tx,
    writes,
    events: { ...events, markProcessed: spies.markProcessed, linkedTo: spies.linkedTo },
    subscriptions: { transitionTo: spies.transitionTo, expireCheckout: spies.expireCheckout },
    payments: { ...payments, upsertFromProvider: spies.upsertFromProvider },
  };
}

function persistedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row_1',
    providerEventId: 'evt_1',
    eventType: 'PAYMENT_RECEIVED',
    status: 'received',
    provider: 'asaas',
    sanitizedPayload: {},
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

const subscription = {
  id: 's1',
  userId: 'u1',
  status: 'pending',
  providerSubscriptionId: null,
  providerCustomerId: 'cus_a',
  providerCheckoutId: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  createdAt: new Date('2026-10-12T14:00:00Z'),
  planId: 'plan_m',
  plan: { id: 'plan_m', code: 'vellun-mensal', interval: 'monthly', price: '49.90' },
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
          lastPaymentFailureAt: null,
          lastPaymentFailureReason: null,
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

  describe('uma transação por evento', () => {
    it('assinatura, cobrança e fechamento do evento vão no mesmo commit, com a assinatura travada', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });

      await ctx.processor.process('row_1');

      expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
      // Transição, cobrança e `processed`: as três escritas pelo cliente da transação.
      expect(ctx.writes).toEqual([ctx.tx, ctx.tx, ctx.tx]);
      expect(ctx.events.linkedTo).toHaveBeenCalledWith('s1');
      expect(ctx.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.subscriptions.transitionTo.mock.invocationCallOrder[0],
      );
    });

    it('consulta o PSP antes de abrir a transação', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });

      await ctx.processor.process('row_1');

      expect(ctx.provider.getPayment.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.prisma.$transaction.mock.invocationCallOrder[0],
      );
    });

    it('falha ao gravar o efeito não fecha o evento', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });
      ctx.subscriptions.transitionTo.mockRejectedValue(new Error('auditoria falhou'));

      await expect(ctx.processor.process('row_1')).rejects.toThrow('auditoria falhou');

      expect(ctx.events.markProcessed).not.toHaveBeenCalled();
      expect(ctx.payments.upsertFromProvider).not.toHaveBeenCalled();
    });

    it('conta o evento processado só depois do commit', async () => {
      const ok = setup();
      arrange(ok, { intent: 'payment_succeeded' });
      await ok.processor.process('row_1');
      expect(ok.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        ok.events.observeProcessed.mock.invocationCallOrder[0],
      );

      const falhou = setup();
      arrange(falhou, { intent: 'payment_succeeded' });
      falhou.prisma.$transaction.mockRejectedValue(new Error('commit falhou'));
      await expect(falhou.processor.process('row_1')).rejects.toThrow('commit falhou');
      expect(falhou.events.observeProcessed).not.toHaveBeenCalled();
    });

    it('decide com o estado relido sob a trava, não com o lido antes de esperar a vez', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_failed',
        local: { status: 'active' },
        remote: { status: 'failed', paidAt: null },
      });
      // Outro evento da mesma assinatura já a levou a `past_due` enquanto este
      // esperava a trava: não há novo grace a dar.
      ctx.tx.subscription.findUniqueOrThrow.mockResolvedValue({
        ...subscription,
        status: 'past_due',
      });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it('estorno é decidido sob a trava: se lá a cobrança já foi superada, o PSP não é tocado', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_refunded',
        local: { status: 'active', providerSubscriptionId: 'sub_a' },
        remote: { status: 'refunded' },
      });
      // Uma cobrança mais nova foi paga e registrada enquanto este evento
      // esperava a vez: o estorno da antiga não cancela mais nada.
      ctx.payments.hasNewerDecisiveCharge.mockResolvedValue(true);

      await ctx.processor.process('row_1');

      expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it('evento ignorado fecha sem efeitos e sem ligar a assinatura', async () => {
      const ctx = setup();
      ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
      ctx.provider.normalizeWebhookEvent.mockReturnValue({
        intent: 'ignore',
        providerSubscriptionId: null,
        providerCustomerId: null,
        payment: null,
      });

      await ctx.processor.process('row_1');

      expect(ctx.writes).toEqual([ctx.tx]);
      expect(ctx.events.linkedTo).toHaveBeenCalledWith(null);
      expect(ctx.events.observeProcessed).toHaveBeenCalledTimes(1);
    });

    it('cancelamento também é decidido sob a trava', async () => {
      const ctx = setup();
      ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
      ctx.provider.normalizeWebhookEvent.mockReturnValue({
        intent: 'subscription_canceled',
        providerSubscriptionId: 'sub_a',
        providerCustomerId: 'cus_a',
        payment: null,
      });
      ctx.prisma.subscription.findFirst.mockResolvedValue({ ...subscription, status: 'active' });
      // Enquanto esperava a trava, a assinatura já foi cancelada por outro caminho.
      ctx.tx.subscription.findUniqueOrThrow.mockResolvedValue({
        ...subscription,
        status: 'canceled',
      });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });
  });

  describe('correlação pelo checkout', () => {
    it('acha pela linha do checkout quando a assinatura do PSP ainda é desconhecida aqui', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', remote: { providerCheckoutId: 'chk_1' } });
      ctx.prisma.subscription.findFirst
        .mockReset()
        .mockResolvedValueOnce(null) // nenhuma linha com sub_a
        .mockResolvedValueOnce({ ...subscription, providerCheckoutId: 'chk_1' });

      await ctx.processor.process('row_1');

      expect(ctx.prisma.subscription.findFirst).toHaveBeenCalledTimes(2);
      expect(ctx.prisma.subscription.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { provider: 'asaas', providerCheckoutId: 'chk_1', providerSubscriptionId: null },
        }),
      );
      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'active',
        expect.anything(),
      );
    });

    it('checkout vencido expira a tentativa pending que ele abriu', async () => {
      const ctx = setup();
      ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
      ctx.provider.normalizeWebhookEvent.mockReturnValue({
        intent: 'checkout_expired',
        providerSubscriptionId: null,
        providerCustomerId: 'cus_a',
        providerCheckoutId: 'chk_1',
        payment: null,
      });
      ctx.prisma.subscription.findFirst.mockResolvedValue({
        ...subscription,
        providerCheckoutId: 'chk_1',
      });

      await ctx.processor.process('row_1');

      expect(ctx.prisma.subscription.findFirst).toHaveBeenCalledWith({
        where: { provider: 'asaas', providerCheckoutId: 'chk_1' },
      });
      expect(ctx.subscriptions.expireCheckout).toHaveBeenCalledWith(
        's1',
        'webhook:checkout_expired',
      );
      // Expiração e fechamento do evento no mesmo commit, com a assinatura travada.
      expect(ctx.writes).toEqual([ctx.tx, ctx.tx]);
      expect(ctx.tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(ctx.events.linkedTo).toHaveBeenCalledWith('s1');
    });

    it('aviso atrasado de um checkout que a linha já trocou por outro não expira a tentativa nova', async () => {
      const ctx = setup();
      ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
      ctx.provider.normalizeWebhookEvent.mockReturnValue({
        intent: 'checkout_expired',
        providerSubscriptionId: null,
        providerCustomerId: 'cus_a',
        providerCheckoutId: 'chk_1',
        payment: null,
      });
      ctx.prisma.subscription.findFirst.mockResolvedValue({
        ...subscription,
        providerCheckoutId: 'chk_1',
      });
      // Sob a trava, a linha já foi reaberta para outro checkout.
      ctx.tx.subscription.findUnique.mockResolvedValue({
        ...subscription,
        providerCheckoutId: null,
      });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.expireCheckout).not.toHaveBeenCalled();
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it('checkout vencido que não é de nenhuma assinatura só fecha o evento', async () => {
      const ctx = setup();
      ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
      ctx.provider.normalizeWebhookEvent.mockReturnValue({
        intent: 'checkout_expired',
        providerSubscriptionId: null,
        providerCustomerId: null,
        providerCheckoutId: 'chk_alheio',
        payment: null,
      });
      ctx.prisma.subscription.findFirst.mockResolvedValue(null);

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.expireCheckout).not.toHaveBeenCalled();
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    describe('assinatura criada no PSP', () => {
      /** O payload aponta para uma assinatura; o que vale é o que o PSP diz dela. */
      function arrangeCreated(ctx: ReturnType<typeof setup>, remote: Record<string, unknown>) {
        ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
        ctx.provider.normalizeWebhookEvent.mockReturnValue({
          intent: 'subscription_created',
          providerSubscriptionId: 'sub_nova',
          providerCustomerId: 'cus_do_payload',
          providerCheckoutId: 'chk_do_payload',
          payment: null,
        });
        ctx.provider.getSubscription.mockResolvedValue({
          id: 'sub_nova',
          status: 'active',
          providerCustomerId: 'cus_a',
          providerCheckoutId: 'chk_1',
          ...remote,
        });
        ctx.prisma.subscription.findFirst.mockResolvedValue({ ...subscription });
      }

      it('grava o vínculo na linha do checkout, sem conceder acesso', async () => {
        const ctx = setup();
        arrangeCreated(ctx, {});

        await ctx.processor.process('row_1');

        // Checkout e cliente vêm da consulta ao PSP, não do payload.
        expect(ctx.provider.getSubscription).toHaveBeenCalledWith('sub_nova');
        expect(ctx.prisma.subscription.findFirst).toHaveBeenCalledWith({
          where: { provider: 'asaas', providerCheckoutId: 'chk_1' },
        });
        // Só preenche o que está vazio: reentrega não sobrescreve.
        expect(ctx.tx.subscription.updateMany).toHaveBeenCalledWith({
          where: { id: 's1', providerSubscriptionId: null },
          data: { providerSubscriptionId: 'sub_nova' },
        });
        expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
        expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
      });

      it('recusa o vínculo quando a assinatura do PSP é de outro cliente', async () => {
        const ctx = setup();
        arrangeCreated(ctx, { providerCustomerId: 'cus_outro' });

        await ctx.processor.process('row_1');

        expect(ctx.tx.subscription.updateMany).not.toHaveBeenCalled();
        expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
      });

      it('assinatura que o PSP não liga a nenhum checkout nosso é só fechada', async () => {
        const ctx = setup();
        arrangeCreated(ctx, { providerCheckoutId: null });

        await ctx.processor.process('row_1');

        expect(ctx.prisma.subscription.findFirst).not.toHaveBeenCalled();
        expect(ctx.tx.subscription.updateMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('valor pago x plano, na primeira ativação', () => {
    const ANUAL = { id: 'plan_a', code: 'vellun-anual', interval: 'annual', price: '499.00' };

    it('pagou o valor de outro plano: a assinatura passa a ser desse plano, com o ciclo dele', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', remote: { amount: '499.00' } });
      ctx.provider.getSubscription.mockResolvedValue({ interval: 'annual' });
      ctx.tx.plan.findMany.mockResolvedValue([ANUAL]);

      await ctx.processor.process('row_1');

      expect(ctx.provider.getSubscription).toHaveBeenCalledWith('sub_a');
      // Preço e ciclo juntos: só o preço pode coincidir com o de outro produto.
      expect(ctx.tx.plan.findMany).toHaveBeenCalledWith({
        where: { isActive: true, price: '499.00', interval: 'annual' },
      });
      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'active',
        expect.objectContaining({
          reason: expect.stringContaining('vellun-anual'),
          data: expect.objectContaining({
            plan: { connect: { id: 'plan_a' } },
            currentPeriodEnd: new Date('2027-10-12T12:00:00Z'),
          }),
        }),
      );
    });

    it('sem o ciclo da assinatura do PSP, não troca o plano', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', remote: { amount: '499.00' } });
      ctx.provider.getSubscription.mockResolvedValue({ interval: null });
      ctx.tx.plan.findMany.mockResolvedValue([ANUAL]);

      await ctx.processor.process('row_1');

      expect(ctx.tx.plan.findMany).not.toHaveBeenCalled();
      const [, , input] = ctx.subscriptions.transitionTo.mock.calls[0];
      expect(input.data).not.toHaveProperty('plan');
    });

    it('sem um plano ativo com aquele valor, ativa com o plano da assinatura', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded', remote: { amount: '39.90' } });

      await ctx.processor.process('row_1');

      const [, , input] = ctx.subscriptions.transitionTo.mock.calls[0];
      expect(input.data).not.toHaveProperty('plan');
      expect(input.data.currentPeriodEnd).toEqual(new Date('2026-11-12T12:00:00Z'));
    });

    it('renovação com valor diferente não mexe no plano (o preço pode ter mudado para novos)', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_succeeded',
        local: {
          status: 'active',
          providerSubscriptionId: 'sub_a',
          currentPeriodStart: new Date('2026-09-12T12:00:00Z'),
          currentPeriodEnd: new Date('2026-10-12T12:00:00Z'),
        },
        remote: { amount: '39.90' },
      });

      await ctx.processor.process('row_1');

      expect(ctx.tx.plan.findMany).not.toHaveBeenCalled();
      // Renovação: nem consulta o ciclo no PSP.
      expect(ctx.provider.getSubscription).not.toHaveBeenCalled();
      const [, , input] = ctx.subscriptions.transitionTo.mock.calls[0];
      expect(input.data).not.toHaveProperty('plan');
    });
  });

  describe('assinaturas anteriores do mesmo usuário (regularização por novo checkout)', () => {
    const OLD = { id: 's_old', provider: 'asaas', providerSubscriptionId: 'sub_old' };
    const order = (mock: jest.Mock, call = 0) => mock.mock.invocationCallOrder[call];

    it('ao ativar a nova, cancela a antiga no PSP e só depois a fecha aqui', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });
      ctx.tx.subscription.findMany.mockResolvedValue([OLD]);

      await ctx.processor.process('row_1');

      expect(ctx.provider.cancelSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ providerSubscriptionId: 'sub_old' }),
      );
      expect(ctx.subscriptions.transitionTo).toHaveBeenLastCalledWith(
        's_old',
        'canceled',
        expect.objectContaining({ actor: 'webhook:superseded' }),
      );
      // nova ativada → antiga cancelada no PSP → antiga fechada aqui → evento fechado
      expect(order(ctx.subscriptions.transitionTo, 0)).toBeLessThan(
        order(ctx.provider.cancelSubscription),
      );
      expect(order(ctx.provider.cancelSubscription)).toBeLessThan(
        order(ctx.subscriptions.transitionTo, 1),
      );
      expect(order(ctx.subscriptions.transitionTo, 1)).toBeLessThan(
        order(ctx.events.markProcessed),
      );
    });

    it('só olha para as criadas antes desta e ainda abertas, com assinatura no PSP', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });

      await ctx.processor.process('row_1');

      expect(ctx.tx.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'u1',
            id: { not: 's1' },
            createdAt: { lt: subscription.createdAt },
            providerSubscriptionId: { not: null },
            status: { notIn: ['canceled', 'expired'] },
          },
        }),
      );
    });

    it('se o PSP falha, o evento fica aberto e a antiga continua aberta aqui', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });
      ctx.tx.subscription.findMany.mockResolvedValue([OLD]);
      ctx.provider.cancelSubscription.mockRejectedValue(new Error('PSP fora'));

      await expect(ctx.processor.process('row_1')).rejects.toThrow('PSP fora');

      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledTimes(1); // só a ativação
      expect(ctx.events.markProcessed).not.toHaveBeenCalled();
    });

    it('no retry, com a cobrança já registrada e a nova já ativa, ainda cancela a antiga', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_succeeded',
        local: { status: 'active', providerSubscriptionId: 'sub_a' },
      });
      ctx.payments.findByProviderId.mockResolvedValue({ status: 'paid' });
      ctx.tx.subscription.findMany.mockResolvedValue([OLD]);

      await ctx.processor.process('row_1');

      expect(ctx.provider.cancelSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ providerSubscriptionId: 'sub_old' }),
      );
      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's_old',
        'canceled',
        expect.anything(),
      );
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it('a antiga de outro PSP fica aberta, com alerta: este não sabe cancelá-la', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });
      ctx.tx.subscription.findMany.mockResolvedValue([
        { id: 's_la', provider: 'outro_psp', providerSubscriptionId: 'sub_la' },
      ]);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await ctx.processor.process('row_1');

      expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledTimes(1); // só a ativação
      // Lá ela segue cobrando: em silêncio, o usuário pagaria em dobro.
      expect(error).toHaveBeenCalledWith(expect.stringContaining('outro_psp'));
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
      error.mockRestore();
    });

    it('não cancela a assinatura do PSP da própria cobrança', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });
      ctx.tx.subscription.findMany.mockResolvedValue([
        { id: 's_dup', provider: 'asaas', providerSubscriptionId: 'sub_a' },
      ]);

      await ctx.processor.process('row_1');

      expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledTimes(1);
    });

    it('cobrança que não está paga não cancela ninguém', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_failed',
        local: { status: 'active' },
        remote: { status: 'failed', paidAt: null },
      });
      ctx.tx.subscription.findMany.mockResolvedValue([OLD]);

      await ctx.processor.process('row_1');

      expect(ctx.tx.subscription.findMany).not.toHaveBeenCalled();
      expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
    });
  });

  describe('cobrança recusada (cartão, análise de risco)', () => {
    /** Evento de recusa; a cobrança, no PSP, segue pendente salvo o teste dizer. */
    function arrangeRefused(
      ctx: ReturnType<typeof setup>,
      scenario: { local?: Record<string, unknown>; remote?: Record<string, unknown> } = {},
      reason = 'card_refused',
    ) {
      arrange(ctx, {
        intent: 'payment_refused',
        local: { providerSubscriptionId: 'sub_a', ...scenario.local },
        remote: { status: 'pending', paidAt: null, ...scenario.remote },
      });
      ctx.provider.normalizeWebhookEvent.mockReturnValue({
        ...chargeEvent('payment_refused'),
        providerCheckoutId: null,
        paymentFailureReason: reason,
      });
    }
    const noted = (reason = 'card_refused') => ({
      lastPaymentFailureAt: RECEIVED_AT,
      lastPaymentFailureReason: reason,
    });

    it('só anota o motivo: o PSP não confirma a recusa, então o estado não muda por ela', async () => {
      const ctx = setup();
      arrangeRefused(ctx);

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.tx.subscription.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: noted(),
      });
      // Mesma transação do registro da cobrança e do fechamento do evento.
      expect(ctx.writes.every((db) => db === ctx.tx)).toBe(true);
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it('anota mesmo com a cobrança já registrada como pendente: é o aviso que traz a recusa', async () => {
      const ctx = setup();
      arrangeRefused(ctx);
      ctx.payments.findByProviderId.mockResolvedValue({ status: 'pending' });

      await ctx.processor.process('row_1');

      expect(ctx.tx.subscription.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: noted(),
      });
    });

    it('na renovação, também só anota: quem rebaixa é o vencimento', async () => {
      const ctx = setup();
      arrangeRefused(
        ctx,
        {
          local: {
            status: 'active',
            currentPeriodStart: new Date('2026-09-12T12:00:00Z'),
            currentPeriodEnd: new Date('2026-10-12T12:00:00Z'),
          },
        },
        'risk_rejected',
      );

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.tx.subscription.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: noted('risk_rejected'),
      });
    });

    it('com a cobrança já vencida no PSP, efeito e anotação vão na mesma transição', async () => {
      const ctx = setup();
      arrangeRefused(ctx, { remote: { status: 'failed' } });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledTimes(1);
      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'unpaid',
        expect.objectContaining({
          data: { providerSubscriptionId: 'sub_a', ...noted() },
        }),
      );
      expect(ctx.tx.subscription.update).not.toHaveBeenCalled();
    });

    it.each([
      ['paga numa nova tentativa', { status: 'paid', paidAt: DUE_TODAY }],
      ['removida', { status: 'canceled' }],
      ['estornada', { status: 'refunded' }],
    ])('recusa de cobrança já %s não é anotada', async (_label, remote) => {
      const ctx = setup();
      arrangeRefused(ctx, { local: { status: 'active' }, remote });

      await ctx.processor.process('row_1');

      expect(ctx.tx.subscription.update).not.toHaveBeenCalled();
      for (const [, , input] of ctx.subscriptions.transitionTo.mock.calls) {
        // Ativar limpa a recusa (nulo); anotar seria gravar um motivo.
        expect(input.data.lastPaymentFailureReason ?? null).toBeNull();
      }
    });

    it('recusa de uma cobrança superada por outra mais nova não é anotada', async () => {
      const ctx = setup();
      arrangeRefused(ctx, { local: { status: 'active' } });
      ctx.payments.hasNewerDecisiveCharge.mockResolvedValue(true);

      await ctx.processor.process('row_1');

      expect(ctx.tx.subscription.update).not.toHaveBeenCalled();
    });
  });

  it('cobrança alterada no PSP (removida, restaurada...) passa pela mesma sincronização', async () => {
    const ctx = setup();
    arrange(ctx, {
      intent: 'payment_updated',
      local: { status: 'active', providerSubscriptionId: 'sub_a' },
      remote: { status: 'canceled', paidAt: null },
    });

    await ctx.processor.process('row_1');

    expect(ctx.provider.getPayment).toHaveBeenCalledWith('pay_1');
    expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerPaymentId: 'pay_1', status: PaymentStatus.canceled }),
    );
    // Cobrança removida não decide nada sobre a assinatura.
    expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('aviso de alteração de uma cobrança paga sem assinatura local só fecha o evento', async () => {
    const ctx = setup();
    arrange(ctx, { intent: 'payment_updated' });
    ctx.prisma.subscription.findFirst.mockReset().mockResolvedValue(null);

    await ctx.processor.process('row_1');

    // Não é o pagamento sem dono: esse erro é só para o aviso de pagamento.
    expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
  });

  it('evento gravado por outro PSP vai para o painel, sem processar', async () => {
    const ctx = setup();
    ctx.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(
      persistedEvent({ provider: 'outro_psp' }),
    );

    await ctx.processor.process('row_1');

    // Este adapter não sabe ler o payload nem consultar as cobranças dele.
    expect(ctx.provider.normalizeWebhookEvent).not.toHaveBeenCalled();
    expect(ctx.provider.getPayment).not.toHaveBeenCalled();
    // Pode ser uma confirmação de pagamento: `processed` a esconderia do painel.
    expect(ctx.events.markProcessed).not.toHaveBeenCalled();
    expect(ctx.events.markUnprocessable).toHaveBeenCalledWith(
      'row_1',
      expect.stringContaining('outro_psp'),
    );
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
        // Só entre as assinaturas deste PSP: o id de outro pode coincidir.
        expect.objectContaining({
          where: { provider: 'asaas', providerSubscriptionId: 'sub_real' },
        }),
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
            // Inclui a tentativa expirada: o checkout trocado ainda pode ser pago.
            status: { not: 'canceled' },
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
      // A linha do cliente está vinculada a outra assinatura do PSP.
      ctx.prisma.subscription.findFirst.mockReset().mockResolvedValue(null);

      await ctx.processor.process('row_1');

      // Só a busca pela assinatura do PSP: sem pagamento, não há plano B por cliente.
      expect(ctx.prisma.subscription.findFirst).toHaveBeenCalledTimes(1);
      expect(ctx.provider.cancelSubscription).not.toHaveBeenCalled();
      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.payments.upsertFromProvider).not.toHaveBeenCalled();
      // Não é erro: nada aqui depende dessa cobrança.
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it.each(['failed', 'chargeback'])(
      'cobrança %s de assinatura desconhecida não toma a linha do checkout em andamento',
      async (status) => {
        const ctx = setup();
        arrange(ctx, {
          intent: 'payment_failed',
          remote: { status, providerSubscriptionId: 'sub_antiga' },
        });
        ctx.prisma.subscription.findFirst.mockReset().mockResolvedValue(null);

        await ctx.processor.process('row_1');

        expect(ctx.prisma.subscription.findFirst).toHaveBeenCalledTimes(1);
        expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      },
    );

    it('cobrança paga de assinatura do PSP sem assinatura local falha, em vez de virar processed', async () => {
      const ctx = setup();
      arrange(ctx, { intent: 'payment_succeeded' });
      ctx.prisma.subscription.findFirst.mockReset().mockResolvedValue(null);

      await expect(ctx.processor.process('row_1')).rejects.toBeInstanceOf(
        UncorrelatedPaymentEventError,
      );

      // O cliente pagou e não há a quem dar acesso: o evento tem de seguir o
      // retry e aparecer no painel, não sumir como resolvido.
      expect(ctx.events.markProcessed).not.toHaveBeenCalled();
      expect(ctx.events.observeProcessed).not.toHaveBeenCalled();
    });

    it('cobrança paga de um checkout, ainda sem assinatura no PSP, não é tratada como avulsa', async () => {
      const ctx = setup();
      arrange(ctx, {
        intent: 'payment_succeeded',
        remote: { providerSubscriptionId: null, providerCheckoutId: 'chk_1' },
      });
      ctx.prisma.subscription.findFirst.mockReset().mockResolvedValue(null);

      await expect(ctx.processor.process('row_1')).rejects.toBeInstanceOf(
        UncorrelatedPaymentEventError,
      );
      expect(ctx.events.markProcessed).not.toHaveBeenCalled();
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

  describe('estorno integral', () => {
    const refund = {
      intent: 'payment_refunded',
      local: { status: 'active', providerSubscriptionId: 'sub_a' },
      remote: { id: 'pay_4', status: 'refunded' },
    };

    it('revoga o acesso, cancela no PSP depois do commit e só então fecha o evento', async () => {
      const ctx = setup();
      arrange(ctx, refund);

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'canceled',
        expect.objectContaining({
          actor: 'webhook:payment_refunded',
          data: { providerSubscriptionId: 'sub_a', canceledAt: NOW },
        }),
      );
      expect(ctx.payments.upsertFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerPaymentId: 'pay_4', status: PaymentStatus.refunded }),
      );
      expect(ctx.provider.cancelSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ providerSubscriptionId: 'sub_a' }),
      );

      const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];
      // A decisão é gravada com a assinatura travada; o PSP vem depois dela.
      expect(order(ctx.subscriptions.transitionTo)).toBeLessThan(
        order(ctx.provider.cancelSubscription),
      );
      expect(order(ctx.provider.cancelSubscription)).toBeLessThan(order(ctx.events.markProcessed));
    });

    it('se o PSP falha, o evento fica aberto para o retry tentar de novo', async () => {
      const ctx = setup();
      arrange(ctx, refund);
      ctx.provider.cancelSubscription.mockRejectedValue(new Error('PSP fora'));

      await expect(ctx.processor.process('row_1')).rejects.toThrow('PSP fora');

      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledTimes(1);
      expect(ctx.events.markProcessed).not.toHaveBeenCalled();
    });

    it('o retry encontra a assinatura já cancelada e ainda garante o cancelamento no PSP', async () => {
      const ctx = setup();
      arrange(ctx, { ...refund, local: { status: 'canceled', providerSubscriptionId: 'sub_a' } });
      ctx.payments.findByProviderId.mockResolvedValue({ status: 'refunded' });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(ctx.provider.cancelSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ providerSubscriptionId: 'sub_a' }),
      );
      expect(ctx.events.markProcessed).toHaveBeenCalledWith('row_1');
    });

    it('revoga mesmo quando a reconciliação já tinha registrado a cobrança como estornada', async () => {
      const ctx = setup();
      arrange(ctx, refund);
      // A reconciliação viu o estorno antes, registrou e não cancelou.
      ctx.payments.findByProviderId.mockResolvedValue({ status: 'refunded' });

      await ctx.processor.process('row_1');

      expect(ctx.subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'canceled',
        expect.anything(),
      );
      expect(ctx.provider.cancelSubscription).toHaveBeenCalledTimes(1);
    });
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

  it('cancelamento de assinatura do PSP desconhecida aqui não casa pelo cliente', async () => {
    const { processor, provider, prisma, subscriptions, events } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'subscription_canceled',
      providerSubscriptionId: 'sub_antiga',
      providerCustomerId: 'cus_a',
      payment: null,
    });
    prisma.subscription.findFirst.mockResolvedValue(null);

    await processor.process('row_1');

    // Uma só busca, pela assinatura do PSP: a linha do checkout em andamento
    // do mesmo cliente não pode ser cancelada pelo fim de uma assinatura antiga.
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(1);
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    expect(events.markProcessed).toHaveBeenCalledWith('row_1');
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

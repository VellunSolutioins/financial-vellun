import { randomUUID } from 'crypto';

import { integration, validationDatabaseUrl } from '../../../test/financial-test-env';
import { PrismaService } from '../../prisma/prisma.service';
import { ChargeSyncService } from '../services/charge-sync.service';
import { PaymentService } from '../services/payment.service';
import { SubscriptionAuditService } from '../services/subscription-audit.service';
import { SubscriptionStateService } from '../services/subscription-state.service';
import { SubscriptionService } from '../services/subscription.service';
import { WebhookEventService } from './webhook-event.service';
import { WebhookProcessor } from './webhook.processor';

/**
 * O que os testes com dublês não conseguem provar: que a trava por assinatura
 * serializa de fato dois eventos, e que uma falha no meio desfaz tudo. Roda
 * sobre um Postgres local de validação, com a mesma regra dos demais
 * `*.integration.spec.ts` (`SELECTED_FEATURES_TEST_DATABASE_URL`, banco
 * terminado em `_validation`). O PSP é o único dublê.
 */
integration('webhook de billing: uma transação por evento (PostgreSQL)', () => {
  let prisma: PrismaService;
  let userId: string;
  let planId: string;
  const eventIds: string[] = [];

  /** Cobranças como o PSP as devolveria, por id. */
  const remoteCharges = new Map<string, Record<string, unknown>>();
  const provider = {
    // O payload de teste já vem no formato normalizado.
    normalizeWebhookEvent: (event: { payload: unknown }) => event.payload,
    getPayment: async (id: string) => remoteCharges.get(id),
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const url = new URL(validationDatabaseUrl!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.pathname.endsWith('_validation')
    ) {
      throw new Error('Use a local database with a name ending in _validation');
    }
    prisma = new PrismaService({ datasources: { db: { url: validationDatabaseUrl } } });
    await prisma.$connect();

    const user = await prisma.user.create({
      data: {
        name: 'Billing transacional',
        email: `${randomUUID()}@example.test`,
        passwordHash: 'not-a-login',
        profileType: 'individual',
      },
    });
    userId = user.id;
    const plan = await prisma.plan.create({
      data: {
        code: `teste-${randomUUID()}`,
        name: 'Plano de teste',
        price: '49.90',
        interval: 'monthly',
        isActive: false,
      },
    });
    planId = plan.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.paymentWebhookEvent.deleteMany({ where: { id: { in: eventIds } } });
    // Assinaturas, pagamentos e auditoria saem em cascata com o usuário.
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    if (planId) await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.$disconnect();
  });

  /** Processador real; `audit` permite injetar uma auditoria que falha. */
  function buildProcessor(audit: SubscriptionAuditService = new SubscriptionAuditService(prisma)) {
    const state = new SubscriptionStateService();
    const subscriptions = new SubscriptionService(prisma, state, audit);
    const charges = new ChargeSyncService(
      provider as any,
      prisma,
      subscriptions,
      state,
      new PaymentService(prisma),
    );
    const events = new WebhookEventService(prisma, { observePaymentWebhook: jest.fn() } as any);
    return new WebhookProcessor(provider as any, prisma, events, subscriptions, state, charges);
  }

  async function pendingSubscription() {
    const providerSubscriptionId = `sub_${randomUUID()}`;
    const subscription = await prisma.subscription.create({
      data: {
        userId,
        planId,
        status: 'pending',
        providerCustomerId: `cus_${randomUUID()}`,
        providerSubscriptionId,
      },
    });
    return { subscription, providerSubscriptionId };
  }

  /** Cobrança paga hoje, da assinatura dada, registrada no "PSP". */
  function paidCharge(providerSubscriptionId: string) {
    const id = `pay_${randomUUID()}`;
    const today = new Date();
    remoteCharges.set(id, {
      id,
      status: 'paid',
      amount: '49.90',
      currency: 'BRL',
      dueAt: today,
      paidAt: today,
      providerSubscriptionId,
      providerCustomerId: null,
      providerCheckoutId: null,
    });
    return id;
  }

  /** Evento recebido, apontando para a cobrança. */
  async function receivedEvent(providerPaymentId: string, providerSubscriptionId: string) {
    const event = await prisma.paymentWebhookEvent.create({
      data: {
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'PAYMENT_CONFIRMED',
        status: 'received',
        sanitizedPayload: {
          intent: 'payment_succeeded',
          providerSubscriptionId,
          providerCustomerId: null,
          payment: { providerPaymentId },
        },
      },
    });
    eventIds.push(event.id);
    return event.id;
  }

  const transitionsOf = (subscriptionId: string) =>
    prisma.subscriptionAudit.findMany({
      where: { subscriptionId, action: { startsWith: 'transition:' } },
    });

  it('dois eventos da mesma cobrança em paralelo aplicam o efeito uma vez só', async () => {
    const { subscription, providerSubscriptionId } = await pendingSubscription();
    const chargeId = paidCharge(providerSubscriptionId);
    // `PAYMENT_CONFIRMED` e uma reentrega chegando juntos: sem a trava, os dois
    // leriam "cobrança ainda não registrada" e ativariam a assinatura duas vezes.
    const [first, second] = await Promise.all([
      receivedEvent(chargeId, providerSubscriptionId),
      receivedEvent(chargeId, providerSubscriptionId),
    ]);
    const processor = buildProcessor();

    await Promise.all([processor.process(first), processor.process(second)]);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.status).toBe('active');
    expect(await transitionsOf(subscription.id)).toHaveLength(1);
    expect(await prisma.payment.count({ where: { providerPaymentId: chargeId } })).toBe(1);

    const events = await prisma.paymentWebhookEvent.findMany({
      where: { id: { in: [first, second] } },
    });
    expect(events.map((event) => event.status)).toEqual(['processed', 'processed']);
    expect(events.map((event) => event.subscriptionId)).toEqual([subscription.id, subscription.id]);
  });

  it('falha na auditoria desfaz a transição, a cobrança e o fechamento do evento', async () => {
    const { subscription, providerSubscriptionId } = await pendingSubscription();
    const chargeId = paidCharge(providerSubscriptionId);
    const eventId = await receivedEvent(chargeId, providerSubscriptionId);

    class FailingAudit extends SubscriptionAuditService {
      override async record(): Promise<never> {
        throw new Error('auditoria fora');
      }
    }
    const processor = buildProcessor(new FailingAudit(prisma));

    await expect(processor.process(eventId)).rejects.toThrow('auditoria fora');

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.status).toBe('pending');
    expect(await prisma.payment.count({ where: { providerPaymentId: chargeId } })).toBe(0);
    const event = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    // Reivindicado e não fechado: é o estado de onde o retry parte.
    expect(event.status).toBe('processing');
  });

  it('depois da falha, o retry aplica tudo de uma vez', async () => {
    const { subscription, providerSubscriptionId } = await pendingSubscription();
    const chargeId = paidCharge(providerSubscriptionId);
    const eventId = await receivedEvent(chargeId, providerSubscriptionId);

    class FailingAudit extends SubscriptionAuditService {
      override async record(): Promise<never> {
        throw new Error('auditoria fora');
      }
    }
    // Primeira tentativa falha e agenda o retry; a segunda roda com tudo no ar.
    await buildProcessor(new FailingAudit(prisma)).attempt(eventId);
    expect(await buildProcessor().attempt(eventId)).toBe('processed');

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.status).toBe('active');
    // Uma auditoria, com a transição real: não um `active->active` de reaplicação.
    const transitions = await transitionsOf(subscription.id);
    expect(transitions.map((audit) => audit.action)).toEqual(['transition:pending->active']);
  });
});

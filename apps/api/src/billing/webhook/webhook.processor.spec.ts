import { PaymentStatus } from '@prisma/client';

import { SubscriptionStateService } from '../services/subscription-state.service';
import { WebhookProcessor } from './webhook.processor';

function setup() {
  const provider = {
    normalizeWebhookEvent: jest.fn(),
    getSubscription: jest.fn(),
  };
  const prisma = {
    paymentWebhookEvent: { findUniqueOrThrow: jest.fn() },
    subscription: { findFirst: jest.fn() },
  };
  const events = {
    markProcessing: jest.fn().mockResolvedValue({}),
    markProcessed: jest.fn().mockResolvedValue({}),
    markFailed: jest.fn().mockResolvedValue({}),
  };
  const subscriptions = { transitionTo: jest.fn().mockResolvedValue({}) };
  const payments = { upsertFromProvider: jest.fn().mockResolvedValue({}) };

  const processor = new WebhookProcessor(
    provider as any,
    prisma as any,
    events as any,
    subscriptions as any,
    new SubscriptionStateService(),
    payments as any,
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
  plan: { interval: 'monthly' },
};

describe('WebhookProcessor.process', () => {
  it('pagamento aprovado confirma no PSP e ativa a assinatura', async () => {
    const { processor, provider, prisma, subscriptions, payments, events } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'payment_succeeded',
      providerSubscriptionId: 'sub_a',
      providerCustomerId: 'cus_a',
      payment: { providerPaymentId: 'pay_1', status: 'paid', amount: '49.90', currency: 'BRL', dueAt: null, paidAt: null },
    });
    prisma.subscription.findFirst.mockResolvedValue(subscription);
    provider.getSubscription.mockResolvedValue({ currentPeriodEnd: new Date('2026-07-15') });

    await processor.process('row_1');

    expect(provider.getSubscription).toHaveBeenCalledWith('sub_a');
    expect(subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'active',
      expect.objectContaining({
        actor: 'webhook:payment_succeeded',
        data: expect.objectContaining({
          providerSubscriptionId: 'sub_a',
          currentPeriodEnd: new Date('2026-07-15'),
          graceUntil: null,
        }),
      }),
    );
    expect(payments.upsertFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerPaymentId: 'pay_1', status: PaymentStatus.paid }),
    );
    expect(events.markProcessed).toHaveBeenCalledWith('row_1');
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

  it('pagamento recusado em assinatura pending vai para unpaid (sem grace/acesso)', async () => {
    const { processor, provider, prisma, subscriptions } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'payment_failed',
      providerSubscriptionId: 'sub_a',
      providerCustomerId: 'cus_a',
      payment: { providerPaymentId: 'pay_1', status: 'failed', amount: '49.90', currency: 'BRL', dueAt: null, paidAt: null },
    });
    prisma.subscription.findFirst.mockResolvedValue({ ...subscription, status: 'pending' });

    await processor.process('row_1');

    expect(subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'unpaid',
      expect.objectContaining({ actor: 'webhook:payment_failed' }),
    );
  });

  it('falha de renovação (active) vai para past_due com grace', async () => {
    const { processor, provider, prisma, subscriptions } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'payment_failed',
      providerSubscriptionId: 'sub_a',
      providerCustomerId: 'cus_a',
      payment: { providerPaymentId: 'pay_2', status: 'failed', amount: '49.90', currency: 'BRL', dueAt: null, paidAt: null },
    });
    prisma.subscription.findFirst.mockResolvedValue({ ...subscription, status: 'active' });

    await processor.process('row_1');

    const call = subscriptions.transitionTo.mock.calls[0];
    expect(call[1]).toBe('past_due');
    expect(call[2].data.graceUntil).toBeInstanceOf(Date);
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
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    expect(events.markProcessed).toHaveBeenCalledWith('row_1');
  });

  it('localiza assinatura por providerCustomerId quando não há subscriptionId local', async () => {
    const { processor, provider, prisma, subscriptions } = setup();
    prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue(persistedEvent());
    provider.normalizeWebhookEvent.mockReturnValue({
      intent: 'subscription_canceled',
      providerSubscriptionId: null,
      providerCustomerId: 'cus_a',
      payment: null,
    });
    prisma.subscription.findFirst.mockResolvedValue({ ...subscription, status: 'active' });

    await processor.process('row_1');

    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ providerCustomerId: 'cus_a' }) }),
    );
    expect(subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'canceled',
      expect.anything(),
    );
  });
});

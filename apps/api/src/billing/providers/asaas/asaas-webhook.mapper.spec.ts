import { normalizeAsaasWebhookEvent } from './asaas-webhook.mapper';

const paymentPayload = {
  id: 'evt_1',
  event: 'PAYMENT_RECEIVED',
  payment: {
    id: 'pay_1',
    status: 'RECEIVED',
    value: 49.9,
    subscription: 'sub_a',
    customer: 'cus_a',
    dueDate: '2026-07-15',
    paymentDate: '2026-07-14',
  },
};

describe('normalizeAsaasWebhookEvent', () => {
  it('mapeia pagamento recebido para payment_succeeded com ids e pagamento', () => {
    const result = normalizeAsaasWebhookEvent('PAYMENT_RECEIVED', paymentPayload);
    expect(result).toMatchObject({
      intent: 'payment_succeeded',
      providerSubscriptionId: 'sub_a',
      providerCustomerId: 'cus_a',
    });
    expect(result.payment).toMatchObject({
      providerPaymentId: 'pay_1',
      status: 'paid',
      amount: '49.90',
      currency: 'BRL',
    });
  });

  it.each([
    ['PAYMENT_OVERDUE', 'payment_failed'],
    ['PAYMENT_REFUNDED', 'payment_refunded'],
    ['PAYMENT_CHARGEBACK_REQUESTED', 'payment_chargeback'],
    ['SUBSCRIPTION_DELETED', 'subscription_canceled'],
    ['PAYMENT_CREATED', 'ignore'],
  ])('mapeia %s para %s', (eventType, intent) => {
    const result = normalizeAsaasWebhookEvent(eventType, { id: 'e', event: eventType });
    expect(result.intent).toBe(intent);
  });

  it('extrai ids de eventos de assinatura', () => {
    const result = normalizeAsaasWebhookEvent('SUBSCRIPTION_DELETED', {
      id: 'evt_2',
      event: 'SUBSCRIPTION_DELETED',
      subscription: { id: 'sub_b', customer: 'cus_b' },
    });
    expect(result).toMatchObject({ providerSubscriptionId: 'sub_b', providerCustomerId: 'cus_b' });
    expect(result.payment).toBeNull();
  });
});

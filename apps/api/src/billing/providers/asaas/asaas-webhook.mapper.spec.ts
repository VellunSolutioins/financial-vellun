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
    ['SUBSCRIPTION_CREATED', 'subscription_created'],
    ['CHECKOUT_EXPIRED', 'checkout_expired'],
    ['CHECKOUT_CANCELED', 'checkout_expired'],
    // Checkout pago não concede acesso: quem concede é a cobrança.
    ['CHECKOUT_PAID', 'ignore'],
    ['CHECKOUT_CREATED', 'ignore'],
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

  describe('checkout de origem', () => {
    it('vem da cobrança', () => {
      const result = normalizeAsaasWebhookEvent('PAYMENT_CONFIRMED', {
        id: 'e',
        event: 'PAYMENT_CONFIRMED',
        payment: { ...paymentPayload.payment, checkoutSession: 'chk_1' },
      });
      expect(result.providerCheckoutId).toBe('chk_1');
    });

    it('vem da assinatura criada', () => {
      const result = normalizeAsaasWebhookEvent('SUBSCRIPTION_CREATED', {
        id: 'e',
        event: 'SUBSCRIPTION_CREATED',
        subscription: { id: 'sub_b', customer: 'cus_b', checkoutSession: 'chk_2' },
      });
      expect(result).toMatchObject({
        intent: 'subscription_created',
        providerSubscriptionId: 'sub_b',
        providerCustomerId: 'cus_b',
        providerCheckoutId: 'chk_2',
      });
    });

    it.each([
      ['como id', 'cus_c'],
      ['como objeto', { id: 'cus_c' }],
    ])('vem do próprio checkout, com o cliente %s', (_label, customer) => {
      const result = normalizeAsaasWebhookEvent('CHECKOUT_EXPIRED', {
        id: 'e',
        event: 'CHECKOUT_EXPIRED',
        checkout: { id: 'chk_3', status: 'EXPIRED', customer },
      });
      expect(result).toMatchObject({
        intent: 'checkout_expired',
        providerCheckoutId: 'chk_3',
        providerCustomerId: 'cus_c',
        providerSubscriptionId: null,
        payment: null,
      });
    });

    it('é nulo quando o evento não traz checkout nenhum', () => {
      expect(
        normalizeAsaasWebhookEvent('PAYMENT_RECEIVED', paymentPayload).providerCheckoutId,
      ).toBeNull();
    });
  });
});

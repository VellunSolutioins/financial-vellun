import { BillingInterval } from '@prisma/client';

import {
  mapPayment,
  mapPaymentStatus,
  mapSubscription,
  mapSubscriptionStatus,
  toAsaasCycle,
} from './asaas.mapper';

describe('asaas.mapper', () => {
  it('toAsaasCycle mapeia periodicidade', () => {
    expect(toAsaasCycle(BillingInterval.monthly)).toBe('MONTHLY');
    expect(toAsaasCycle(BillingInterval.annual)).toBe('YEARLY');
  });

  describe('mapSubscriptionStatus', () => {
    it('ACTIVE → active', () => {
      expect(mapSubscriptionStatus('ACTIVE')).toBe('active');
    });
    it('deleted → canceled (precede status)', () => {
      expect(mapSubscriptionStatus('ACTIVE', true)).toBe('canceled');
    });
    it('EXPIRED → expired', () => {
      expect(mapSubscriptionStatus('EXPIRED')).toBe('expired');
    });
  });

  describe('mapPaymentStatus', () => {
    it.each([
      ['CONFIRMED', 'paid'],
      ['RECEIVED', 'paid'],
      ['PENDING', 'pending'],
      ['OVERDUE', 'failed'],
      ['REFUNDED', 'refunded'],
      // Estorno ainda não concluído não pode disparar o cancelamento.
      // Estorno não concluído pode ser negado: até lá, a cobrança segue paga.
      ['REFUND_REQUESTED', 'paid'],
      ['REFUND_IN_PROGRESS', 'paid'],
      ['PARTIALLY_REFUNDED', 'partially_refunded'],
      ['CHARGEBACK_REQUESTED', 'chargeback'],
    ] as const)('%s → %s', (asaas, internal) => {
      expect(mapPaymentStatus(asaas)).toBe(internal);
    });
  });

  it('mapSubscription converte datas e flags', () => {
    const result = mapSubscription({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'ACTIVE',
      cycle: 'MONTHLY',
      value: 49.9,
      nextDueDate: '2026-07-15',
    });
    expect(result).toMatchObject({
      id: 'sub_1',
      status: 'active',
      cancelAtPeriodEnd: false,
      providerCustomerId: 'cus_1',
      providerCheckoutId: null,
    });
    // Data "date-only" ancorada ao meio-dia UTC (preserva o dia em UTC-3).
    expect(result.nextDueAt).toEqual(new Date('2026-07-15T12:00:00Z'));
  });

  it('mapSubscription: data de cobrança não recua um dia ao exibir em America/Sao_Paulo (UTC-3)', () => {
    const result = mapSubscription({
      id: 'sub_2',
      customer: 'cus_1',
      status: 'ACTIVE',
      cycle: 'MONTHLY',
      value: 49.9,
      nextDueDate: '2026-07-30',
    });
    const shown = result.nextDueAt?.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    });
    expect(shown).toBe('30/07/2026');
  });

  it('mapPayment formata valor e traz os vínculos da cobrança', () => {
    const result = mapPayment({
      id: 'pay_1',
      status: 'CONFIRMED',
      value: 49.9,
      dueDate: '2026-07-15',
      confirmedDate: '2026-07-14',
      subscription: 'sub_1',
      customer: 'cus_1',
      checkoutSession: 'chk_1',
    });
    expect(result).toMatchObject({
      id: 'pay_1',
      status: 'paid',
      amount: '49.90',
      currency: 'BRL',
      providerSubscriptionId: 'sub_1',
      providerCustomerId: 'cus_1',
      providerCheckoutId: 'chk_1',
    });
    expect(result.paidAt).toEqual(new Date('2026-07-14T12:00:00Z'));
  });

  it('mapPayment: paidAt é a data do pagamento, não a do crédito (~32 dias depois no cartão)', () => {
    const result = mapPayment({
      id: 'pay_1',
      status: 'RECEIVED',
      value: 49.9,
      dueDate: '2026-07-15',
      confirmedDate: '2026-07-15',
      paymentDate: '2026-08-17',
    });
    expect(result.paidAt).toEqual(new Date('2026-07-15T12:00:00Z'));
  });

  it('mapPayment: sem confirmedDate cai na data do crédito', () => {
    const result = mapPayment({
      id: 'pay_1',
      status: 'RECEIVED',
      value: 49.9,
      paymentDate: '2026-07-14',
    });
    expect(result.paidAt).toEqual(new Date('2026-07-14T12:00:00Z'));
  });

  it('mapPayment: cobrança avulsa não tem vínculos de assinatura nem checkout', () => {
    const result = mapPayment({ id: 'pay_1', status: 'PENDING', value: 10 });
    expect(result).toMatchObject({
      providerSubscriptionId: null,
      providerCustomerId: null,
      providerCheckoutId: null,
    });
  });

  it('mapPayment: cobrança removida vira canceled, qualquer que fosse o status', () => {
    const result = mapPayment({ id: 'pay_1', status: 'OVERDUE', value: 49.9, deleted: true });
    expect(result.status).toBe('canceled');
  });
});

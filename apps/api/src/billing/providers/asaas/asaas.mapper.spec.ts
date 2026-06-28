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
    expect(result).toMatchObject({ id: 'sub_1', status: 'active', cancelAtPeriodEnd: false });
    expect(result.currentPeriodEnd).toEqual(new Date('2026-07-15'));
  });

  it('mapPayment formata valor e usa paymentDate', () => {
    const result = mapPayment({
      id: 'pay_1',
      status: 'RECEIVED',
      value: 49.9,
      dueDate: '2026-07-15',
      paymentDate: '2026-07-14',
    });
    expect(result).toMatchObject({ id: 'pay_1', status: 'paid', amount: '49.90', currency: 'BRL' });
    expect(result.paidAt).toEqual(new Date('2026-07-14'));
  });
});

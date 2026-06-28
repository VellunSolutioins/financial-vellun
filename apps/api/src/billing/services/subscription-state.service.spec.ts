import { BillingInterval, SubscriptionStatus } from '@prisma/client';

import { InvalidSubscriptionTransitionError } from '../billing.errors';
import { SubscriptionStateService } from './subscription-state.service';

describe('SubscriptionStateService', () => {
  let service: SubscriptionStateService;

  beforeEach(() => {
    service = new SubscriptionStateService();
  });

  describe('máquina de estados', () => {
    it('permite transições válidas do ciclo de vida', () => {
      expect(service.canTransition('pending', 'trialing')).toBe(true);
      expect(service.canTransition('trialing', 'active')).toBe(true);
      expect(service.canTransition('active', 'past_due')).toBe(true);
      expect(service.canTransition('past_due', 'active')).toBe(true);
      expect(service.canTransition('past_due', 'unpaid')).toBe(true);
      expect(service.canTransition('canceled', 'active')).toBe(true);
    });

    it('permite self-transição em active (renovação/idempotência)', () => {
      expect(service.canTransition('active', 'active')).toBe(true);
    });

    it('rejeita transições inválidas', () => {
      expect(service.canTransition('expired', 'past_due')).toBe(false);
      expect(service.canTransition('unpaid', 'trialing')).toBe(false);
      expect(service.canTransition('canceled', 'past_due')).toBe(false);
      expect(service.canTransition('expired', 'unpaid')).toBe(false);
    });

    it('assertTransition lança em transição inválida', () => {
      expect(() => service.assertTransition('expired', 'past_due')).toThrow(
        InvalidSubscriptionTransitionError,
      );
    });

    it('assertTransition não lança em transição válida', () => {
      expect(() => service.assertTransition('active', 'canceled')).not.toThrow();
    });
  });

  describe('cálculo de datas', () => {
    it('computeTrialEnd soma 30 dias', () => {
      const start = new Date('2026-06-01T00:00:00.000Z');
      expect(service.computeTrialEnd(start)).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    });

    it('computeGraceUntil soma 3 dias', () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      expect(service.computeGraceUntil(from)).toEqual(new Date('2026-06-04T00:00:00.000Z'));
    });

    it('computePeriodEnd mensal soma 1 mês', () => {
      const start = new Date('2026-01-15T00:00:00.000Z');
      expect(service.computePeriodEnd(start, BillingInterval.monthly)).toEqual(
        new Date('2026-02-15T00:00:00.000Z'),
      );
    });

    it('computePeriodEnd anual soma 1 ano', () => {
      const start = new Date('2026-01-15T00:00:00.000Z');
      expect(service.computePeriodEnd(start, BillingInterval.annual)).toEqual(
        new Date('2027-01-15T00:00:00.000Z'),
      );
    });

    it('não muta a data de entrada', () => {
      const start = new Date('2026-06-01T00:00:00.000Z');
      service.computeTrialEnd(start);
      service.computePeriodEnd(start, BillingInterval.monthly);
      expect(start).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    });
  });

  it('cobre os status do enum como origem de transição', () => {
    for (const status of Object.values(SubscriptionStatus)) {
      expect(() => service.canTransition(status, 'active')).not.toThrow();
    }
  });
});

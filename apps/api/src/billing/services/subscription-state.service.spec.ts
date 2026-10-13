import { BillingInterval, PaymentStatus, SubscriptionStatus } from '@prisma/client';

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

  describe('isCancellationDeferred', () => {
    const now = new Date('2026-06-30T00:00:00.000Z');

    it('é verdadeiro com cancelAtPeriodEnd e período no futuro', () => {
      expect(
        service.isCancellationDeferred(
          { cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2026-07-30T00:00:00.000Z') },
          now,
        ),
      ).toBe(true);
    });

    it('é falso quando o período já passou', () => {
      expect(
        service.isCancellationDeferred(
          { cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2026-06-15T00:00:00.000Z') },
          now,
        ),
      ).toBe(false);
    });

    it('é falso sem cancelAtPeriodEnd ou sem data de período', () => {
      expect(
        service.isCancellationDeferred(
          { cancelAtPeriodEnd: false, currentPeriodEnd: new Date('2026-07-30T00:00:00.000Z') },
          now,
        ),
      ).toBe(false);
      expect(
        service.isCancellationDeferred({ cancelAtPeriodEnd: true, currentPeriodEnd: null }, now),
      ).toBe(false);
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

    it('computePeriodEnd não transborda o mês: dia 31 cai no último dia do mês seguinte', () => {
      // Datas ancoradas ao meio-dia UTC, como as de vencimento vindas do PSP.
      expect(
        service.computePeriodEnd(new Date('2026-01-31T12:00:00.000Z'), BillingInterval.monthly),
      ).toEqual(new Date('2026-02-28T12:00:00.000Z'));
      expect(
        service.computePeriodEnd(new Date('2026-03-31T12:00:00.000Z'), BillingInterval.monthly),
      ).toEqual(new Date('2026-04-30T12:00:00.000Z'));
    });

    it('computePeriodEnd anual a partir de 29/02 cai em 28/02', () => {
      expect(
        service.computePeriodEnd(new Date('2028-02-29T12:00:00.000Z'), BillingInterval.annual),
      ).toEqual(new Date('2029-02-28T12:00:00.000Z'));
    });

    it('computePeriodEnd atravessa a virada do ano', () => {
      expect(
        service.computePeriodEnd(new Date('2026-12-15T12:00:00.000Z'), BillingInterval.monthly),
      ).toEqual(new Date('2027-01-15T12:00:00.000Z'));
    });

    it('não muta a data de entrada', () => {
      const start = new Date('2026-06-01T00:00:00.000Z');
      service.computeTrialEnd(start);
      service.computePeriodEnd(start, BillingInterval.monthly);
      expect(start).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    });
  });

  describe('effectOfCharge', () => {
    const now = new Date('2026-10-12T15:00:00.000Z');
    const due = new Date('2026-10-12T12:00:00.000Z');
    const sub = (status: SubscriptionStatus, currentPeriodEnd: Date | null = null) => ({
      status,
      currentPeriodEnd,
      plan: { interval: BillingInterval.monthly },
    });
    const charge = (status: PaymentStatus, dueAt: Date | null = due) => ({
      status,
      dueAt,
      paidAt: status === PaymentStatus.paid ? dueAt : null,
    });

    it('cobrança paga ativa com o período ancorado no vencimento', () => {
      expect(service.effectOfCharge(sub('pending'), charge('paid'), now)).toEqual({
        kind: 'activate',
        currentPeriodStart: due,
        currentPeriodEnd: new Date('2026-11-12T12:00:00.000Z'),
      });
    });

    it.each(['past_due', 'unpaid', 'canceled', 'expired'] as const)(
      'cobrança paga dentro do período reativa a partir de %s',
      (status) => {
        expect(service.effectOfCharge(sub(status), charge('paid'), now).kind).toBe('activate');
      },
    );

    it('cobrança paga de um período que já acabou não concede acesso', () => {
      const old = new Date('2026-08-15T12:00:00.000Z');
      expect(service.effectOfCharge(sub('past_due'), charge('paid', old), now)).toEqual({
        kind: 'none',
      });
    });

    it('cobrança paga já refletida na assinatura não pede nada', () => {
      const applied = sub('active', new Date('2026-11-12T12:00:00.000Z'));
      expect(service.effectOfCharge(applied, charge('paid'), now)).toEqual({ kind: 'none' });
    });

    it.each(['active', 'trialing'] as const)(
      'cobrança vencida de quem estava em dia (%s) dá grace contado do vencimento',
      (status) => {
        expect(service.effectOfCharge(sub(status), charge('failed'), now)).toEqual({
          kind: 'past_due',
          graceUntil: new Date('2026-10-15T12:00:00.000Z'),
        });
      },
    );

    it('avaliar duas vezes a mesma cobrança vencida dá o mesmo grace (não estende)', () => {
      const later = new Date('2026-10-20T15:00:00.000Z');
      expect(service.effectOfCharge(sub('active'), charge('failed'), later)).toEqual(
        service.effectOfCharge(sub('active'), charge('failed'), now),
      );
    });

    it('cobrança vencida não dá novo grace a quem já está past_due', () => {
      expect(service.effectOfCharge(sub('past_due'), charge('failed'), now)).toEqual({
        kind: 'none',
      });
    });

    it('primeira cobrança vencida (pending) vai para unpaid', () => {
      expect(service.effectOfCharge(sub('pending'), charge('failed'), now)).toEqual({
        kind: 'unpaid',
      });
    });

    it('chargeback revoga o acesso e é inofensivo em quem já está unpaid', () => {
      expect(service.effectOfCharge(sub('active'), charge('chargeback'), now).kind).toBe('unpaid');
      expect(service.effectOfCharge(sub('unpaid'), charge('chargeback'), now).kind).toBe('none');
    });

    it('estorno integral cancela; em assinatura já cancelada não pede nada', () => {
      expect(service.effectOfCharge(sub('active'), charge('refunded'), now).kind).toBe('cancel');
      expect(service.effectOfCharge(sub('canceled'), charge('refunded'), now).kind).toBe('none');
    });

    it.each(['pending', 'processing', 'partially_refunded', 'canceled'] as const)(
      'cobrança em %s não decide nada',
      (status) => {
        expect(service.effectOfCharge(sub('active'), charge(status), now)).toEqual({
          kind: 'none',
        });
      },
    );
  });

  it('cobre os status do enum como origem de transição', () => {
    for (const status of Object.values(SubscriptionStatus)) {
      expect(() => service.canTransition(status, 'active')).not.toThrow();
    }
  });
});

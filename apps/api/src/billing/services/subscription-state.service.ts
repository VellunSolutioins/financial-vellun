import { Injectable } from '@nestjs/common';
import { BillingInterval, SubscriptionStatus } from '@prisma/client';

import { GRACE_DAYS, TRIAL_DAYS } from '../billing.constants';
import { InvalidSubscriptionTransitionError } from '../billing.errors';

/**
 * Transições válidas da máquina de estados de assinatura. Self-transições em
 * `active`/`trialing`/`past_due` são permitidas para suportar renovações e
 * reprocessamento idempotente de eventos. `canceled`/`expired` permitem voltar
 * a `pending`/`active` para recontratação.
 */
const ALLOWED_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  pending: ['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'expired'],
  trialing: ['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'expired'],
  active: ['active', 'past_due', 'unpaid', 'canceled', 'expired'],
  past_due: ['past_due', 'active', 'unpaid', 'canceled', 'expired'],
  unpaid: ['active', 'canceled', 'expired'],
  canceled: ['pending', 'active'],
  expired: ['pending', 'active'],
};

@Injectable()
export class SubscriptionStateService {
  /** Indica se a transição `from → to` é permitida pela máquina de estados. */
  canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /**
   * Cancelamento agendado para o fim do período pago e ainda dentro dele
   * (`cancelAtPeriodEnd` + `currentPeriodEnd` no futuro). Nesse estado, sinais de
   * cancelamento do PSP — que exclui a assinatura imediatamente — **não** devem
   * revogar o acesso antes de `currentPeriodEnd`. O cancelamento efetivo ocorre
   * quando o período expira (via reconciliação).
   */
  isCancellationDeferred(
    sub: { cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null },
    now: Date = new Date(),
  ): boolean {
    return sub.cancelAtPeriodEnd && sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now;
  }

  /** Lança {@link InvalidSubscriptionTransitionError} quando a transição é inválida. */
  assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidSubscriptionTransitionError(from, to);
    }
  }

  /** Fim do período de teste: `start` + 30 dias. */
  computeTrialEnd(start: Date = new Date()): Date {
    return this.addDays(start, TRIAL_DAYS);
  }

  /** Fim da janela de tolerância (grace): `from` + 3 dias. */
  computeGraceUntil(from: Date = new Date()): Date {
    return this.addDays(from, GRACE_DAYS);
  }

  /** Fim do período pago a partir de `start`, conforme a periodicidade do plano. */
  computePeriodEnd(start: Date, interval: BillingInterval): Date {
    const end = new Date(start);
    if (interval === BillingInterval.monthly) {
      end.setMonth(end.getMonth() + 1);
    } else {
      end.setFullYear(end.getFullYear() + 1);
    }
    return end;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}

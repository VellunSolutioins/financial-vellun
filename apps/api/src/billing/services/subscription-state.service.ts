import { Injectable } from '@nestjs/common';
import { BillingInterval, PaymentStatus, SubscriptionStatus } from '@prisma/client';

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

/** O que uma cobrança, no estado em que está, pede da assinatura. */
export type ChargeEffect =
  | { kind: 'none' }
  | { kind: 'activate'; currentPeriodStart: Date; currentPeriodEnd: Date }
  | {
      kind: 'past_due';
      graceUntil: Date;
      /** `true` quando não há cobrança vencida: o período pago acabou e o PSP não gerou outra. */
      lapsed?: true;
    }
  | { kind: 'unpaid' }
  | { kind: 'cancel' };

/**
 * Status de cobrança que decidem o estado da assinatura. Uma cobrança
 * `pending` (ex.: a do mês que vem, já gerada pelo PSP) não decide nada.
 */
export const DECISIVE_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.paid,
  PaymentStatus.failed,
  PaymentStatus.chargeback,
  PaymentStatus.refunded,
];

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

  /**
   * Efeito de uma cobrança sobre a assinatura, dado o estado atual das duas.
   *
   * É uma função do **estado**, não do evento: a mesma cobrança avaliada duas
   * vezes pede a mesma coisa, e as datas saem do vencimento, não do relógio.
   * Por isso serve igual ao webhook e à reconciliação, e reprocessar não
   * estende grace nem desloca o período.
   */
  effectOfCharge(
    sub: {
      status: SubscriptionStatus;
      currentPeriodEnd: Date | null;
      plan: { interval: BillingInterval };
    },
    charge: { status: PaymentStatus; dueAt: Date | null; paidAt: Date | null },
    now: Date = new Date(),
    /**
     * `isLastGenerated`: o PSP não tem cobrança posterior a esta. Só a
     * reconciliação sabe dizer, porque é quem lê a lista de cobranças.
     */
    context: { isLastGenerated?: boolean } = {},
  ): ChargeEffect {
    switch (charge.status) {
      case PaymentStatus.paid: {
        // O período pago é ancorado no vencimento: `nextDueDate` da assinatura
        // no PSP aponta para a próxima cobrança a gerar, não para o fim deste.
        const start = charge.dueAt ?? charge.paidAt ?? now;
        const end = this.computePeriodEnd(start, sub.plan.interval);
        // Cobrança de um período que já acabou não concede acesso. É o caso do
        // aviso de crédito (~32 dias depois do pagamento no cartão) chegando
        // com a assinatura já inadimplente ou cancelada.
        if (end <= now) {
          // ...a não ser que seja a última que o PSP gerou. Aí a assinatura em
          // dia ficou sem cobrança para o período atual (removida no painel,
          // por exemplo): nenhum evento vai rebaixá-la, e `active` não confere
          // data — ela teria acesso para sempre.
          const lapsed = context.isLastGenerated && sub.status === SubscriptionStatus.active;
          return lapsed
            ? { kind: 'past_due', graceUntil: this.computeGraceUntil(end), lapsed: true }
            : { kind: 'none' };
        }
        const alreadyApplied =
          sub.status === SubscriptionStatus.active &&
          sub.currentPeriodEnd?.getTime() === end.getTime();
        if (alreadyApplied) return { kind: 'none' };
        return { kind: 'activate', currentPeriodStart: start, currentPeriodEnd: end };
      }

      case PaymentStatus.failed:
        // Só quem estava em dia ganha grace. Quem já está `past_due` não ganha
        // outro a cada cobrança vencida — seriam 3 dias de acesso por mês sem pagar.
        if (
          sub.status === SubscriptionStatus.active ||
          sub.status === SubscriptionStatus.trialing
        ) {
          return { kind: 'past_due', graceUntil: this.computeGraceUntil(charge.dueAt ?? now) };
        }
        // Primeira cobrança recusada: nunca teve acesso.
        if (sub.status === SubscriptionStatus.pending) return { kind: 'unpaid' };
        return { kind: 'none' };

      case PaymentStatus.chargeback:
        return this.canTransition(sub.status, SubscriptionStatus.unpaid)
          ? { kind: 'unpaid' }
          : { kind: 'none' };

      case PaymentStatus.refunded:
        return this.canTransition(sub.status, SubscriptionStatus.canceled)
          ? { kind: 'cancel' }
          : { kind: 'none' };

      default:
        return { kind: 'none' };
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
    const months = interval === BillingInterval.monthly ? 1 : 12;
    const end = new Date(start);
    const day = end.getDate();
    // Vai ao dia 1 antes de trocar o mês: `setMonth` num dia 31 transborda
    // para o mês seguinte (31/01 + 1 mês viraria 03/03).
    end.setDate(1);
    end.setMonth(end.getMonth() + months);
    const lastDay = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
    end.setDate(Math.min(day, lastDay));
    return end;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}

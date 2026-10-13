import { Inject, Injectable } from '@nestjs/common';
import { Payment, PaymentStatus, Plan, Subscription, SubscriptionStatus } from '@prisma/client';

import { cents } from '../../common/db';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderPayment,
} from '../providers/payment-provider.interface';
import { PaymentService, toPaymentStatus } from './payment.service';
import { ChargeEffect, SubscriptionStateService } from './subscription-state.service';
import { SubscriptionService } from './subscription.service';

export type SubscriptionWithPlan = Subscription & { plan: Plan };

/**
 * - `unchanged`: a cobrança já estava registrada neste status; nada a fazer.
 * - `superseded`: há cobrança mais nova decidindo o estado da assinatura.
 * - `recorded`: a cobrança foi registrada e não pede nada da assinatura.
 * - `applied`: a assinatura mudou.
 * - `held`: a cobrança pede um cancelamento que a reconciliação não faz
 *   sozinha; fica para um operador decidir.
 */
export type ChargeSyncOutcome = 'unchanged' | 'superseded' | 'recorded' | 'applied' | 'held';

export interface ChargeSyncOptions {
  source: 'webhook' | 'reconciliation';
  /**
   * `true` no webhook: só age quando o status local da cobrança muda, que é o
   * que torna reentrega e eventos repetidos da mesma cobrança inofensivos.
   * `false` na reconciliação: ela existe para conferir o estado mesmo quando
   * nada mudou, inclusive o que um bug anterior deixou errado.
   */
  onlyOnChange: boolean;
  now?: Date;
}

/**
 * Aplica à assinatura o que uma cobrança, **no estado em que está no PSP**,
 * pede dela. Caminho único do webhook e da reconciliação: se os dois
 * decidissem por regras próprias, um desfaria o que o outro fez — foi assim
 * que a reconciliação reativava quem o webhook tinha marcado inadimplente.
 */
@Injectable()
export class ChargeSyncService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly subscriptions: SubscriptionService,
    private readonly state: SubscriptionStateService,
    private readonly payments: PaymentService,
  ) {}

  async sync(
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    options: ChargeSyncOptions,
  ): Promise<ChargeSyncOutcome> {
    const now = options.now ?? new Date();
    const status = toPaymentStatus(charge.status);
    const dueAt = charge.dueAt ?? null;
    const paidAt = charge.paidAt ?? null;
    const previous = await this.payments.findByProviderId(charge.id);

    // Contestação vale para qualquer cobrança, não só a mais recente: costuma
    // chegar 30+ dias depois, com o mês seguinte já pago.
    const isChargeback = status === PaymentStatus.chargeback;

    let outcome: ChargeSyncOutcome = 'recorded';
    if (options.onlyOnChange && previous?.status === status) {
      outcome = 'unchanged';
    } else if (
      !isChargeback &&
      (await this.payments.hasNewerDecisiveCharge(sub.id, charge.id, dueAt))
    ) {
      outcome = 'superseded';
    } else {
      const effect = this.state.effectOfCharge(sub, { status, dueAt, paidAt }, now);
      if (effect.kind === 'cancel' && options.source === 'reconciliation') {
        // Estorno revoga o acesso quando o aviso chega pelo webhook. A
        // reconciliação não cancela por conta própria: ela enxerga também os
        // estornos antigos, de antes desta regra, e cancelar no PSP não tem
        // volta. Avisa uma vez — na próxima passada a cobrança já está
        // registrada como estornada e não volta a ser `held`.
        if (previous?.status !== status) outcome = 'held';
      } else {
        const blocked =
          effect.kind === 'activate' && (await this.payments.hasOpenChargeback(sub.id, charge.id));
        if (!blocked && (await this.apply(sub, charge, status, effect, options.source, now))) {
          outcome = 'applied';
        }
      }
    }

    // Por último, de propósito: o status gravado aqui é o que faz a próxima
    // entrega da mesma cobrança ser `unchanged`. Gravado antes do efeito, uma
    // falha no meio deixaria a cobrança "já tratada" sem a assinatura ter mudado.
    const record = {
      userId: sub.userId,
      subscriptionId: sub.id,
      providerPaymentId: charge.id,
      amount: charge.amount,
      currency: charge.currency,
      status,
      dueAt,
      paidAt: paidAt ?? (status === PaymentStatus.paid ? (previous?.paidAt ?? now) : null),
      failedAt: status === PaymentStatus.failed ? (previous?.failedAt ?? now) : null,
    };
    // A reconciliação passa aqui toda hora com a mesma cobrança: sem esta
    // checagem seria uma escrita por assinatura por hora para gravar o que já está lá.
    if (!this.alreadyRecorded(previous, record)) {
      await this.payments.upsertFromProvider(record);
    }

    return outcome;
  }

  private alreadyRecorded(
    previous: Payment | null,
    record: { subscriptionId: string; amount: string; status: PaymentStatus } & Record<
      'dueAt' | 'paidAt' | 'failedAt',
      Date | null
    >,
  ): boolean {
    if (!previous) return false;
    const sameDate = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime();
    return (
      previous.status === record.status &&
      previous.subscriptionId === record.subscriptionId &&
      cents(previous.amount) === cents(record.amount) &&
      sameDate(previous.dueAt, record.dueAt) &&
      sameDate(previous.paidAt, record.paidAt) &&
      sameDate(previous.failedAt, record.failedAt)
    );
  }

  private async apply(
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    status: PaymentStatus,
    effect: ChargeEffect,
    source: ChargeSyncOptions['source'],
    now: Date,
  ): Promise<boolean> {
    const origin = (label: string) => ({
      actor: source === 'webhook' ? `webhook:${label}` : 'reconciliation',
      reason: `cobrança ${charge.id} em ${status}`,
    });
    // A assinatura do PSP a que a cobrança pertence. Gravada em toda transição,
    // não só na ativação: uma linha que foi para `unpaid` ou `canceled` sem o
    // vínculo ficaria fora da reconciliação e sem como achar as cobranças seguintes.
    const providerSubscriptionId = charge.providerSubscriptionId ?? sub.providerSubscriptionId;

    switch (effect.kind) {
      case 'none':
        return false;

      case 'activate':
        await this.subscriptions.transitionTo(sub.id, SubscriptionStatus.active, {
          ...origin('payment_succeeded'),
          data: {
            providerSubscriptionId,
            currentPeriodStart: effect.currentPeriodStart,
            currentPeriodEnd: effect.currentPeriodEnd,
            graceUntil: null,
          },
        });
        return true;

      case 'past_due':
        await this.subscriptions.transitionTo(sub.id, SubscriptionStatus.past_due, {
          ...origin('payment_failed'),
          data: { providerSubscriptionId, graceUntil: effect.graceUntil },
        });
        return true;

      case 'unpaid':
        await this.subscriptions.transitionTo(sub.id, SubscriptionStatus.unpaid, {
          ...origin(status === PaymentStatus.chargeback ? 'payment_chargeback' : 'payment_failed'),
          data: { providerSubscriptionId },
        });
        return true;

      case 'cancel':
        // Estorno integral: para de cobrar no PSP antes de revogar aqui. Na
        // ordem inversa, uma falha deixaria o cliente sem acesso e ainda sendo
        // cobrado no ciclo seguinte. O id vem da cobrança quando a linha local
        // ainda não foi vinculada — é o caso do estorno da primeira cobrança.
        if (providerSubscriptionId) {
          await this.provider.cancelSubscription({
            providerSubscriptionId,
            cancelAtPeriodEnd: false,
          });
        }
        await this.subscriptions.transitionTo(sub.id, SubscriptionStatus.canceled, {
          ...origin('payment_refunded'),
          data: { providerSubscriptionId, canceledAt: now },
        });
        return true;
    }
  }
}

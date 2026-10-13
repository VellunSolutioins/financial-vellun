import { Inject, Injectable } from '@nestjs/common';
import { Payment, PaymentStatus, Plan, Subscription, SubscriptionStatus } from '@prisma/client';

import { Db, FINANCIAL_TX_OPTIONS, cents, lockSubscription } from '../../common/db';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderPayment,
} from '../providers/payment-provider.interface';
import { PaymentService, UpsertPaymentInput, toPaymentStatus } from './payment.service';
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

/**
 * Quem está sincronizando, e é isso que muda a regra:
 *
 * - `webhook` só age quando o status local da cobrança muda — é o que torna
 *   reentrega e eventos repetidos da mesma cobrança inofensivos.
 * - `reconciliation` confere o estado mesmo quando nada mudou, inclusive o que
 *   um bug anterior deixou errado, e não cancela por estorno.
 */
export type ChargeSource = 'webhook' | 'reconciliation';

export interface ChargeSyncContext {
  now?: Date;
  /** O PSP não tem cobrança posterior a esta. Só a reconciliação sabe dizer. */
  isLastGenerated?: boolean;
}

export interface ChargeSyncResult {
  outcome: ChargeSyncOutcome;
  /**
   * Assinatura do PSP a cancelar **depois do commit**, quando a cobrança foi
   * estornada. Ver {@link ChargeSyncService.settle}.
   */
  cancelAtGateway: string | null;
}

interface Decision {
  status: PaymentStatus;
  previous: Payment | null;
  outcome: ChargeSyncOutcome;
  /** Diferente de `none` só quando `outcome` é `applied`. */
  effect: ChargeEffect;
}

/**
 * Aplica à assinatura o que uma cobrança, **no estado em que está no PSP**,
 * pede dela. Caminho único do webhook e da reconciliação: se os dois
 * decidissem por regras próprias, um desfaria o que o outro fez — foi assim
 * que a reconciliação reativava quem o webhook tinha marcado inadimplente.
 *
 * A decisão é tomada com a assinatura travada ({@link applyInTransaction}), e o
 * que ela exige do PSP é feito depois do commit ({@link settle}). Nunca o
 * contrário: uma chamada ao PSP baseada numa leitura sem trava poderia cancelar
 * lá o que, na hora de gravar, já não era para cancelar aqui.
 */
@Injectable()
export class ChargeSyncService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly state: SubscriptionStateService,
    private readonly payments: PaymentService,
  ) {}

  /** Sincroniza numa transação própria. Para quem não tem mais nada a gravar junto. */
  async sync(
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    source: ChargeSource,
    context: ChargeSyncContext = {},
  ): Promise<ChargeSyncOutcome> {
    // Prévia sem trava. A reconciliação passa aqui toda hora com a mesma
    // cobrança de cada assinatura, e quase sempre não há nada a fazer: abrir
    // transação e travar a linha só para constatar isso disputaria a trava com
    // os webhooks à toa. Havendo o que gravar, a decisão que vale é a de baixo.
    const preview = await this.decide(this.prisma, sub, charge, source, context);
    const nothingToWrite =
      preview.outcome !== 'applied' &&
      this.alreadyRecorded(preview.previous, this.recordOf(sub, charge, preview, context));
    if (nothingToWrite) return preview.outcome;

    const result = await this.prisma.$transaction(
      (tx) => this.applyInTransaction(tx, sub.id, charge, source, context),
      FINANCIAL_TX_OPTIONS,
    );
    await this.settle(result);
    return result.outcome;
  }

  /**
   * Trava a assinatura, relê o estado e grava tudo no `tx` de quem chama.
   *
   * A trava serializa os eventos da mesma assinatura; a releitura garante que
   * a decisão é tomada sobre o que o evento anterior deixou, não sobre o que
   * este leu antes de esperar a vez.
   */
  async applyInTransaction(
    tx: Db,
    subscriptionId: string,
    charge: ProviderPayment,
    source: ChargeSource,
    context: ChargeSyncContext = {},
  ): Promise<ChargeSyncResult> {
    await lockSubscription(tx, subscriptionId);
    const sub = await tx.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: { plan: true },
    });

    const decision = await this.decide(tx, sub, charge, source, context);
    await this.applyEffect(tx, sub, charge, decision, source, context.now ?? new Date());

    const record = this.recordOf(sub, charge, decision, context);
    if (!this.alreadyRecorded(decision.previous, record)) {
      await this.payments.upsertFromProvider(record, tx);
    }

    return {
      outcome: decision.outcome,
      cancelAtGateway: this.gatewayCancellation(sub, charge, decision, source),
    };
  }

  /**
   * Faz no PSP o que a decisão, já gravada, exige. Quem chama mantém o evento
   * aberto até isto dar certo: se o PSP falhar, o retry volta aqui.
   */
  async settle(result: ChargeSyncResult): Promise<void> {
    if (!result.cancelAtGateway) return;
    await this.provider.cancelSubscription({
      providerSubscriptionId: result.cancelAtGateway,
      cancelAtPeriodEnd: false,
    });
  }

  /**
   * Atualiza as cobranças que aqui ainda constam em disputa e no PSP já saíram
   * dela. Uma disputa aberta bloqueia a reativação pelo webhook; se o aviso de
   * que ela terminou se perde, a linha local ficaria bloqueando para sempre um
   * cliente que paga em dia.
   */
  async refreshResolvedChargebacks(
    sub: SubscriptionWithPlan,
    charges: ProviderPayment[],
  ): Promise<void> {
    const disputed = await this.payments.findChargebacks(sub.id);
    for (const row of disputed) {
      const remote = charges.find((charge) => charge.id === row.providerPaymentId);
      if (!remote) continue;
      const status = toPaymentStatus(remote.status);
      if (status === PaymentStatus.chargeback) continue;
      await this.payments.upsertFromProvider(
        this.recordOf(sub, remote, { status, previous: row }, {}),
      );
    }
  }

  /** O que a cobrança pede, lendo o estado por `db` — sem gravar nada. */
  private async decide(
    db: Db,
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    source: ChargeSource,
    context: ChargeSyncContext,
  ): Promise<Decision> {
    const now = context.now ?? new Date();
    const status = toPaymentStatus(charge.status);
    const dueAt = charge.dueAt ?? null;
    const previous = await this.payments.findByProviderId(charge.id, db);
    const none = (outcome: ChargeSyncOutcome): Decision => ({
      status,
      previous,
      outcome,
      effect: { kind: 'none' },
    });

    // Estorno fica fora do atalho: a reconciliação pode ter registrado a
    // cobrança como estornada sem cancelar (`held`), e o aviso do webhook
    // chegando depois ainda precisa revogar o acesso. Não há risco em
    // reavaliar — em assinatura já cancelada o efeito é nenhum.
    const isRefund = status === PaymentStatus.refunded;
    if (source === 'webhook' && previous?.status === status && !isRefund) {
      return none('unchanged');
    }

    // Contestação vale para qualquer cobrança, não só a mais recente: costuma
    // chegar 30+ dias depois, com o mês seguinte já pago.
    const isChargeback = status === PaymentStatus.chargeback;
    if (
      !isChargeback &&
      (await this.payments.hasNewerDecisiveCharge(sub.id, charge.id, dueAt, db))
    ) {
      return none('superseded');
    }

    const effect = this.state.effectOfCharge(
      sub,
      { status, dueAt, paidAt: charge.paidAt ?? null },
      now,
      { isLastGenerated: context.isLastGenerated },
    );
    if (effect.kind === 'none') return none('recorded');

    if (effect.kind === 'cancel' && source === 'reconciliation') {
      // Estorno revoga o acesso quando o aviso chega pelo webhook. A
      // reconciliação não cancela por conta própria: ela enxerga também os
      // estornos antigos, de antes desta regra, e cancelar no PSP não tem
      // volta. Avisa uma vez — na próxima passada a cobrança já está
      // registrada como estornada e não volta a ser `held`.
      return none(previous?.status !== status ? 'held' : 'recorded');
    }

    // Só no webhook. A reconciliação escolhe a cobrança a partir da lista do
    // PSP: se houvesse disputa aberta lá, seria ela a cobrança em mãos.
    if (
      effect.kind === 'activate' &&
      source === 'webhook' &&
      (await this.payments.hasOpenChargeback(sub.id, charge.id, db))
    ) {
      return none('recorded');
    }

    return { status, previous, outcome: 'applied', effect };
  }

  /**
   * Estorno pelo webhook: a assinatura do PSP tem de terminar cancelada. Vale
   * tanto para o cancelamento gravado agora quanto para o retry que já encontra
   * a assinatura cancelada — é o caso do PSP ter falhado na tentativa anterior,
   * depois do commit. Cancelar de novo lá é inofensivo.
   */
  private gatewayCancellation(
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    decision: Decision,
    source: ChargeSource,
  ): string | null {
    if (source !== 'webhook' || decision.status !== PaymentStatus.refunded) return null;
    if (decision.outcome === 'superseded') return null;

    const canceled =
      decision.effect.kind === 'cancel' || sub.status === SubscriptionStatus.canceled;
    // O id vem da cobrança quando a linha local ainda não foi vinculada — é o
    // caso do estorno da primeira cobrança.
    return canceled ? (charge.providerSubscriptionId ?? sub.providerSubscriptionId) : null;
  }

  private recordOf(
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    decision: Pick<Decision, 'status' | 'previous'>,
    context: ChargeSyncContext,
  ): UpsertPaymentInput & Record<'dueAt' | 'paidAt' | 'failedAt', Date | null> {
    const { status, previous } = decision;
    const now = context.now ?? new Date();
    return {
      userId: sub.userId,
      subscriptionId: sub.id,
      providerPaymentId: charge.id,
      amount: charge.amount,
      currency: charge.currency,
      status,
      dueAt: charge.dueAt ?? null,
      paidAt: charge.paidAt ?? (status === PaymentStatus.paid ? (previous?.paidAt ?? now) : null),
      failedAt: status === PaymentStatus.failed ? (previous?.failedAt ?? now) : null,
    };
  }

  private alreadyRecorded(
    previous: Payment | null,
    record: ReturnType<ChargeSyncService['recordOf']>,
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

  private async applyEffect(
    tx: Db,
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    decision: Decision,
    source: ChargeSource,
    now: Date,
  ): Promise<void> {
    const { effect, status } = decision;
    const origin = (label: string, reason = `cobrança ${charge.id} em ${status}`) => ({
      actor: source === 'webhook' ? `webhook:${label}` : 'reconciliation',
      reason,
    });
    // A assinatura do PSP a que a cobrança pertence. Gravada em toda transição,
    // não só na ativação: uma linha que foi para `unpaid` ou `canceled` sem o
    // vínculo ficaria fora da reconciliação e sem como achar as cobranças seguintes.
    const providerSubscriptionId = charge.providerSubscriptionId ?? sub.providerSubscriptionId;

    switch (effect.kind) {
      case 'none':
        return;

      case 'activate':
        await this.subscriptions.transitionTo(
          sub.id,
          SubscriptionStatus.active,
          {
            ...origin('payment_succeeded'),
            data: {
              providerSubscriptionId,
              currentPeriodStart: effect.currentPeriodStart,
              currentPeriodEnd: effect.currentPeriodEnd,
              graceUntil: null,
            },
          },
          tx,
        );
        return;

      case 'past_due':
        await this.subscriptions.transitionTo(
          sub.id,
          SubscriptionStatus.past_due,
          {
            ...(effect.lapsed
              ? origin(
                  'period_lapsed',
                  `período pago pela cobrança ${charge.id} terminou sem nova cobrança no PSP`,
                )
              : origin('payment_failed')),
            data: { providerSubscriptionId, graceUntil: effect.graceUntil },
          },
          tx,
        );
        return;

      case 'unpaid':
        await this.subscriptions.transitionTo(
          sub.id,
          SubscriptionStatus.unpaid,
          {
            ...origin(
              status === PaymentStatus.chargeback ? 'payment_chargeback' : 'payment_failed',
            ),
            data: { providerSubscriptionId },
          },
          tx,
        );
        return;

      case 'cancel':
        // O PSP é avisado depois do commit, em `settle`.
        await this.subscriptions.transitionTo(
          sub.id,
          SubscriptionStatus.canceled,
          {
            ...origin('payment_refunded'),
            data: { providerSubscriptionId, canceledAt: now },
          },
          tx,
        );
        return;
    }
  }
}

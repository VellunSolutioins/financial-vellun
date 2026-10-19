import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BillingInterval,
  Payment,
  PaymentStatus,
  Plan,
  Subscription,
  SubscriptionStatus,
} from '@prisma/client';

import { Db, FINANCIAL_TX_OPTIONS, cents, lockSubscription } from '../../common/db';
import { PrismaService } from '../../prisma/prisma.service';
import { InvalidSubscriptionTransitionError } from '../billing.errors';
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
  /**
   * Ciclo da assinatura no PSP. Sem ele, um valor pago que não bate com o
   * plano não troca o plano: o preço sozinho não diz qual foi contratado.
   */
  billingInterval?: BillingInterval | null;
}

export interface ChargeSyncResult {
  outcome: ChargeSyncOutcome;
  /**
   * Assinaturas do PSP a cancelar **depois do commit**: a da cobrança
   * estornada, ou as antigas que a ativação de uma nova substituiu. Ver
   * {@link ChargeSyncService.settle}.
   */
  cancelAtGateway: string[];
  /**
   * Assinaturas locais substituídas, a fechar depois que o PSP confirmar. Ver
   * {@link ChargeSyncService.completeSupersession}.
   */
  superseded: Array<{ subscriptionId: string; reason: string }>;
}

interface Decision {
  status: PaymentStatus;
  previous: Payment | null;
  outcome: ChargeSyncOutcome;
  /** Diferente de `none` só quando `outcome` é `applied`. */
  effect: ChargeEffect;
  /** Plano que a cobrança paga, quando não é o que a assinatura tinha. */
  paidPlan?: Plan;
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
  private readonly logger = new Logger(ChargeSyncService.name);

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

    const now = context.now ?? new Date();
    const decision = await this.decide(tx, sub, charge, source, context);
    await this.applyEffect(tx, sub, charge, decision, source, now);

    const record = this.recordOf(sub, charge, decision, context);
    if (!this.alreadyRecorded(decision.previous, record)) {
      await this.payments.upsertFromProvider(record, tx);
    }

    const refunded = this.refundCancellation(sub, charge, decision, source);
    const superseded = await this.olderLiveSubscriptions(tx, sub, charge, decision, source);

    return {
      outcome: decision.outcome,
      cancelAtGateway: [
        ...(refunded ? [refunded] : []),
        ...superseded.map((row) => row.providerSubscriptionId),
      ],
      superseded: superseded.map((row) => ({
        subscriptionId: row.id,
        reason: `substituída pela assinatura ${sub.id}, paga pela cobrança ${charge.id}`,
      })),
    };
  }

  /**
   * Faz no PSP o que a decisão, já gravada, exige. Quem chama mantém o evento
   * aberto até isto dar certo: se o PSP falhar, o retry volta aqui.
   */
  async settle(result: ChargeSyncResult): Promise<void> {
    for (const providerSubscriptionId of result.cancelAtGateway) {
      await this.provider.cancelSubscription({ providerSubscriptionId, cancelAtPeriodEnd: false });
    }
  }

  /**
   * Fecha, aqui, as assinaturas que {@link settle} acabou de cancelar no PSP.
   *
   * Vem **depois** do PSP de propósito: enquanto ele não confirma, elas seguem
   * abertas aqui, e é isso que faz o retry do evento encontrá-las de novo. Se
   * fossem canceladas antes e o PSP falhasse, nada mais tentaria cancelar lá.
   */
  async completeSupersession(tx: Db, result: ChargeSyncResult, now: Date = new Date()) {
    for (const { subscriptionId, reason } of result.superseded) {
      try {
        await lockSubscription(tx, subscriptionId);
        await this.subscriptions.transitionTo(
          subscriptionId,
          SubscriptionStatus.canceled,
          { actor: 'webhook:superseded', reason, data: { canceledAt: now } },
          tx,
        );
      } catch (error) {
        // Já foi cancelada por outro caminho — o aviso de exclusão do próprio
        // PSP costuma chegar antes de chegarmos aqui.
        if (error instanceof InvalidSubscriptionTransitionError) continue;
        throw error;
      }
    }
  }

  /**
   * Assinaturas **anteriores** do mesmo usuário que ainda cobram em outra
   * assinatura do PSP, quando esta está paga e ativa. É o caso de quem
   * regulariza a inadimplência por um checkout novo: sem cancelar a antiga, as
   * duas seguiriam cobrando.
   *
   * Vale para toda cobrança paga da assinatura ativa, não só a que a ativou:
   * é o que permite ao retry refazer o cancelamento que o PSP recusou. Só pelo
   * webhook — a reconciliação não cancela no PSP por conta própria.
   */
  private async olderLiveSubscriptions(
    tx: Db,
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    decision: Decision,
    source: ChargeSource,
  ): Promise<Array<{ id: string; providerSubscriptionId: string }>> {
    if (source !== 'webhook' || decision.status !== PaymentStatus.paid) return [];
    if (decision.outcome === 'superseded') return [];
    const active =
      decision.effect.kind === 'activate' ||
      (decision.effect.kind === 'none' && sub.status === SubscriptionStatus.active);
    if (!active) return [];

    const current = charge.providerSubscriptionId ?? sub.providerSubscriptionId;
    const older = await tx.subscription.findMany({
      where: {
        userId: sub.userId,
        id: { not: sub.id },
        createdAt: { lt: sub.createdAt },
        providerSubscriptionId: { not: null },
        status: { notIn: [SubscriptionStatus.canceled, SubscriptionStatus.expired] },
      },
      select: { id: true, providerSubscriptionId: true },
    });
    return older.filter(
      (row): row is { id: string; providerSubscriptionId: string } =>
        row.providerSubscriptionId !== null && row.providerSubscriptionId !== current,
    );
  }

  /**
   * O plano que a cobrança paga, na primeira ativação da assinatura.
   *
   * A assinatura `pending` aponta para o último plano escolhido; se o usuário
   * abriu dois checkouts e pagou o primeiro, ela diria "anual" tendo recebido o
   * valor do mensal. Vale o que foi pago, conferido por preço **e** ciclo — só
   * o preço pode coincidir com o de outro produto. Sem um plano ativo, e só um,
   * com os dois, fica o plano da assinatura: o preço pode ter mudado entre o
   * checkout e o pagamento, e isso não é motivo para negar o acesso.
   */
  private async planPaidFor(
    db: Db,
    sub: SubscriptionWithPlan,
    charge: ProviderPayment,
    interval: BillingInterval | null,
  ) {
    const firstActivation = sub.currentPeriodStart === null;
    if (!firstActivation || cents(charge.amount) === cents(sub.plan.price)) return sub.plan;

    const matches = interval
      ? await db.plan.findMany({ where: { isActive: true, price: charge.amount, interval } })
      : [];
    if (matches.length === 1) return matches[0];

    this.logger.warn(
      `Cobrança ${charge.id} de ${charge.amount} não bate com o plano da assinatura ${sub.id} ` +
        `(${sub.plan.code}, ${sub.plan.price.toString()}) nem com um único plano ativo de mesmo ` +
        `ciclo (${interval ?? 'desconhecido'}); mantido o plano da assinatura.`,
    );
    return sub.plan;
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

    // O período é calculado com o ciclo do plano pago, que pode não ser o da assinatura.
    const plan =
      status === PaymentStatus.paid
        ? await this.planPaidFor(db, sub, charge, context.billingInterval ?? null)
        : sub.plan;
    const effect = this.state.effectOfCharge(
      { ...sub, plan },
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

    return {
      status,
      previous,
      outcome: 'applied',
      effect,
      paidPlan: plan.id !== sub.planId ? plan : undefined,
    };
  }

  /**
   * Estorno pelo webhook: a assinatura do PSP tem de terminar cancelada. Vale
   * tanto para o cancelamento gravado agora quanto para o retry que já encontra
   * a assinatura cancelada — é o caso do PSP ter falhado na tentativa anterior,
   * depois do commit. Cancelar de novo lá é inofensivo.
   */
  private refundCancellation(
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
            ...origin(
              'payment_succeeded',
              decision.paidPlan
                ? `cobrança ${charge.id} em ${status}; plano ajustado de ${sub.plan.code} ` +
                    `para ${decision.paidPlan.code}, o que o valor pago corresponde`
                : undefined,
            ),
            data: {
              ...(decision.paidPlan ? { plan: { connect: { id: decision.paidPlan.id } } } : {}),
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

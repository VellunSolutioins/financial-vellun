import { Injectable } from '@nestjs/common';
import { BillingInterval, Prisma, Subscription, SubscriptionStatus } from '@prisma/client';

import { Db } from '../../common/db';
import { PrismaService } from '../../prisma/prisma.service';
import { ConcurrentSubscriptionChangeError } from '../billing.errors';
import { SubscriptionAuditService } from './subscription-audit.service';
import { SubscriptionStateService } from './subscription-state.service';

export interface CreateSubscriptionInput {
  userId: string;
  planId: string;
  status?: SubscriptionStatus;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  trialEndsAt?: Date | null;
  actor?: string;
}

export interface TransitionInput {
  actor: string;
  reason?: string;
  /** Campos da assinatura a atualizar junto com a mudança de estado. */
  data?: Pick<
    Prisma.SubscriptionUpdateInput,
    | 'currentPeriodStart'
    | 'currentPeriodEnd'
    | 'trialEndsAt'
    | 'graceUntil'
    | 'cancelAtPeriodEnd'
    | 'canceledAt'
    | 'providerCustomerId'
    | 'providerSubscriptionId'
    | 'plan'
    | 'lastPaymentFailureAt'
    | 'lastPaymentFailureReason'
  >;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Orquestra persistência de assinaturas usando a máquina de estados
 * ({@link SubscriptionStateService}) e registrando auditoria
 * ({@link SubscriptionAuditService}). Não conhece o PSP.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: SubscriptionStateService,
    private readonly audit: SubscriptionAuditService,
  ) {}

  getActivePlans() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
  }

  async createSubscription(input: CreateSubscriptionInput) {
    const status = input.status ?? SubscriptionStatus.pending;

    const subscription = await this.prisma.subscription.create({
      data: {
        userId: input.userId,
        planId: input.planId,
        status,
        providerCustomerId: input.providerCustomerId ?? null,
        providerSubscriptionId: input.providerSubscriptionId ?? null,
        trialEndsAt:
          input.trialEndsAt ??
          (status === SubscriptionStatus.trialing ? this.state.computeTrialEnd() : null),
      },
    });

    await this.audit.record({
      subscriptionId: subscription.id,
      action: 'created',
      newStatus: status,
      actor: input.actor ?? 'system',
    });

    return subscription;
  }

  /**
   * Prepara a assinatura que será paga no checkout, **antes** de qualquer
   * chamada ao PSP: é o id dela que vai como referência no checkout. Nunca
   * ativa — a ativação só ocorre por webhook validado.
   *
   * Reusa a tentativa anterior do usuário quando ela não chegou a virar
   * assinatura no PSP (`pending` ou `expired`); senão cria uma nova.
   */
  async prepareCheckoutSubscription(
    userId: string,
    planId: string,
    providerCustomerId: string | null,
  ) {
    const existing = await this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const customer = providerCustomerId ? { providerCustomerId } : {};

    // Só se reusa a tentativa que o PSP ainda não transformou em assinatura.
    // Com uma assinatura do PSP já ligada (o aviso de criação chega antes do
    // pagamento, que pode estar em análise), o pagamento do checkout novo
    // viria de OUTRA assinatura e não acharia esta linha.
    const reusable =
      existing &&
      !existing.providerSubscriptionId &&
      (existing.status === SubscriptionStatus.pending ||
        existing.status === SubscriptionStatus.expired);

    if (reusable) {
      // O checkout anterior sai da linha: os dados são dele, e o aviso de que
      // ele venceu ou foi cancelado, chegando agora, expiraria a tentativa nova.
      // Se ele ainda for pago, a cobrança acha a linha pelo cliente.
      const fresh = {
        planId,
        providerCheckoutId: null,
        checkoutExpiresAt: null,
        cancelAtPeriodEnd: false,
        ...customer,
      };
      // Condicional: se a varredura de checkouts vencidos ou um pagamento mudou
      // a linha desde a leitura, ela não é mais reusável e nasce outra.
      const { count } = await this.prisma.subscription.updateMany({
        where: { id: existing.id, status: existing.status, providerSubscriptionId: null },
        data: fresh,
      });
      if (count === 1 && existing.status === SubscriptionStatus.pending) {
        return this.prisma.subscription.findUniqueOrThrow({ where: { id: existing.id } });
      }
      if (count === 1) {
        try {
          return await this.transitionTo(existing.id, SubscriptionStatus.pending, {
            actor: 'checkout',
            reason: 'nova tentativa depois de checkout expirado',
          });
        } catch (error) {
          if (!(error instanceof ConcurrentSubscriptionChangeError)) throw error;
        }
      }
    }

    return this.createSubscription({
      userId,
      planId,
      status: SubscriptionStatus.pending,
      providerCustomerId,
      actor: 'checkout',
    });
  }

  /**
   * Grava o cliente do PSP assim que ele existe. Deixado para o fim do
   * checkout, uma falha no meio perderia o vínculo com o cliente já criado.
   */
  attachCustomer(subscriptionId: string, providerCustomerId: string) {
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { providerCustomerId },
    });
  }

  /** Liga a assinatura ao checkout aberto: é por ele que a primeira cobrança a encontra. */
  attachCheckout(
    subscriptionId: string,
    checkout: { providerCheckoutId: string; expiresAt: Date | null },
  ) {
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        providerCheckoutId: checkout.providerCheckoutId,
        checkoutExpiresAt: checkout.expiresAt,
      },
    });
  }

  /**
   * Expira a tentativa de checkout que não vai mais receber pagamento. Só mexe
   * em assinatura `pending`: se ela já saiu desse estado (o pagamento chegou),
   * não há o que expirar. Devolve se expirou.
   */
  async expireCheckout(subscriptionId: string, actor: string, reason: string, db?: Db) {
    const client = db ?? this.prisma;
    const current = await client.subscription.findUnique({ where: { id: subscriptionId } });
    if (current?.status !== SubscriptionStatus.pending) return false;

    try {
      await this.transitionTo(subscriptionId, SubscriptionStatus.expired, { actor, reason }, db);
      return true;
    } catch (error) {
      // Pagou entre a leitura e a escrita: deixou de estar `pending`.
      if (error instanceof ConcurrentSubscriptionChangeError) return false;
      throw error;
    }
  }

  /**
   * Ativa diretamente uma assinatura de plano gratuito (ex.: "Local Dev Active",
   * uso interno/testes), sem passar pelo PSP — o Asaas recusa cobranças abaixo
   * de R$ 5,00, então checkout/webhook nunca entrariam em jogo para R$ 0,00.
   */
  async activateFreeSubscription(
    userId: string,
    planId: string,
    interval: BillingInterval,
    actor: string,
  ) {
    const subscription = await this.createSubscription({
      userId,
      planId,
      status: SubscriptionStatus.pending,
      actor,
    });

    const start = new Date();
    return this.transitionTo(subscription.id, SubscriptionStatus.active, {
      actor,
      reason: 'plano gratuito: ativação automática sem cobrança',
      data: {
        currentPeriodStart: start,
        currentPeriodEnd: this.state.computePeriodEnd(start, interval),
      },
    });
  }

  /**
   * Marca cancelamento ao fim do período já pago (`cancelAtPeriodEnd = true`),
   * preservando o status atual e o acesso até `currentPeriodEnd`.
   */
  async scheduleCancellation(subscriptionId: string, actor: string) {
    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { cancelAtPeriodEnd: true },
    });

    await this.audit.record({
      subscriptionId,
      action: 'cancel_scheduled',
      previousStatus: updated.status,
      newStatus: updated.status,
      actor,
    });

    return updated;
  }

  /**
   * Aplica uma transição de estado validada e registra a auditoria. Rejeita
   * transições inválidas via {@link SubscriptionStateService.assertTransition}.
   *
   * A mudança e a auditoria vão no mesmo commit: no `db` de quem chamou, quando
   * já existe uma transação (o webhook, com a cobrança e o evento juntos), ou
   * numa transação própria.
   */
  async transitionTo(
    subscriptionId: string,
    to: SubscriptionStatus,
    input: TransitionInput,
    db?: Db,
  ) {
    if (db) return this.applyTransition(db, subscriptionId, to, input);
    return this.prisma.$transaction((tx) => this.applyTransition(tx, subscriptionId, to, input));
  }

  private async applyTransition(
    db: Db,
    subscriptionId: string,
    to: SubscriptionStatus,
    input: TransitionInput,
  ) {
    const current = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

    this.state.assertTransition(current.status, to);

    // `status` no `where`: se outra escrita mudou o estado depois da leitura
    // acima, nada é gravado. Um `update` só por id deixaria valer a última
    // escrita, com a transição validada contra um estado que já não existe.
    let updated: Subscription;
    try {
      updated = await db.subscription.update({
        where: { id: subscriptionId, status: current.status },
        data: { status: to, ...input.data },
      });
    } catch (error) {
      // P2025: nenhuma linha com esse id E esse status.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConcurrentSubscriptionChangeError(subscriptionId, current.status);
      }
      throw error;
    }

    await this.audit.record(
      {
        subscriptionId,
        action: `transition:${current.status}->${to}`,
        previousStatus: current.status,
        newStatus: to,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata,
      },
      db,
    );

    return updated;
  }
}

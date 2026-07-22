import { Injectable } from '@nestjs/common';
import { BillingInterval, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
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

  getUserSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
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
   * Prepara a assinatura que será paga no checkout. Reusa a assinatura `pending`
   * mais recente do usuário (atualizando plano/cliente) ou cria uma nova. Nunca
   * ativa — a ativação só ocorre por webhook validado.
   */
  async prepareCheckoutSubscription(
    userId: string,
    planId: string,
    providerCustomerId: string,
  ) {
    const existing = await this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (existing && existing.status === SubscriptionStatus.pending) {
      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: { planId, providerCustomerId },
      });
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
   */
  async transitionTo(subscriptionId: string, to: SubscriptionStatus, input: TransitionInput) {
    const current = await this.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });

    this.state.assertTransition(current.status, to);

    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: to, ...input.data },
    });

    await this.audit.record({
      subscriptionId,
      action: `transition:${current.status}->${to}`,
      previousStatus: current.status,
      newStatus: to,
      actor: input.actor,
      reason: input.reason,
      metadata: input.metadata,
    });

    return updated;
  }
}

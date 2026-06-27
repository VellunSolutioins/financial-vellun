import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

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

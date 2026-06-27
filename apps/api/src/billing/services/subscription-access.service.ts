import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export type SubscriptionAccessReason =
  | 'active'
  | 'trialing'
  | 'grace_period'
  | 'no_subscription'
  | 'trial_expired'
  | 'grace_expired'
  | 'inactive';

/** Resultado tipado da regra central de acesso comercial. */
export interface SubscriptionAccess {
  allowed: boolean;
  reason: SubscriptionAccessReason;
  status: SubscriptionStatus | null;
  subscriptionId: string | null;
}

/**
 * Regra central de autorização comercial (doc seção 5). Decide se um usuário
 * pode usar o produto. Reutilizável por API (guard) e canal interno (IA).
 */
@Injectable()
export class SubscriptionAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async canUseProduct(userId: string, now: Date = new Date()): Promise<SubscriptionAccess> {
    // Considera a assinatura mais recente do usuário como fonte de verdade.
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return this.evaluate(subscription, now);
  }

  /** Avalia o acesso a partir de uma assinatura já carregada (sem I/O). */
  evaluate(
    subscription: {
      id: string;
      status: SubscriptionStatus;
      trialEndsAt: Date | null;
      graceUntil: Date | null;
    } | null,
    now: Date = new Date(),
  ): SubscriptionAccess {
    if (!subscription) {
      return { allowed: false, reason: 'no_subscription', status: null, subscriptionId: null };
    }

    const base = { status: subscription.status, subscriptionId: subscription.id };

    switch (subscription.status) {
      case SubscriptionStatus.active:
        return { allowed: true, reason: 'active', ...base };

      case SubscriptionStatus.trialing:
        if (subscription.trialEndsAt && subscription.trialEndsAt > now) {
          return { allowed: true, reason: 'trialing', ...base };
        }
        return { allowed: false, reason: 'trial_expired', ...base };

      case SubscriptionStatus.past_due:
        if (subscription.graceUntil && subscription.graceUntil > now) {
          return { allowed: true, reason: 'grace_period', ...base };
        }
        return { allowed: false, reason: 'grace_expired', ...base };

      default:
        return { allowed: false, reason: 'inactive', ...base };
    }
  }
}

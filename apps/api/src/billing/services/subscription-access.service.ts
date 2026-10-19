import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

/** Estados em que uma assinatura pode dar acesso (dependendo das datas). */
const ACCESS_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.active,
  SubscriptionStatus.trialing,
  SubscriptionStatus.past_due,
];

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Feature flag de rollout (doc Fase 7). Quando `BILLING_ENFORCEMENT_ENABLED`
   * é `false`, a obrigatoriedade de assinatura fica desligada (soft launch) —
   * usado para ativação progressiva da regra em produção. Default: habilitado.
   */
  isEnforced(): boolean {
    return this.config.get<string>('BILLING_ENFORCEMENT_ENABLED', 'true') !== 'false';
  }

  async canUseProduct(userId: string, now: Date = new Date()): Promise<SubscriptionAccess> {
    return this.evaluate(await this.pick(userId, now), now);
  }

  /**
   * A assinatura que vale para o usuário, com o plano: a que dá acesso hoje e,
   * não havendo, a mais recente.
   *
   * Não é simplesmente a mais recente. Quem regulariza a inadimplência abre um
   * checkout novo, e isso cria outra assinatura, `pending`, mais nova que a que
   * ainda está no grace. Olhando só a mais nova, clicar em "regularizar"
   * tiraria o acesso na hora — e desistir do checkout o tiraria de vez.
   */
  async currentSubscription(userId: string, now: Date = new Date()) {
    const chosen = await this.pick(userId, now);
    if (!chosen) return null;
    return this.prisma.subscription.findUnique({
      where: { id: chosen.id },
      include: { plan: true },
    });
  }

  /**
   * Roda a cada requisição do produto (guard e canal interno): lê só as
   * assinaturas que podem dar acesso, sem o plano, e só cai na mais recente
   * de todas quando nenhuma delas dá.
   */
  private async pick(userId: string, now: Date) {
    const candidates = await this.prisma.subscription.findMany({
      where: { userId, status: { in: ACCESS_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    const allowed = candidates.find((subscription) => this.evaluate(subscription, now).allowed);
    if (allowed) return allowed;
    return this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
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

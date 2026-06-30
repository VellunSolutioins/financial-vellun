import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { ALLOW_WITHOUT_SUBSCRIPTION } from '../decorators/allow-without-subscription.decorator';
import { SubscriptionAccessService } from '../services/subscription-access.service';
import { SubscriptionRequiredException } from '../subscription-required.exception';

/**
 * Centraliza a regra de assinatura na API. Deve ser aplicado **após** o
 * `JwtAuthGuard` (que popula `req.user`). Rotas marcadas com
 * `@AllowWithoutSubscription()` são liberadas. Inadimplente em grace continua
 * liberado (decidido pelo {@link SubscriptionAccessService}).
 */
@Injectable()
export class ActiveSubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: SubscriptionAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowWithout = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_SUBSCRIPTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowWithout) return true;

    // Rollout: com a obrigatoriedade desligada, libera todos (soft launch).
    if (!this.access.isEnforced()) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { id?: string } | undefined;
    if (!user?.id) {
      // Identidade não resolvida (guard aplicado sem JwtAuthGuard antes).
      throw new ForbiddenException();
    }

    const access = await this.access.canUseProduct(user.id);
    if (!access.allowed) {
      throw new SubscriptionRequiredException();
    }

    return true;
  }
}

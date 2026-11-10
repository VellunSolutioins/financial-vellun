import type { FeatureKey } from '@financial-vellun/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRED_FEATURE } from '../decorators/require-feature.decorator';
import { FeatureDisabledException } from '../feature-disabled.exception';
import { FeatureFlagsService } from '../feature-flags.service';

/**
 * Bloqueia rotas de funcionalidade desligada no /ops.
 *
 * É a proteção de verdade: o web esconde o menu e redireciona a rota, mas só a
 * API garante que ninguém leia ou grave dados da funcionalidade pela URL ou
 * chamando o endpoint direto. Rotas sem `@RequireFeature()` passam.
 */
@Injectable()
export class FeatureEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(REQUIRED_FEATURE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;

    if (!(await this.flags.isEnabled(feature))) {
      throw new FeatureDisabledException();
    }
    return true;
  }
}

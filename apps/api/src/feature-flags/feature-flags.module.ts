import { Module } from '@nestjs/common';

import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureEnabledGuard } from './guards/feature-enabled.guard';

/**
 * Feature flags globais do app: leitura do estado e o guard que bloqueia as
 * rotas de funcionalidade desligada. A escrita fica no módulo de operações
 * (`ops/feature-flags`), que é quem tem identidade de operador e auditoria.
 */
@Module({
  controllers: [FeatureFlagsController],
  providers: [FeatureFlagsService, FeatureEnabledGuard],
  exports: [FeatureFlagsService, FeatureEnabledGuard],
})
export class FeatureFlagsModule {}

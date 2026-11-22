import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RequireFeature } from '../../feature-flags/decorators/require-feature.decorator';
import { FeatureEnabledGuard } from '../../feature-flags/guards/feature-enabled.guard';
import { InternalApiKeyGuard } from '../guards/internal-api-key.guard';
import { InternalActionsService } from '../internal-actions.service';
import { SummaryQueryDto } from '../dto/summary-query.dto';

/**
 * Ações do agente de WhatsApp (docs/plans/018). Cada grupo de rotas fica
 * atrás de uma feature flag: desligada, a rota responde `403 FEATURE_DISABLED`
 * e o agente manda o usuário para o app.
 */
@SkipThrottle()
@ApiExcludeController()
@UseGuards(InternalApiKeyGuard, FeatureEnabledGuard)
@Controller('internal/users/:userId')
export class InternalActionsController {
  constructor(private actions: InternalActionsService) {}

  @RequireFeature('whatsapp_summary')
  @Get('summary')
  summary(@Param('userId') userId: string, @Query() query: SummaryQueryDto) {
    return this.actions.summary(userId, query);
  }
}

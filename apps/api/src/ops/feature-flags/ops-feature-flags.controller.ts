import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsRole } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsRoles } from '../auth/decorators/ops-roles.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';
import { FeatureFlagView, OpsFeatureFlagsService } from './ops-feature-flags.service';

/** Leitura aberta a qualquer operador ativo; ligar e desligar só `ops_admin`. */
@ApiExcludeController()
@Controller('ops/feature-flags')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsFeatureFlagsController {
  constructor(private readonly featureFlags: OpsFeatureFlagsService) {}

  @Get()
  list(): Promise<FeatureFlagView[]> {
    return this.featureFlags.list();
  }

  @Patch(':key')
  @OpsRoles(OpsRole.ops_admin)
  update(
    @Param('key') key: string,
    @Body() dto: UpdateFeatureFlagDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<FeatureFlagView> {
    return this.featureFlags.update(key, dto, actor);
  }
}

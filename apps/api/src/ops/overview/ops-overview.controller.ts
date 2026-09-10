import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { OpsOverview, OpsOverviewService } from './ops-overview.service';

/**
 * Resumo do painel. Sem `@OpsRoles`: é leitura, e todo operador ativo é no
 * mínimo `viewer`.
 */
@ApiExcludeController()
@Controller('ops/overview')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsOverviewController {
  constructor(private readonly overview: OpsOverviewService) {}

  @Get()
  get(): Promise<OpsOverview> {
    return this.overview.build();
  }
}

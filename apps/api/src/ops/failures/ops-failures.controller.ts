import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsFailureStatus } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { ListFailuresDto } from './dto/list-failures.dto';
import {
  FailureDetail,
  FailureListItem,
  OpsFailuresQueryService,
  Paginated,
} from './ops-failures-query.service';

/**
 * Leitura do catálogo de falhas.
 *
 * Sem `@OpsRoles`: ler é permitido a qualquer operador ativo, inclusive `viewer`.
 * O que separa os papéis é **agir** — reprocessar e descartar entram na Entrega 7
 * e exigem `operator`. Ver o payload em claro é ortogonal ao papel: depende de
 * `canViewSensitive`, e o próprio serviço aplica.
 */
@ApiExcludeController()
@Controller('ops/failures')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsFailuresController {
  constructor(private readonly failures: OpsFailuresQueryService) {}

  @Get()
  list(@Query() filtros: ListFailuresDto): Promise<Paginated<FailureListItem>> {
    return this.failures.list(filtros);
  }

  @Get('summary')
  summary(): Promise<Record<OpsFailureStatus, number>> {
    return this.failures.countByStatus();
  }

  @Get(':id')
  detail(
    @Param('id') id: string,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<FailureDetail> {
    return this.failures.detail(id, operator);
  }
}

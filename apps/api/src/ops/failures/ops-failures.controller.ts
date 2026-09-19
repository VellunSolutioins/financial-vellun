import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsFailureStatus, OpsRole } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsRoles } from '../auth/decorators/ops-roles.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { BatchReprocessDto, FailureActionDto } from './dto/failure-action.dto';
import { ListFailuresDto } from './dto/list-failures.dto';
import {
  OpsFailuresActionsService,
  ReprocessBatchResult,
  ReprocessItemResult,
} from './ops-failures-actions.service';
import {
  FailureDetail,
  FailureListItem,
  OpsFailuresQueryService,
  Paginated,
} from './ops-failures-query.service';

/**
 * Catálogo de falhas: leitura para qualquer operador ativo, ação por papel.
 *
 * A escada de permissão é deliberada e está declarada rota a rota:
 *
 * - **ler** — qualquer operador ativo, inclusive `viewer`;
 * - **reprocessar** — `operator` ou `ops_admin`. Republicar é recuperável: se
 *   der errado, a mensagem volta ao catálogo como falha nova;
 * - **descartar** — só `ops_admin`. É a decisão de que aquela mensagem do
 *   cliente não vai ser atendida, e ela não volta atrás.
 *
 * Ver o payload em claro é ortogonal ao papel: depende de `canViewSensitive`, e
 * quem aplica é o próprio serviço de leitura.
 */
@ApiExcludeController()
@Controller('ops/failures')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsFailuresController {
  constructor(
    private readonly failures: OpsFailuresQueryService,
    private readonly actions: OpsFailuresActionsService,
  ) {}

  @Get()
  list(@Query() filtros: ListFailuresDto): Promise<Paginated<FailureListItem>> {
    return this.failures.list(filtros);
  }

  @Get('summary')
  summary(): Promise<Record<OpsFailureStatus, number>> {
    return this.failures.countByStatus();
  }

  /**
   * Lote. Declarado **antes** de `:id/...` porque o Nest casa por ordem, e
   * `reprocess` cairia no parâmetro de rota.
   */
  @Post('reprocess')
  @OpsRoles(OpsRole.operator, OpsRole.ops_admin)
  reprocessBatch(
    @Body() dto: BatchReprocessDto,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<ReprocessBatchResult> {
    return this.actions.reprocessMany(dto.ids, dto.reason, operator);
  }

  @Get(':id')
  detail(
    @Param('id') id: string,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<FailureDetail> {
    return this.failures.detail(id, operator);
  }

  @Post(':id/reprocess')
  @OpsRoles(OpsRole.operator, OpsRole.ops_admin)
  reprocess(
    @Param('id') id: string,
    @Body() dto: FailureActionDto,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<ReprocessItemResult> {
    return this.actions.reprocessOne(id, dto.reason, operator);
  }

  @Post(':id/discard')
  @OpsRoles(OpsRole.ops_admin)
  discard(
    @Param('id') id: string,
    @Body() dto: FailureActionDto,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<{ id: string; status: OpsFailureStatus }> {
    return this.actions.discard(id, dto.reason, operator);
  }
}

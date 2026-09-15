import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsRole, WebhookEventStatus } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsRoles } from '../auth/decorators/ops-roles.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { FailureActionDto } from '../failures/dto/failure-action.dto';
import { Paginated } from '../failures/ops-failures-query.service';
import { ListPaymentsDto } from './dto/list-payments.dto';
import { OpsPaymentsActionsService, RecoverResult } from './ops-payments-actions.service';
import {
  OpsPaymentsQueryService,
  PaymentEventDetail,
  PaymentEventListItem,
} from './ops-payments-query.service';

/**
 * Eventos de webhook de pagamento: leitura para qualquer operador ativo,
 * recuperação para `operator` ou `ops_admin`.
 *
 * Não há descarte aqui, e isso é deliberado: descartar um evento de pagamento
 * significaria decidir que um dinheiro que entrou não será reconhecido. O que
 * existe é recuperar — e só o que já esgotou o retry.
 */
@ApiExcludeController()
@Controller('ops/payments')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsPaymentsController {
  constructor(
    private readonly payments: OpsPaymentsQueryService,
    private readonly actions: OpsPaymentsActionsService,
  ) {}

  @Get()
  list(@Query() filtros: ListPaymentsDto): Promise<Paginated<PaymentEventListItem>> {
    return this.payments.list(filtros);
  }

  @Get('summary')
  summary(): Promise<Record<WebhookEventStatus, number>> {
    return this.payments.countByStatus();
  }

  @Post(':id/recover')
  @OpsRoles(OpsRole.operator, OpsRole.ops_admin)
  recover(
    @Param('id') id: string,
    @Body() dto: FailureActionDto,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<RecoverResult> {
    return this.actions.recover(id, dto.reason, operator);
  }

  @Get(':id')
  detail(
    @Param('id') id: string,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<PaymentEventDetail> {
    return this.payments.detail(id, operator);
  }
}

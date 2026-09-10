import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { WebhookEventStatus } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { Paginated } from '../failures/ops-failures-query.service';
import { ListPaymentsDto } from './dto/list-payments.dto';
import {
  OpsPaymentsQueryService,
  PaymentEventDetail,
  PaymentEventListItem,
} from './ops-payments-query.service';

/**
 * Leitura dos eventos de webhook de pagamento.
 *
 * Sem `@OpsRoles`, como o catálogo de falhas: ler é de qualquer operador ativo;
 * o que separa papel é agir — e agir sobre pagamento é a Entrega 8.
 */
@ApiExcludeController()
@Controller('ops/payments')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsPaymentsController {
  constructor(private readonly payments: OpsPaymentsQueryService) {}

  @Get()
  list(@Query() filtros: ListPaymentsDto): Promise<Paginated<PaymentEventListItem>> {
    return this.payments.list(filtros);
  }

  @Get('summary')
  summary(): Promise<Record<WebhookEventStatus, number>> {
    return this.payments.countByStatus();
  }

  @Get(':id')
  detail(
    @Param('id') id: string,
    @CurrentOperator() operator: CurrentOpsOperator,
  ): Promise<PaymentEventDetail> {
    return this.payments.detail(id, operator);
  }
}

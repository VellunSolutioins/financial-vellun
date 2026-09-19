import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsRole } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsRoles } from '../auth/decorators/ops-roles.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { UpdateOperatorDto } from './dto/update-operator.dto';
import { OperatorView, OpsOperatorsService } from './ops-operators.service';

@ApiExcludeController()
@Controller('ops/operators')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
@OpsRoles(OpsRole.ops_admin)
export class OpsOperatorsController {
  constructor(private readonly operators: OpsOperatorsService) {}

  @Get()
  list(): Promise<OperatorView[]> {
    return this.operators.list();
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOperatorDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<OperatorView> {
    return this.operators.update(id, dto, actor);
  }
}

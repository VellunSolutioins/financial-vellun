import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsRole } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsRoles } from '../auth/decorators/ops-roles.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { CreatePlanDto, DeletePlanDto, UpdatePlanDto } from './dto/plan.dto';
import { OpsPlansService, PlanView } from './ops-plans.service';

/** Leitura aberta a qualquer operador ativo; cadastrar, editar e excluir só `ops_admin`. */
@ApiExcludeController()
@Controller('ops/plans')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsPlansController {
  constructor(private readonly plans: OpsPlansService) {}

  @Get()
  list(): Promise<PlanView[]> {
    return this.plans.list();
  }

  @Post()
  @OpsRoles(OpsRole.ops_admin)
  create(
    @Body() dto: CreatePlanDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<PlanView> {
    return this.plans.create(dto, actor);
  }

  @Patch(':id')
  @OpsRoles(OpsRole.ops_admin)
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<PlanView> {
    return this.plans.update(id, dto, actor);
  }

  @Delete(':id')
  @OpsRoles(OpsRole.ops_admin)
  async remove(
    @Param('id') id: string,
    @Body() dto: DeletePlanDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<{ deleted: true }> {
    await this.plans.remove(id, dto.reason, actor);
    return { deleted: true };
  }
}

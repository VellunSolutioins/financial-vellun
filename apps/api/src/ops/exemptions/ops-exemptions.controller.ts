import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsRole } from '@prisma/client';

import { CurrentOperator, CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsRoles } from '../auth/decorators/ops-roles.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { CreateExemptionDto, DeleteExemptionDto, UpdateExemptionDto } from './dto/exemption.dto';
import { ExemptionView, OpsExemptionsService } from './ops-exemptions.service';

/**
 * Só `ops_admin`, inclusive a leitura: a lista mostra o telefone inteiro de
 * sócios e equipe — mesma postura da tela de operadores.
 */
@ApiExcludeController()
@Controller('ops/exemptions')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
@OpsRoles(OpsRole.ops_admin)
export class OpsExemptionsController {
  constructor(private readonly exemptions: OpsExemptionsService) {}

  @Get()
  list(): Promise<ExemptionView[]> {
    return this.exemptions.list();
  }

  @Post()
  create(
    @Body() dto: CreateExemptionDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<ExemptionView> {
    return this.exemptions.create(dto, actor);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExemptionDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<ExemptionView> {
    return this.exemptions.update(id, dto, actor);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Body() dto: DeleteExemptionDto,
    @CurrentOperator() actor: CurrentOpsOperator,
  ): Promise<{ deleted: true }> {
    await this.exemptions.remove(id, dto.reason, actor);
    return { deleted: true };
  }
}

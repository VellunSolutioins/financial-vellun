import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpsRole } from '@prisma/client';

import { OpsRoles } from '../auth/decorators/ops-roles.decorator';
import { OpsAuthGuard } from '../auth/guards/ops-auth.guard';
import { OpsRolesGuard } from '../auth/guards/ops-roles.guard';
import { Paginated } from '../failures/ops-failures-query.service';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { ListAuditDto } from './dto/list-audit.dto';
import { AuditEntry, AuditEntryDetail, OpsAuditQueryService } from './ops-audit-query.service';

/**
 * Leitura da trilha de auditoria.
 *
 * A listagem é aberta a **qualquer operador ativo**, e isso é deliberado: a
 * trilha existe para que uma ação possa ser conferida, e restringi-la a
 * `ops_admin` significaria que só quem administra permissões pode verificar quem
 * viu dado sensível. O detalhe com estado anterior e posterior é que fica com
 * `ops_admin`, porque carrega o retrato do alvo.
 */
@ApiExcludeController()
@Controller('ops/audit')
@UseGuards(OpsAuthGuard, OpsRolesGuard)
export class OpsAuditController {
  constructor(private readonly audit: OpsAuditQueryService) {}

  @Get()
  list(@Query() filtros: ListAuditDto): Promise<Paginated<AuditEntry>> {
    return this.audit.list(filtros);
  }

  /**
   * Vocabulário da trilha, para montar os filtros.
   *
   * Vem das constantes, não de um `SELECT DISTINCT`: o conjunto de ações é
   * fechado pelo código, e derivá-lo do banco faria uma ação sumir do filtro
   * justamente enquanto nunca tivesse acontecido — que é quando procurá-la
   * importa.
   */
  @Get('vocabulary')
  vocabulary(): { actions: string[]; targetTypes: string[] } {
    return {
      actions: Object.values(OPS_AUDIT_ACTIONS),
      targetTypes: Object.values(OPS_AUDIT_TARGETS),
    };
  }

  @Get(':id')
  @OpsRoles(OpsRole.ops_admin)
  detail(@Param('id') id: string): Promise<AuditEntryDetail> {
    return this.audit.detail(id);
  }
}

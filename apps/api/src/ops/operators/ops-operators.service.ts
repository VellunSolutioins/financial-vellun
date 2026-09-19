import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsOperator, OpsRole, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { UpdateOperatorDto } from './dto/update-operator.dto';

/** Operador como devolvido pela API. */
export interface OperatorView {
  id: string;
  githubLogin: string;
  name: string | null;
  email: string | null;
  role: OpsRole;
  canViewSensitive: boolean;
  active: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** Campos expostos. `githubUserId` fica fora: é identificador interno. */
const OPERATOR_SELECT = {
  id: true,
  githubLogin: true,
  name: true,
  email: true,
  role: true,
  canViewSensitive: true,
  active: true,
  createdAt: true,
  lastLoginAt: true,
} satisfies Prisma.OpsOperatorSelect;

@Injectable()
export class OpsOperatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
  ) {}

  async list(): Promise<OperatorView[]> {
    return this.prisma.opsOperator.findMany({
      select: OPERATOR_SELECT,
      orderBy: [{ active: 'desc' }, { githubLogin: 'asc' }],
    });
  }

  /**
   * Altera papel, ativação e permissão de dado sensível.
   *
   * A auditoria grava o **antes e o depois**, e é escrita na mesma transação da
   * alteração: uma promoção sem linha de auditoria é pior que uma promoção que
   * falhou, porque ninguém a vê. Por isso {@link OpsAuditService.record}, e não
   * a variante best-effort.
   */
  async update(
    id: string,
    dto: UpdateOperatorDto,
    actor: CurrentOpsOperator,
  ): Promise<OperatorView> {
    const before = await this.prisma.opsOperator.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Operador não encontrado.');

    this.assertNotSelfDemotion(before, dto, actor);

    const data = {
      role: dto.role ?? undefined,
      active: dto.active ?? undefined,
      canViewSensitive: dto.canViewSensitive ?? undefined,
    };
    if (Object.values(data).every((value) => value === undefined)) {
      throw new BadRequestException('Nada a alterar.');
    }

    return this.prisma.$transaction(async (tx) => {
      const after = await tx.opsOperator.update({ where: { id }, data, select: OPERATOR_SELECT });

      await tx.opsAuditLog.create({
        data: {
          operatorId: actor.id,
          action: OPS_AUDIT_ACTIONS.operatorPromoted,
          targetType: OPS_AUDIT_TARGETS.operator,
          targetId: id,
          reason: dto.reason,
          result: OpsAuditResult.success,
          operationId: this.audit.newOperationId(),
          beforeState: this.permissionsOf(before),
          afterState: this.permissionsOf(after),
        },
      });

      return after;
    });
  }

  /**
   * Impede que o último `ops_admin` se tranque fora.
   *
   * Um admin removendo o próprio papel (ou se desativando) sem outro admin ativo
   * deixaria a área sem ninguém capaz de conceder acesso — e a única saída seria
   * mexer no banco à mão. A restrição vale só para si mesmo: rebaixar **outro**
   * admin continua permitido, desde que sobre um ativo.
   */
  private assertNotSelfDemotion(
    target: OpsOperator,
    dto: UpdateOperatorDto,
    actor: CurrentOpsOperator,
  ): void {
    if (target.id !== actor.id) return;

    const losesAdmin = dto.role !== undefined && dto.role !== OpsRole.ops_admin;
    const losesAccess = dto.active === false;
    if (!losesAdmin && !losesAccess) return;

    throw new BadRequestException(
      'Um ops_admin não pode remover o próprio acesso. Peça a outro ops_admin.',
    );
  }

  private permissionsOf(operator: {
    role: OpsRole;
    active: boolean;
    canViewSensitive: boolean;
  }): Prisma.InputJsonValue {
    return {
      role: operator.role,
      active: operator.active,
      canViewSensitive: operator.canViewSensitive,
    };
  }
}

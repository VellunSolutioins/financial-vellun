import { Injectable, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { Paginated } from '../failures/ops-failures-query.service';
import { ListAuditDto } from './dto/list-audit.dto';

/**
 * Uma linha da trilha, com o operador já resolvido.
 *
 * Devolve `githubLogin` em vez de só `operatorId` porque a pergunta que a tela
 * responde é "quem fez", e um UUID não responde isso.
 */
export interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  result: OpsAuditResult;
  operationId: string;
  createdAt: Date;
  operator: { id: string; githubLogin: string };
}

export interface AuditEntryDetail extends AuditEntry {
  beforeState: Prisma.JsonValue | null;
  afterState: Prisma.JsonValue | null;
}

const LIST_SELECT = {
  id: true,
  action: true,
  targetType: true,
  targetId: true,
  reason: true,
  result: true,
  operationId: true,
  createdAt: true,
  operator: { select: { id: true, githubLogin: true } },
} satisfies Prisma.OpsAuditLogSelect;

/**
 * Leitura da trilha append-only.
 *
 * **Só leitura, e por construção.** `OpsAuditService` escreve e não expõe
 * `update` nem `delete`; esta classe lê e não expõe escrita nenhuma. A garantia
 * de fato, porém, não depende de disciplina de código: a migration instala
 * triggers que recusam `UPDATE`, `DELETE` e `TRUNCATE` na tabela.
 */
@Injectable()
export class OpsAuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filtros: ListAuditDto): Promise<Paginated<AuditEntry>> {
    const page = filtros.page ?? 1;
    const pageSize = filtros.pageSize ?? 10;
    const where = this.buildWhere(filtros);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.opsAuditLog.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.opsAuditLog.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Detalhe com estado anterior e posterior.
   *
   * Separado da listagem porque `beforeState`/`afterState` guardam o retrato do
   * alvo — permissões concedidas, campos alterados — e isso não precisa trafegar
   * em toda página de lista. O controller restringe esta rota a `ops_admin`.
   */
  async detail(id: string): Promise<AuditEntryDetail> {
    const row = await this.prisma.opsAuditLog.findUnique({
      where: { id },
      select: { ...LIST_SELECT, beforeState: true, afterState: true },
    });
    if (!row) throw new NotFoundException('Registro de auditoria não encontrado.');

    return row;
  }

  private buildWhere(filtros: ListAuditDto): Prisma.OpsAuditLogWhereInput {
    const where: Prisma.OpsAuditLogWhereInput = {};

    if (filtros.operatorId) where.operatorId = filtros.operatorId;
    if (filtros.action) where.action = filtros.action;
    if (filtros.targetType) where.targetType = filtros.targetType;
    if (filtros.targetId) where.targetId = filtros.targetId;
    if (filtros.operationId) where.operationId = filtros.operationId;
    if (filtros.result) where.result = filtros.result;

    if (filtros.from || filtros.to) {
      where.createdAt = {
        ...(filtros.from ? { gte: new Date(filtros.from) } : {}),
        ...(filtros.to ? { lte: new Date(filtros.to) } : {}),
      };
    }

    return where;
  }
}

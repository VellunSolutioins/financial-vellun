import { Injectable, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsFailureSource, OpsFailureStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OpsGrafanaService } from '../grafana/ops-grafana.service';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { ListFailuresDto } from './dto/list-failures.dto';
import { maskFailurePayload } from './failure-masking';

/** Uma falha na listagem. Sem `payload`: a lista não precisa dele. */
export interface FailureListItem {
  id: string;
  source: OpsFailureSource;
  sourceQueue: string;
  status: OpsFailureStatus;
  errorType: string;
  errorMessage: string;
  attempts: number;
  permanent: boolean;
  correlationId: string | null;
  phoneHash: string | null;
  firstFailedAt: Date | null;
  failedAt: Date;
  capturedAt: Date;
}

export interface FailureDetail extends FailureListItem {
  providerMessageId: string | null;
  jobId: string | null;
  payload: unknown;
  /** `false` quando o payload veio mascarado. A tela precisa dizer isso. */
  sensitiveRevealed: boolean;
  reprocessedAt: Date | null;
  retentionUntil: Date;
  /**
   * Explore do Grafana já filtrado por `correlationId` — a ponte da falha para
   * as linhas de log que a produziram. `null` quando o Grafana não está
   * configurado ou a falha não tem correlação: melhor ausência de link do que
   * link que não leva a nada.
   */
  logsUrl: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const LIST_SELECT = {
  id: true,
  source: true,
  sourceQueue: true,
  status: true,
  errorType: true,
  errorMessage: true,
  attempts: true,
  permanent: true,
  correlationId: true,
  phoneHash: true,
  firstFailedAt: true,
  failedAt: true,
  capturedAt: true,
} satisfies Prisma.OpsFailedMessageSelect;

@Injectable()
export class OpsFailuresQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
    private readonly grafana: OpsGrafanaService,
  ) {}

  /**
   * Listagem paginada.
   *
   * Lê **do Postgres**, nunca da fila: é o ponto inteiro do catálogo. Abrir esta
   * página cem vezes não consome nada do RabbitMQ.
   */
  async list(filtros: ListFailuresDto): Promise<Paginated<FailureListItem>> {
    const page = filtros.page ?? 1;
    const pageSize = filtros.pageSize ?? 10;
    const where = this.buildWhere(filtros);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.opsFailedMessage.findMany({
        where,
        select: LIST_SELECT,
        // Mais recentes primeiro: a investigação começa pelo que acabou de falhar.
        orderBy: { capturedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.opsFailedMessage.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Detalhe de uma falha.
   *
   * O payload sai **mascarado por padrão**. Em claro só para operador com
   * `canViewSensitive`, e cada visualização dessas grava linha de auditoria — a
   * permissão diz quem pode, a auditoria diz quem viu.
   */
  async detail(id: string, operator: CurrentOpsOperator): Promise<FailureDetail> {
    const row = await this.prisma.opsFailedMessage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Falha não encontrada.');

    const revelar = operator.canViewSensitive;
    if (revelar) {
      await this.audit.recordBestEffort({
        operatorId: operator.id,
        action: OPS_AUDIT_ACTIONS.sensitiveViewed,
        targetType: OPS_AUDIT_TARGETS.failedMessage,
        targetId: row.id,
        reason: 'visualização do payload em claro',
        result: OpsAuditResult.success,
      });
    }

    return {
      id: row.id,
      source: row.source,
      sourceQueue: row.sourceQueue,
      status: row.status,
      errorType: row.errorType,
      errorMessage: row.errorMessage,
      attempts: row.attempts,
      permanent: row.permanent,
      correlationId: row.correlationId,
      phoneHash: row.phoneHash,
      firstFailedAt: row.firstFailedAt,
      failedAt: row.failedAt,
      capturedAt: row.capturedAt,
      providerMessageId: row.providerMessageId,
      jobId: row.jobId,
      payload: revelar ? row.payload : maskFailurePayload(row.payload),
      sensitiveRevealed: revelar,
      reprocessedAt: row.reprocessedAt,
      retentionUntil: row.retentionUntil,
      logsUrl: this.grafana.logsUrl(row.correlationId),
    };
  }

  /** Contagem por status, para o resumo do painel e para a métrica. */
  async countByStatus(): Promise<Record<OpsFailureStatus, number>> {
    const linhas = await this.prisma.opsFailedMessage.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    // Todos os status presentes, inclusive zerados: um painel que omite "zero
    // descartadas" faz parecer que a informação não existe.
    const base = {
      pending: 0,
      reprocessing: 0,
      reprocessed: 0,
      discarded: 0,
    } as Record<OpsFailureStatus, number>;

    for (const linha of linhas) base[linha.status] = linha._count._all;
    return base;
  }

  private buildWhere(filtros: ListFailuresDto): Prisma.OpsFailedMessageWhereInput {
    const where: Prisma.OpsFailedMessageWhereInput = {};

    if (filtros.status) where.status = filtros.status;
    if (filtros.source) where.source = filtros.source;
    if (filtros.sourceQueue) where.sourceQueue = filtros.sourceQueue;
    if (filtros.errorType) where.errorType = filtros.errorType;
    if (filtros.correlationId) where.correlationId = filtros.correlationId;

    if (filtros.from || filtros.to) {
      where.capturedAt = {
        ...(filtros.from ? { gte: new Date(filtros.from) } : {}),
        ...(filtros.to ? { lte: new Date(filtros.to) } : {}),
      };
    }

    return where;
  }
}

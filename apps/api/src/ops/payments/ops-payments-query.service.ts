import { Injectable, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, Prisma, WebhookEventStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { Paginated } from '../failures/ops-failures-query.service';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { ListPaymentsDto } from './dto/list-payments.dto';
import { maskPaymentPayload } from './payment-masking';

/** Um evento de webhook na listagem. Sem payload: a lista não precisa dele. */
export interface PaymentEventListItem {
  id: string;
  providerEventId: string;
  eventType: string;
  status: WebhookEventStatus;
  attempts: number;
  receivedAt: Date;
  processedAt: Date | null;
  lastError: string | null;
  /** Quando o cron vai tentar de novo. `null` em processado e em esgotado. */
  nextRetryAt: Date | null;
}

export interface PaymentEventDetail extends PaymentEventListItem {
  /** Quando a última tentativa começou. */
  attemptedAt: Date | null;
  /** Assinatura correlacionada pelo processamento, quando houve. */
  subscriptionId: string | null;
  payload: unknown;
  /** `false` quando o payload veio mascarado. A tela precisa dizer isso. */
  sensitiveRevealed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const LIST_SELECT = {
  id: true,
  providerEventId: true,
  eventType: true,
  status: true,
  attempts: true,
  receivedAt: true,
  processedAt: true,
  lastError: true,
  nextRetryAt: true,
} satisfies Prisma.PaymentWebhookEventSelect;

/**
 * Leitura dos eventos de webhook de pagamento.
 *
 * `payment_webhook_events` **já é** a fonte de verdade desse caminho — ao
 * contrário do WhatsApp, aqui não foi preciso construir catálogo nenhum, só
 * expor o que já se persistia antes de processar.
 *
 * A recuperação (reprocessar evento `failed`) é a Entrega 8; esta classe só lê.
 */
@Injectable()
export class OpsPaymentsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
  ) {}

  async list(filtros: ListPaymentsDto): Promise<Paginated<PaymentEventListItem>> {
    const page = filtros.page ?? 1;
    const pageSize = filtros.pageSize ?? 10;
    const where = this.buildWhere(filtros);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentWebhookEvent.findMany({
        where,
        select: LIST_SELECT,
        // Mais recentes primeiro, como no catálogo de falhas.
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Detalhe de um evento.
   *
   * O payload guardado já passou pela sanitização do ingest (sem cartão nem
   * segredo), mas ainda traz identidade do cliente — então vale a mesma regra
   * das falhas: mascarado por padrão, em claro só para `canViewSensitive`, e
   * cada visualização dessas grava linha de auditoria.
   */
  async detail(id: string, operator: CurrentOpsOperator): Promise<PaymentEventDetail> {
    const row = await this.prisma.paymentWebhookEvent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Evento de webhook não encontrado.');

    const revelar = operator.canViewSensitive;
    if (revelar) {
      await this.audit.recordBestEffort({
        operatorId: operator.id,
        action: OPS_AUDIT_ACTIONS.sensitiveViewed,
        targetType: OPS_AUDIT_TARGETS.paymentWebhookEvent,
        targetId: row.id,
        reason: 'visualização do payload em claro',
        result: OpsAuditResult.success,
      });
    }

    return {
      id: row.id,
      providerEventId: row.providerEventId,
      eventType: row.eventType,
      status: row.status,
      attempts: row.attempts,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
      lastError: row.lastError,
      nextRetryAt: row.nextRetryAt,
      attemptedAt: row.attemptedAt,
      subscriptionId: row.subscriptionId,
      payload: revelar ? row.sanitizedPayload : maskPaymentPayload(row.sanitizedPayload),
      sensitiveRevealed: revelar,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Contagem por status, para o resumo do painel. */
  async countByStatus(): Promise<Record<WebhookEventStatus, number>> {
    const linhas = await this.prisma.paymentWebhookEvent.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const base: Record<WebhookEventStatus, number> = {
      received: 0,
      processing: 0,
      processed: 0,
      failed: 0,
      exhausted: 0,
    };

    for (const linha of linhas) base[linha.status] = linha._count._all;
    return base;
  }

  private buildWhere(filtros: ListPaymentsDto): Prisma.PaymentWebhookEventWhereInput {
    const where: Prisma.PaymentWebhookEventWhereInput = {};

    if (filtros.status) where.status = filtros.status;
    if (filtros.eventType) where.eventType = filtros.eventType;
    if (filtros.providerEventId) where.providerEventId = filtros.providerEventId;

    if (filtros.from || filtros.to) {
      where.receivedAt = {
        ...(filtros.from ? { gte: new Date(filtros.from) } : {}),
        ...(filtros.to ? { lte: new Date(filtros.to) } : {}),
      };
    }

    return where;
  }
}

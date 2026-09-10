import { Injectable } from '@nestjs/common';
import { OpsFailureStatus, WebhookEventStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsFailuresQueryService } from '../failures/ops-failures-query.service';
import { GrafanaLink, OpsGrafanaService } from '../grafana/ops-grafana.service';

/** Um tipo de erro e quantas falhas pendentes ele responde. */
export interface ErrorTypeCount {
  errorType: string;
  count: number;
}

export interface OpsOverview {
  failures: {
    byStatus: Record<OpsFailureStatus, number>;
    /** Capturadas nas últimas 24h — o que está acontecendo agora. */
    last24h: number;
    /** A mais antiga ainda `pending`: mede a idade da dívida, não o volume. */
    oldestPendingAt: Date | null;
    topErrorTypes: ErrorTypeCount[];
  };
  payments: {
    byStatus: Record<WebhookEventStatus, number>;
    last24hFailed: number;
    oldestUnresolvedAt: Date | null;
  };
  grafana: {
    dashboards: GrafanaLink[];
  };
  generatedAt: Date;
}

/** Estados de webhook que ainda não terminaram bem. */
const WEBHOOK_UNRESOLVED: WebhookEventStatus[] = [
  WebhookEventStatus.received,
  WebhookEventStatus.processing,
  WebhookEventStatus.failed,
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resumo da área de operações.
 *
 * Responde três perguntas na ordem em que um plantonista as faz: *está
 * acontecendo agora?* (últimas 24h), *o que está acumulado?* (pendentes e a mais
 * antiga) e *onde eu olho o detalhe?* (Grafana e as abas).
 *
 * Tudo vem do Postgres. **Nenhuma consulta toca o RabbitMQ** — abrir o resumo em
 * loop não consome fila, que é o ponto inteiro do catálogo da Entrega 5.
 */
@Injectable()
export class OpsOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly failures: OpsFailuresQueryService,
    private readonly grafana: OpsGrafanaService,
  ) {}

  async build(): Promise<OpsOverview> {
    const desde = new Date(Date.now() - DAY_MS);

    const [
      failuresByStatus,
      failuresLast24h,
      oldestPending,
      topErrorTypes,
      paymentsByStatus,
      paymentsFailedLast24h,
      oldestUnresolvedPayment,
    ] = await Promise.all([
      this.failures.countByStatus(),
      this.prisma.opsFailedMessage.count({ where: { capturedAt: { gte: desde } } }),
      this.prisma.opsFailedMessage.findFirst({
        where: { status: OpsFailureStatus.pending },
        orderBy: { capturedAt: 'asc' },
        select: { capturedAt: true },
      }),
      this.prisma.opsFailedMessage.groupBy({
        by: ['errorType'],
        where: { status: OpsFailureStatus.pending },
        _count: { _all: true },
        orderBy: { _count: { errorType: 'desc' } },
        take: 5,
      }),
      this.prisma.paymentWebhookEvent.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.paymentWebhookEvent.count({
        where: { status: WebhookEventStatus.failed, receivedAt: { gte: desde } },
      }),
      this.prisma.paymentWebhookEvent.findFirst({
        where: { status: { in: WEBHOOK_UNRESOLVED } },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
    ]);

    // Todos os status presentes, inclusive zerados: um resumo que omite o zero
    // faz parecer que a informação não existe.
    const pagamentos: Record<WebhookEventStatus, number> = {
      received: 0,
      processing: 0,
      processed: 0,
      failed: 0,
    };
    for (const linha of paymentsByStatus) pagamentos[linha.status] = linha._count._all;

    return {
      failures: {
        byStatus: failuresByStatus,
        last24h: failuresLast24h,
        oldestPendingAt: oldestPending?.capturedAt ?? null,
        topErrorTypes: topErrorTypes.map((linha) => ({
          errorType: linha.errorType,
          count: linha._count._all,
        })),
      },
      payments: {
        byStatus: pagamentos,
        last24hFailed: paymentsFailedLast24h,
        oldestUnresolvedAt: oldestUnresolvedPayment?.receivedAt ?? null,
      },
      grafana: { dashboards: this.grafana.dashboards() },
      generatedAt: new Date(),
    };
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma, WebhookEventStatus } from '@prisma/client';

import { MetricsService } from '../../observability/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { VerifiedPaymentEvent } from '../providers/payment-provider.interface';
import { nextRetryAt } from './webhook-retry.policy';

/** Chaves sensíveis que nunca devem ser persistidas (dados de cartão/segredos). */
const SENSITIVE_KEY = /(card|ccv|cvv|cvc|token|secret|password)/i;

/** Remove recursivamente campos sensíveis do payload antes de persistir. */
export function sanitizePayload(value: unknown): Prisma.InputJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item)) as Prisma.InputJsonValue;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizePayload(val);
      }
    }
    return result;
  }
  return (value ?? null) as Prisma.InputJsonValue;
}

@Injectable()
export class WebhookEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Persiste o evento **antes** de processá-lo, garantindo idempotência por
   * `providerEventId` (`@unique`). Eventos duplicados não são reinseridos.
   */
  async ingest(
    event: VerifiedPaymentEvent,
  ): Promise<{ duplicate: boolean; eventId: string | null }> {
    try {
      const created = await this.prisma.paymentWebhookEvent.create({
        data: {
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          status: WebhookEventStatus.received,
          sanitizedPayload: sanitizePayload(event.payload),
        },
      });
      // Só o que de fato entrou: duplicata não é evento novo, e contá-la faria
      // o painel medir reentrega do PSP em vez de volume real.
      this.metrics.observePaymentWebhook('received');
      return { duplicate: false, eventId: created.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { duplicate: true, eventId: null };
      }
      throw error;
    }
  }

  /**
   * Reivindica o evento para processamento. `false` quando outro ja levou.
   *
   * E um `updateMany` com o status no `where`, nao um `update`: com mais de uma
   * replica da API, a varredura do cron dispara em todas ao mesmo tempo, e sem
   * a reivindicacao atomica duas delas processariam o mesmo evento. `exhausted`
   * fica de fora de proposito — so a recuperacao pelo painel o traz de volta.
   */
  async markProcessing(id: string): Promise<boolean> {
    const { count } = await this.prisma.paymentWebhookEvent.updateMany({
      where: {
        id,
        status: { in: [WebhookEventStatus.received, WebhookEventStatus.failed] },
      },
      data: {
        status: WebhookEventStatus.processing,
        attempts: { increment: 1 },
        attemptedAt: new Date(),
        // Reivindicado significa que nao ha agendamento pendente: se falhar de
        // novo, `markFailed` calcula o proximo.
        nextRetryAt: null,
      },
    });
    return count === 1;
  }

  markProcessed(id: string) {
    this.metrics.observePaymentWebhook('processed');
    return this.prisma.paymentWebhookEvent.update({
      where: { id },
      data: {
        status: WebhookEventStatus.processed,
        processedAt: new Date(),
        lastError: null,
        nextRetryAt: null,
      },
    });
  }

  /**
   * Registra a falha e **agenda a proxima tentativa no banco**.
   *
   * Antes, toda falha gravava `failed` antes de decidir se haveria retry — o
   * painel nao conseguia distinguir "vai ser retentado sozinho" de "acabou", e
   * o operador reprocessaria por cima de um retry em andamento. Agora os dois
   * estados sao decididos aqui, por {@link nextRetryAt}, e ficam visiveis:
   * `failed` tem `nextRetryAt` preenchido, `exhausted` nao tem.
   */
  async markFailed(id: string, error: string, attempts: number) {
    const proxima = nextRetryAt(attempts);
    this.metrics.observePaymentWebhook(proxima ? 'failed' : 'exhausted');

    return this.prisma.paymentWebhookEvent.update({
      where: { id },
      data: {
        status: proxima ? WebhookEventStatus.failed : WebhookEventStatus.exhausted,
        lastError: error.slice(0, 1000),
        nextRetryAt: proxima,
      },
    });
  }

  /**
   * Liga o evento a assinatura que o processamento encontrou.
   *
   * Best-effort: a correlacao e informacao de diagnostico, e falhar em grava-la
   * nao pode desfazer um pagamento ja aplicado. Sem ela a tabela seguiria sendo
   * uma ilha — nao havia como perguntar "o que aconteceu com esta assinatura"
   * partindo dos eventos.
   */
  async linkSubscription(id: string, subscriptionId: string): Promise<void> {
    await this.prisma.paymentWebhookEvent
      .update({ where: { id }, data: { subscriptionId } })
      .catch(() => undefined);
  }

  /** Devolve um evento esgotado para a fila de retry. Usado pelo painel. */
  async rescheduleNow(id: string) {
    return this.prisma.paymentWebhookEvent.updateMany({
      where: { id, status: WebhookEventStatus.exhausted },
      data: { status: WebhookEventStatus.failed, nextRetryAt: new Date() },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma, WebhookEventStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { VerifiedPaymentEvent } from '../providers/payment-provider.interface';

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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persiste o evento **antes** de processá-lo, garantindo idempotência por
   * `providerEventId` (`@unique`). Eventos duplicados não são reinseridos.
   */
  async ingest(event: VerifiedPaymentEvent): Promise<{ duplicate: boolean; eventId: string | null }> {
    try {
      const created = await this.prisma.paymentWebhookEvent.create({
        data: {
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          status: WebhookEventStatus.received,
          sanitizedPayload: sanitizePayload(event.payload),
        },
      });
      return { duplicate: false, eventId: created.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { duplicate: true, eventId: null };
      }
      throw error;
    }
  }

  markProcessing(id: string) {
    return this.prisma.paymentWebhookEvent.update({
      where: { id },
      data: { status: WebhookEventStatus.processing, attempts: { increment: 1 } },
    });
  }

  markProcessed(id: string) {
    return this.prisma.paymentWebhookEvent.update({
      where: { id },
      data: { status: WebhookEventStatus.processed, processedAt: new Date(), lastError: null },
    });
  }

  markFailed(id: string, error: string) {
    return this.prisma.paymentWebhookEvent.update({
      where: { id },
      data: { status: WebhookEventStatus.failed, lastError: error.slice(0, 1000) },
    });
  }
}

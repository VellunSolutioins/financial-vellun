import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { OpsFailureSource, OpsFailureStatus, Prisma } from '@prisma/client';

import { normalizePhone } from '../../common/phone.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Retenção por status, em dias.
 *
 * O que já foi resolvido não precisa ocupar espaço tanto quanto o que ainda
 * espera ação — e o que ainda espera ação não pode sumir enquanto ninguém olhou.
 */
export const RETENTION_DAYS = {
  pending: 180,
  reprocessing: 180,
  reprocessed: 30,
  discarded: 90,
} as const satisfies Record<OpsFailureStatus, number>;

/** Envelope da DLQ, como o agente o entrega. */
export interface CaptureFailureInput {
  source: OpsFailureSource;
  sourceQueue: string;
  routingKey: string;
  correlationId?: string | null;
  attempts: number;
  errorType: string;
  errorMessage: string;
  permanent: boolean;
  payload: Prisma.InputJsonValue;
  firstFailedAt?: string | null;
  failedAt: string;
}

export interface CaptureResult {
  id: string;
  duplicate: boolean;
}

@Injectable()
export class OpsFailedMessagesService {
  private readonly logger = new Logger(OpsFailedMessagesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra uma falha vinda da DLQ. **Idempotente.**
   *
   * O consumer do catálogo pode reentregar a mesma mensagem — um `nack` depois de
   * uma gravação que expirou por timeout, por exemplo. Sem deduplicação, a mesma
   * falha apareceria duas vezes no painel e seria reprocessada duas vezes.
   */
  async capture(input: CaptureFailureInput): Promise<CaptureResult> {
    const dedupeKey = this.buildDedupeKey(input);
    const payload = input.payload as Record<string, unknown>;

    const existing = await this.prisma.opsFailedMessage.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });
    if (existing) return { id: existing.id, duplicate: true };

    const capturedAt = new Date();
    const status = OpsFailureStatus.pending;

    try {
      const created = await this.prisma.opsFailedMessage.create({
        data: {
          dedupeKey,
          source: input.source,
          sourceQueue: input.sourceQueue,
          routingKey: input.routingKey,
          correlationId: input.correlationId ?? null,
          providerMessageId: readProviderMessageId(payload),
          jobId: readString(payload, 'jobId'),
          phoneHash: hashPhone(readString(payload, 'phone')),
          errorType: input.errorType,
          errorMessage: input.errorMessage,
          attempts: input.attempts,
          permanent: input.permanent,
          payload: input.payload,
          status,
          firstFailedAt: input.firstFailedAt ? new Date(input.firstFailedAt) : null,
          failedAt: new Date(input.failedAt),
          capturedAt,
          retentionUntil: retentionFor(status, capturedAt),
        },
        select: { id: true },
      });
      return { id: created.id, duplicate: false };
    } catch (error) {
      // Corrida entre duas entregas da mesma mensagem: a outra ganhou.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.opsFailedMessage.findUnique({
          where: { dedupeKey },
          select: { id: true },
        });
        if (row) return { id: row.id, duplicate: true };
      }
      throw error;
    }
  }

  /**
   * Identidade de uma falha, derivada do conteúdo.
   *
   * `failedAt` entra na composição de propósito: uma falha **nova** da mesma
   * mensagem (depois de um reprocessamento que não deu certo) precisa gerar linha
   * nova, senão o catálogo diria que ela só falhou uma vez. O hash do payload
   * cobre o caso raro de duas mensagens diferentes falharem no mesmo instante com
   * a mesma correlação.
   */
  buildDedupeKey(input: CaptureFailureInput): string {
    const partes = [
      input.sourceQueue,
      input.routingKey,
      input.correlationId ?? '',
      input.failedAt,
      String(input.attempts),
      input.errorType,
      createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'),
    ];
    return createHash('sha256').update(partes.join('|')).digest('hex');
  }
}

/** Retenção calculada a partir do status. Exportada para o cron de expurgo. */
export function retentionFor(status: OpsFailureStatus, from: Date): Date {
  const dias = RETENTION_DAYS[status];
  return new Date(from.getTime() + dias * 24 * 60 * 60 * 1000);
}

/**
 * Hash do telefone, alinhado com `hash_phone` do agente
 * (`apps/ai-agent/src/services/phone.py`): sha256 do E.164 canônico, truncado em
 * 12 hex. Precisa bater, porque é assim que uma falha do catálogo se liga a uma
 * linha de log do agente.
 */
export function hashPhone(phone: string | null): string | null {
  if (!phone) return null;
  return createHash('sha256').update(normalizePhone(phone)).digest('hex').slice(0, 12);
}

function readString(payload: Record<string, unknown>, chave: string): string | null {
  const valor = payload?.[chave];
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/**
 * O id do provedor está em campos diferentes conforme a origem da falha:
 * `InboundMessageV1` tem `providerMessageId` (uma mensagem), enquanto
 * `ProcessingJobV1` tem `providerMessageIds` (o job consolida várias). Guardamos
 * o primeiro do job — é o suficiente para achar a conversa; o conjunto completo
 * continua no `payload`.
 */
function readProviderMessageId(payload: Record<string, unknown>): string | null {
  const unico = readString(payload, 'providerMessageId');
  if (unico) return unico;

  const lista = payload?.['providerMessageIds'];
  if (Array.isArray(lista)) {
    const primeiro = lista.find((item) => typeof item === 'string' && item.length > 0);
    if (typeof primeiro === 'string') return primeiro;
  }
  return null;
}

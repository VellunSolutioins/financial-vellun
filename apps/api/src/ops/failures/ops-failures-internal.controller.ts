import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalApiKeyGuard } from '../../internal/guards/internal-api-key.guard';
import { CaptureFailureDto } from './dto/capture-failure.dto';
import { CaptureResult, OpsFailedMessagesService } from './ops-failed-messages.service';

/**
 * Porta de entrada do catálogo de falhas, chamada pelo consumer do agente.
 *
 * Fica em `/internal/*` porque é server-to-server, com a chave interna
 * compartilhada — o agente não tem acesso ao Postgres e toda persistência dele
 * passa pela API.
 *
 * `@SkipThrottle` porque um pico de falhas é justamente quando este endpoint
 * precisa aceitar tudo: ser throttled aqui faria o consumer devolver as mensagens
 * à DLQ e ficar em loop de retry, escondendo o incidente em vez de registrá-lo.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('internal/ops/failed-messages')
@UseGuards(InternalApiKeyGuard)
export class OpsFailuresInternalController {
  constructor(private readonly failures: OpsFailedMessagesService) {}

  @Post()
  capture(@Body() dto: CaptureFailureDto): Promise<CaptureResult> {
    return this.failures.capture({
      source: dto.source,
      sourceQueue: dto.sourceQueue,
      routingKey: dto.routingKey,
      correlationId: dto.correlationId ?? null,
      attempts: dto.attempts,
      errorType: dto.errorType,
      errorMessage: dto.errorMessage,
      permanent: dto.permanent,
      payload: dto.payload as never,
      firstFailedAt: dto.firstFailedAt ?? null,
      failedAt: dto.failedAt,
    });
  }
}

import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';

import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';
import { WebhookEventService } from './webhook/webhook-event.service';
import { WebhookProcessor } from './webhook/webhook.processor';

/**
 * Endpoint de webhook do PSP — **sem `JwtAuthGuard`** (autenticado pelo token do
 * próprio PSP) e com acesso ao corpo bruto. Persiste o evento, responde rápido e
 * processa de forma assíncrona/idempotente.
 */
@SkipThrottle()
@Controller('billing')
export class BillingWebhookController {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly events: WebhookEventService,
    private readonly processor: WebhookProcessor,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async handle(@Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    // Lança 401 quando a assinatura/token do PSP é inválida.
    const verified = await this.provider.verifyWebhook({ rawBody, headers: req.headers });

    const { duplicate, eventId } = await this.events.ingest(verified);
    if (!duplicate && eventId) {
      this.processor.enqueue(eventId);
    }

    return { received: true, duplicate };
  }
}

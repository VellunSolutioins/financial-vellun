import { Module } from '@nestjs/common';

import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { ReconciliationService } from './reconciliation.service';
import { ActiveSubscriptionGuard } from './guards/active-subscription.guard';
import { AsaasPaymentProvider } from './providers/asaas/asaas-payment.provider';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { PaymentService } from './services/payment.service';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionAuditService } from './services/subscription-audit.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { SubscriptionService } from './services/subscription.service';
import { WebhookEventService } from './webhook/webhook-event.service';
import { WebhookRetryService } from './webhook/webhook-retry.service';
import { WebhookProcessor } from './webhook/webhook.processor';

/**
 * Módulo de billing. O PAYMENT_PROVIDER é vinculado ao adapter concreto do
 * Asaas, único módulo autorizado a falar com o PSP. O webhook entra no Prompt 5.
 */
@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [
    BillingService,
    SubscriptionStateService,
    SubscriptionAccessService,
    SubscriptionAuditService,
    SubscriptionService,
    PaymentService,
    WebhookEventService,
    WebhookProcessor,
    WebhookRetryService,
    ReconciliationService,
    ActiveSubscriptionGuard,
    { provide: PAYMENT_PROVIDER, useClass: AsaasPaymentProvider },
  ],
  exports: [
    SubscriptionStateService,
    SubscriptionAccessService,
    SubscriptionAuditService,
    SubscriptionService,
    ActiveSubscriptionGuard,
    PAYMENT_PROVIDER,
    // Exportado para a area de operacoes: a recuperacao de um evento esgotado
    // roda uma tentativa DE VERDADE, pelo mesmo caminho do webhook, em vez de
    // so mexer no status.
    WebhookProcessor,
  ],
})
export class BillingModule {}

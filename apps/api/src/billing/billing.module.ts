import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { ReconciliationService } from './reconciliation.service';
import { ActiveSubscriptionGuard } from './guards/active-subscription.guard';
import { AsaasPaymentProvider } from './providers/asaas/asaas-payment.provider';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';
import { ChargeSyncService } from './services/charge-sync.service';
import { PaymentService } from './services/payment.service';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionAuditService } from './services/subscription-audit.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { SubscriptionService } from './services/subscription.service';
import { WebhookEventService } from './webhook/webhook-event.service';
import { WebhookRetryService } from './webhook/webhook-retry.service';
import { WebhookProcessor } from './webhook/webhook.processor';

/**
 * Módulo de billing. O PAYMENT_PROVIDER é o adapter do PSP escolhido em
 * `PAYMENT_PROVIDER` (hoje só o Asaas), único autorizado a falar com o PSP.
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
    ChargeSyncService,
    WebhookEventService,
    WebhookProcessor,
    WebhookRetryService,
    ReconciliationService,
    ActiveSubscriptionGuard,
    AsaasPaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService, AsaasPaymentProvider],
      useFactory: (config: ConfigService, asaas: AsaasPaymentProvider): PaymentProvider => {
        // Um adapter por PSP suportado. Trocar de PSP é escrever outro adapter,
        // registrá-lo aqui e mudar `PAYMENT_PROVIDER`.
        const adapters: Record<string, PaymentProvider> = { [asaas.name]: asaas };
        const chosen = config.get<string>('PAYMENT_PROVIDER') ?? 'asaas';
        const adapter = adapters[chosen];
        if (!adapter) {
          throw new Error(
            `PAYMENT_PROVIDER=${chosen} não é suportado (disponíveis: ${Object.keys(adapters).join(', ')})`,
          );
        }
        return adapter;
      },
    },
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

import { Module } from '@nestjs/common';

import { AsaasPaymentProvider } from './providers/asaas/asaas-payment.provider';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionAuditService } from './services/subscription-audit.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { SubscriptionService } from './services/subscription.service';

/**
 * Núcleo de domínio de billing. O PAYMENT_PROVIDER é vinculado ao adapter
 * concreto do Asaas, único módulo autorizado a falar com o PSP. Controllers e
 * webhook entram nos prompts seguintes.
 */
@Module({
  providers: [
    SubscriptionStateService,
    SubscriptionAccessService,
    SubscriptionAuditService,
    SubscriptionService,
    { provide: PAYMENT_PROVIDER, useClass: AsaasPaymentProvider },
  ],
  exports: [
    SubscriptionStateService,
    SubscriptionAccessService,
    SubscriptionAuditService,
    SubscriptionService,
    PAYMENT_PROVIDER,
  ],
})
export class BillingModule {}

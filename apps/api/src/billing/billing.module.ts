import { Module } from '@nestjs/common';

import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionAuditService } from './services/subscription-audit.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { SubscriptionService } from './services/subscription.service';

/**
 * Núcleo de domínio de billing (sem PSP). O bind do PAYMENT_PROVIDER ao adapter
 * concreto e os controllers/webhook entram nos prompts seguintes.
 */
@Module({
  providers: [
    SubscriptionStateService,
    SubscriptionAccessService,
    SubscriptionAuditService,
    SubscriptionService,
  ],
  exports: [
    SubscriptionStateService,
    SubscriptionAccessService,
    SubscriptionAuditService,
    SubscriptionService,
  ],
})
export class BillingModule {}

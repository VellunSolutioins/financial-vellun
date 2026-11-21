import { Module } from '@nestjs/common';
import { InternalActionsController } from './controllers/internal-actions.controller';
import { InternalController } from './controllers/internal.controller';
import { AiRetentionService } from './ai-retention.service';
import { InternalActionsService } from './internal-actions.service';
import { InternalService } from './internal.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { WhatsappLinkModule } from '../whatsapp-link/whatsapp-link.module';

@Module({
  imports: [
    AccountsModule,
    BillingModule,
    WhatsappLinkModule,
    CreditCardsModule,
    DashboardModule,
    FeatureFlagsModule,
  ],
  controllers: [InternalController, InternalActionsController],
  providers: [InternalService, InternalActionsService, AiRetentionService],
})
export class InternalModule {}

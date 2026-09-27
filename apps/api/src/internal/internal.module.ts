import { Module } from '@nestjs/common';
import { InternalController } from './controllers/internal.controller';
import { AiRetentionService } from './ai-retention.service';
import { InternalService } from './internal.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';
import { WhatsappLinkModule } from '../whatsapp-link/whatsapp-link.module';

@Module({
  imports: [AccountsModule, BillingModule, WhatsappLinkModule, CreditCardsModule],
  controllers: [InternalController],
  providers: [InternalService, AiRetentionService],
})
export class InternalModule {}

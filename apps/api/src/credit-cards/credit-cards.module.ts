import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { AccountsModule } from '../accounts/accounts.module';

import { CreditCardsController } from './credit-cards.controller';
import { CreditCardsService } from './credit-cards.service';

@Module({
  imports: [BillingModule, AccountsModule],
  controllers: [CreditCardsController],
  providers: [CreditCardsService],
  exports: [CreditCardsService],
})
export class CreditCardsModule {}

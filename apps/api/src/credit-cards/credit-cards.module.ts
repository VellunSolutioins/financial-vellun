import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { CreditCardsController } from './credit-cards.controller';
import { CreditCardsService } from './credit-cards.service';
import { CardLedgerService } from './card-ledger.service';

@Module({
  imports: [BillingModule],
  controllers: [CreditCardsController],
  providers: [CreditCardsService, CardLedgerService],
  exports: [CreditCardsService, CardLedgerService],
})
export class CreditCardsModule {}

import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { AccountsModule } from '../accounts/accounts.module';

import { CreditCardsController } from './credit-cards.controller';
import { CreditCardsService } from './credit-cards.service';
import { CardLedgerService } from './card-ledger.service';
import { CardPaymentsService } from './card-payments.service';

@Module({
  imports: [BillingModule, AccountsModule],
  controllers: [CreditCardsController],
  providers: [CreditCardsService, CardLedgerService, CardPaymentsService],
  exports: [CreditCardsService, CardLedgerService],
})
export class CreditCardsModule {}

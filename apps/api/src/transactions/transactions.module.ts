import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { RecurrencesController } from './recurrences.controller';
import { RecurrencesService } from './recurrences.service';
import { InstallmentsController } from './installments.controller';
import { InstallmentsService } from './installments.service';
import { ReconciliationController, SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';
import { ResourceScope } from '../common/resource-scope';

@Module({
  imports: [AccountsModule, BillingModule, CreditCardsModule],
  controllers: [
    TransactionsController,
    RecurrencesController,
    InstallmentsController,
    SettlementsController,
    ReconciliationController,
  ],
  providers: [
    TransactionsService,
    RecurrencesService,
    InstallmentsService,
    SettlementsService,
    ResourceScope,
  ],
  exports: [SettlementsService],
})
export class TransactionsModule {}

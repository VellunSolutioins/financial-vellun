import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { RecurrencesController } from './recurrences.controller';
import { RecurrencesService } from './recurrences.service';
import { InstallmentsController } from './installments.controller';
import { InstallmentsService } from './installments.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';
import { ResourceScope } from '../common/resource-scope';

@Module({
  imports: [AccountsModule, BillingModule, CreditCardsModule],
  controllers: [TransactionsController, RecurrencesController, InstallmentsController],
  providers: [TransactionsService, RecurrencesService, InstallmentsService, ResourceScope],
})
export class TransactionsModule {}

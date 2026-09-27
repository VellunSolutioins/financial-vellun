import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { RecurrencesController } from './recurrences.controller';
import { RecurrencesService } from './recurrences.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [AccountsModule, BillingModule],
  controllers: [TransactionsController, RecurrencesController],
  providers: [TransactionsService, RecurrencesService],
})
export class TransactionsModule {}

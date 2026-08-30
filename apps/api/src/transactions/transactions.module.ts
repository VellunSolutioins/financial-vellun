import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [AccountsModule, BillingModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}

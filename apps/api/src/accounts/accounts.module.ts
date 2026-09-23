import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AccountBalanceScheduler } from './account-balance.scheduler';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [BillingModule],
  controllers: [AccountsController],
  providers: [AccountsService, AccountBalanceScheduler],
  exports: [AccountsService],
})
export class AccountsModule {}

import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [AccountsModule, BillingModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}

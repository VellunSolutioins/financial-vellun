import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { SpendingGoalsController } from './spending-goals.controller';
import { SpendingGoalsService } from './spending-goals.service';

@Module({
  imports: [BillingModule],
  controllers: [SpendingGoalsController],
  providers: [SpendingGoalsService],
  exports: [SpendingGoalsService],
})
export class SpendingGoalsModule {}

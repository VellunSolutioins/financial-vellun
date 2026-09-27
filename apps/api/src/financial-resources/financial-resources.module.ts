import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { FinancialResourcesController } from './financial-resources.controller';
import { FinancialResourcesService } from './financial-resources.service';

@Module({
  imports: [BillingModule],
  controllers: [FinancialResourcesController],
  providers: [FinancialResourcesService],
})
export class FinancialResourcesModule {}

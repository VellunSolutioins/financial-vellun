import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { RecurringRulesController } from './recurring-rules.controller';
import { RecurringRulesService } from './recurring-rules.service';

@Module({
  imports: [BillingModule],
  controllers: [RecurringRulesController],
  providers: [RecurringRulesService],
})
export class RecurringRulesModule {}

import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

@Module({
  imports: [BillingModule],
  controllers: [RemindersController],
  providers: [RemindersService],
})
export class RemindersModule {}

import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { AgendaEventsController } from './agenda-events.controller';
import { AgendaEventsService } from './agenda-events.service';

@Module({
  imports: [BillingModule],
  controllers: [AgendaEventsController],
  providers: [AgendaEventsService],
})
export class AgendaEventsModule {}

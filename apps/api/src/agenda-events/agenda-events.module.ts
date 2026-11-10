import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

import { AgendaEventsController } from './agenda-events.controller';
import { AgendaEventsService } from './agenda-events.service';

@Module({
  imports: [BillingModule, FeatureFlagsModule],
  controllers: [AgendaEventsController],
  providers: [AgendaEventsService],
  exports: [AgendaEventsService],
})
export class AgendaEventsModule {}

import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { BillingModule } from '../billing/billing.module';
import { ResourceScope } from '../common/resource-scope';

@Module({
  imports: [BillingModule],
  controllers: [DashboardController],
  providers: [DashboardService, ResourceScope],
})
export class DashboardModule {}

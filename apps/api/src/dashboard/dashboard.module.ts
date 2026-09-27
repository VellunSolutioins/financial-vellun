import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { BillingModule } from '../billing/billing.module';
import { ResourceScope } from '../common/resource-scope';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';

@Module({
  imports: [BillingModule, CreditCardsModule],
  controllers: [DashboardController],
  providers: [DashboardService, ResourceScope],
})
export class DashboardModule {}

import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';
import { SavingsBoxesModule } from '../savings-boxes/savings-boxes.module';
import { SpendingGoalsModule } from '../spending-goals/spending-goals.module';
import { RemindersModule } from '../reminders/reminders.module';

import { FinancialAnalysisController } from './financial-analysis.controller';
import { FinancialAnalysisService } from './financial-analysis.service';

@Module({
  imports: [BillingModule, CreditCardsModule, SavingsBoxesModule, SpendingGoalsModule, RemindersModule],
  controllers: [FinancialAnalysisController],
  providers: [FinancialAnalysisService],
})
export class FinancialAnalysisModule {}

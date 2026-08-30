import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';
import { RecurringRulesModule } from '../recurring-rules/recurring-rules.module';
import { SpendingGoalsModule } from '../spending-goals/spending-goals.module';
import { SavingsBoxesModule } from '../savings-boxes/savings-boxes.module';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';
import { RemindersModule } from '../reminders/reminders.module';
import { AgendaEventsModule } from '../agenda-events/agenda-events.module';
import { NotesModule } from '../notes/notes.module';

import { InternalService } from './internal.service';
import { InternalController } from './controllers/internal.controller';

@Module({
  imports: [
    AccountsModule,
    BillingModule,
    RecurringRulesModule,
    SpendingGoalsModule,
    SavingsBoxesModule,
    CreditCardsModule,
    RemindersModule,
    AgendaEventsModule,
    NotesModule,
  ],
  controllers: [InternalController],
  providers: [InternalService],
})
export class InternalModule {}

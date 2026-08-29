import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CsrfGuard } from './common/guards/csrf.guard';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CategoriesModule } from './categories/categories.module';
import { AccountsModule } from './accounts/accounts.module';
import { ContactsModule } from './contacts/contacts.module';
import { TransactionsModule } from './transactions/transactions.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { InternalModule } from './internal/internal.module';
import { BillingModule } from './billing/billing.module';
import { RecurringRulesModule } from './recurring-rules/recurring-rules.module';
import { SpendingGoalsModule } from './spending-goals/spending-goals.module';
import { SavingsBoxesModule } from './savings-boxes/savings-boxes.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    // Rate limiting global: 120 req/min por IP (rotas sensíveis sobrescrevem).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    AccountsModule,
    ContactsModule,
    TransactionsModule,
    DashboardModule,
    InternalModule,
    BillingModule,
    RecurringRulesModule,
    SpendingGoalsModule,
    SavingsBoxesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}

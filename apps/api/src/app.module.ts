import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CsrfGuard } from './common/guards/csrf.guard';
import { AppThrottlerGuard } from './common/throttling/app-throttler.guard';
import { ResilientThrottlerStorage } from './common/throttling/resilient-throttler.storage';
import { RedisModule } from './redis/redis.module';
import { SecurityEventsModule } from './security-events/security-events.module';
import { RedisService } from './redis/redis.service';
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
import { ObservabilityModule } from './observability/observability.module';
import { OpsModule } from './ops/ops.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    SecurityEventsModule,
    // Rate limiting global: 120 req/min por usuário (ou IP, sem login); rotas
    // sensíveis sobrescrevem. Contado no Redis, compartilhado entre réplicas.
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ ttl: 60_000, limit: 120 }],
        storage: new ResilientThrottlerStorage(
          redis.client ? new ThrottlerStorageRedisService(redis.client) : null,
        ),
      }),
    }),
    PrismaModule,
    // Antes dos módulos de domínio: o middleware de correlação precisa ser o
    // primeiro da cadeia para que nenhum log fique sem `correlationId`.
    ObservabilityModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    AccountsModule,
    ContactsModule,
    TransactionsModule,
    DashboardModule,
    InternalModule,
    BillingModule,
    OpsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}

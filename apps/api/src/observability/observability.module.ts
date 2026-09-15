import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppLoggerService } from './app-logger.service';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';
import { PrismaHealthIndicator } from './prisma.health-indicator';

/**
 * Instrumentação da API: métricas, health, correlação e log estruturado.
 *
 * `@Global` porque o `MetricsService` e o `AppLoggerService` são um por processo —
 * o registro do Prometheus precisa ser único, senão cada módulo exporia um
 * conjunto próprio de séries e o scrape veria apenas um deles.
 *
 * O middleware de correlação é aplicado a `*` **aqui**, e não em `main.ts`, para
 * que a ordem em relação aos outros middlewares do Nest fique explícita no
 * módulo que a define.
 */
@Global()
@Module({
  imports: [TerminusModule],
  controllers: [MetricsController, HealthController],
  providers: [
    MetricsService,
    AppLoggerService,
    PrismaHealthIndicator,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [MetricsService, AppLoggerService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}

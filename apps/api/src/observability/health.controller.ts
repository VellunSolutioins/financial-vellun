import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaHealthIndicator } from './prisma.health-indicator';
import { RedisHealthIndicator } from './redis.health-indicator';

/**
 * Liveness e readiness separados.
 *
 * A distinção é o ponto: **liveness** responde "este processo precisa ser
 * reiniciado?" e por isso não pode depender de nada externo — se caísse com o
 * Postgres fora, o orquestrador reiniciaria a API em loop enquanto o problema
 * está no banco, e o restart não conserta nada. **Readiness** responde "esta
 * instância pode receber tráfego?" e aí depender do banco é justamente o certo.
 *
 * A API não fala com RabbitMQ (só o agente de IA fala), então readiness aqui é
 * Postgres. Depender do agente seria errado: a API funciona sem ele.
 *
 * O Redis também aparece no corpo, mas **não** derruba o readiness: a API foi
 * feita para degradar sem ele (rate limit em memória, cache recalculado). Ver
 * `RedisHealthIndicator` para o porquê.
 */
@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: o processo está de pé (sem dependências).' })
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness: 503 quando uma dependência está fora.' })
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prisma.check('database'),
      () => this.redis.check('redis'),
    ]);
  }
}

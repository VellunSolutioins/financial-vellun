import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';

import { RedisService } from '../redis/redis.service';

/** Teto do check. Readiness que demora é readiness inútil. */
const TIMEOUT_MS = 2_000;

/**
 * Estado do Redis no readiness da API — **informativo, não fatal**.
 *
 * O contrato C8 dos planos diz "dependência indisponível → readiness 503", e é
 * a regra certa para o Postgres: sem banco, toda rota responde erro. O Redis
 * aqui é diferente, e de propósito: o rate limit cai para a contagem em memória
 * (`ResilientThrottlerStorage`) e o cache seletivo do P6 recalcula. Nenhuma
 * rota deixa de funcionar.
 *
 * Fazer o readiness falhar por causa dele transformaria uma degradação
 * planejada num apagão: **todas** as réplicas sairiam do balanceador ao mesmo
 * tempo, porque todas olham o mesmo Redis. Por isso este check devolve sempre
 * `up` e coloca o estado real em `state`, que o dashboard e o alerta leem:
 *
 * - `disabled` — sem `REDIS_URL` (rate limit por réplica; não escale assim);
 * - `up` — respondeu ao `PING`;
 * - `degraded` — configurado e sem resposta.
 *
 * Quem precisa de página é o alerta em cima de `state="degraded"`, não o
 * balanceador. No worker do agente é o oposto e está certo assim: lá, sem Redis
 * não há lock nem agrupamento, então o readiness falha de verdade.
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async check(key = 'redis'): Promise<HealthIndicatorResult> {
    const client = this.redis.client;
    if (!client) {
      return this.getStatus(key, true, { state: 'disabled' });
    }

    try {
      await withTimeout(client.ping(), TIMEOUT_MS);
      return this.getStatus(key, true, { state: 'up' });
    } catch (error) {
      // A mensagem do driver pode carregar a URL com senha; só o tipo sai.
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      return this.getStatus(key, true, { state: 'degraded', errorType });
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout de ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

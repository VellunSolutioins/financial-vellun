import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Conexão da API com o Redis (regra C1 do plano de segurança/performance).
 *
 * Uma conexão só, compartilhada. Cada uso separa suas chaves por prefixo —
 * `rl:` para o rate limit, `cache:` para o cache seletivo do plano de
 * performance —, e o Redis é a mesma instância do agente.
 *
 * Sem `REDIS_URL`, `client` é `null` e quem usa decide o comportamento
 * degradado (o rate limit volta a contar em memória, por réplica).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis | null;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn(
        'REDIS_URL não configurado: o rate limit conta por réplica, em memória. ' +
          'Não escale a API horizontalmente assim.',
      );
      this.client = null;
      return;
    }
    this.client = new Redis(url, {
      // Falha rápido em vez de enfileirar comandos enquanto desconectado: o
      // chamador cai no modo degradado sem segurar a requisição.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis indisponível: ${error.message}`);
    });
  }

  onModuleDestroy(): void {
    this.client?.disconnect();
  }
}

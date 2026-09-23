import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

/** O tipo do registro não é exportado pelo pacote; derivado da interface pública. */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Rate limit compartilhado entre réplicas, que não derruba a API com o Redis.
 *
 * Conta no Redis quando ele responde. Se o Redis falhar, a requisição não pode
 * virar erro 500 por causa do contador: cai para a contagem em memória desta
 * réplica — mais permissiva com várias réplicas, mas a API continua de pé — e
 * volta ao Redis na próxima requisição.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(ResilientThrottlerStorage.name);
  private readonly fallback = new ThrottlerStorageService();
  private degraded = false;

  constructor(private readonly primary: ThrottlerStorage | null) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (this.primary) {
      try {
        const record = await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
        if (this.degraded) {
          this.degraded = false;
          this.logger.log('Rate limit voltou a contar no Redis');
        }
        return record;
      } catch (error) {
        if (!this.degraded) {
          this.degraded = true;
          this.logger.warn(`Rate limit em memória: Redis falhou (${(error as Error).message})`);
        }
      }
    }
    return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
  }
}

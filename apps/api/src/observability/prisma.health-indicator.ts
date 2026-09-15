import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service';

/** Teto do check. Readiness que demora é readiness inútil. */
const TIMEOUT_MS = 2_000;

/**
 * Readiness do Postgres.
 *
 * `SELECT 1` de verdade, e não "o PrismaClient foi instanciado": o
 * `GET /` anterior respondia `ok` com o banco fora, que é o pior desfecho
 * possível — o orquestrador mantém no balanceador uma instância que só sabe
 * devolver erro.
 *
 * O timeout é explícito porque um Postgres saturado não recusa conexão: ele
 * aceita e não responde. Sem teto, o readiness ficaria pendurado junto e o
 * balanceador não tiraria a instância.
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async check(key = 'database'): Promise<HealthIndicatorResult> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, TIMEOUT_MS);
      return this.getStatus(key, true);
    } catch (error) {
      // A mensagem do driver pode carregar a connection string; só o tipo sai.
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      throw new HealthCheckError(
        'Postgres indisponível',
        this.getStatus(key, false, { errorType }),
      );
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

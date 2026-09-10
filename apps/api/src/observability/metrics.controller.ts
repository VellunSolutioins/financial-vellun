import { timingSafeEqual } from 'node:crypto';

import { Controller, Get, Logger, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { MetricsService } from './metrics.service';

/**
 * `GET /metrics` em formato Prometheus.
 *
 * Protegido por bearer token porque a exposição não é inócua: nomes de rota
 * revelam a superfície da API, e contadores revelam volume de negócio. O Alloy
 * é o único cliente esperado, e ele scrapa pela rede privada do Railway.
 *
 * O rate limit global fica de fora (`@SkipThrottle`): um scrape a cada 15s é
 * comportamento correto, não abuso, e ser throttled deixaria buracos na série.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async scrape(@Req() request: Request, @Res() response: Response): Promise<void> {
    this.assertAuthorized(request);

    const { body, contentType } = await this.metrics.scrape();
    response.setHeader('Content-Type', contentType);
    response.send(body);
  }

  /**
   * Exige `Authorization: Bearer ${METRICS_TOKEN}`.
   *
   * Sem `METRICS_TOKEN` configurado o endpoint fica **fechado**, não aberto:
   * variável esquecida no deploy não deve virar exposição pública. O sintoma
   * (scrape com 401) é ruidoso e fácil de diagnosticar; o contrário seria
   * silencioso.
   */
  private assertAuthorized(request: Request): void {
    const expected = this.config.get<string>('METRICS_TOKEN');
    if (!expected) {
      this.logger.error('METRICS_TOKEN não configurado; /metrics está fechado.');
      throw new UnauthorizedException('Coleta de métricas não configurada.');
    }

    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('Token de métricas inválido.');
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

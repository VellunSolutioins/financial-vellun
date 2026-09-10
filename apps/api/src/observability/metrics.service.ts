import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * Valor de `route` quando a requisição não casou com nenhuma rota (404).
 *
 * Existe para que 404 em massa (varredura de vulnerabilidade, cliente com URL
 * errada) fique **visível** sem trazer o path concreto para dentro do label —
 * que é exatamente o caminho para estourar o limite de séries do free tier.
 */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Métricas Prometheus da API.
 *
 * **Regra de cardinalidade, válida para todo o serviço**: `correlationId`,
 * `jobId`, telefone, e-mail, id de usuário e conteúdo de mensagem **nunca** viram
 * label. Eles vão para o log; o log é a ponte. Um label livre multiplica séries
 * por valor distinto e estoura o teto do Grafana Cloud — e aí a conta passa a
 * cobrar ou a descartar dado, silenciosamente.
 *
 * Por isso `route` é sempre o **padrão** da rota (`/transactions/:id`), nunca o
 * path concreto.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status'>;

  constructor() {
    this.registry.setDefaultLabels({
      service: 'api',
      env: process.env.NODE_ENV ?? 'development',
    });

    // Métricas de processo (heap, event loop lag, CPU, handles). São de
    // cardinalidade fixa e é o que responde "a API está sofrendo?".
    collectDefaultMetrics({ register: this.registry, prefix: 'vellun_api_' });

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Requisições HTTP atendidas, por método, rota e status.',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duração das requisições HTTP em segundos.',
      labelNames: ['method', 'route', 'status'],
      // Faixas escolhidas para a forma real do tráfego: quase tudo abaixo de
      // 500ms, com cauda até 10s (relatório do dashboard, chamada ao PSP).
      buckets: [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }

  observeHttpRequest(params: {
    method: string;
    route: string;
    status: number;
    durationSeconds: number;
  }): void {
    const labels = {
      method: params.method.toUpperCase(),
      route: params.route,
      status: String(params.status),
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, params.durationSeconds);
  }

  /** Exposição em texto Prometheus. */
  async scrape(): Promise<{ body: string; contentType: string }> {
    return {
      body: await this.registry.metrics(),
      contentType: this.registry.contentType,
    };
  }
}

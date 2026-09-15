import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * Valor de `route` quando a requisição não casou com nenhuma rota (404).
 *
 * Existe para que 404 em massa (varredura de vulnerabilidade, cliente com URL
 * errada) fique **visível** sem trazer o path concreto para dentro do label —
 * que é exatamente o caminho para estourar o limite de séries do free tier.
 */
export const UNMATCHED_ROUTE = 'unmatched';

/** Marcos do ciclo de vida de um evento de webhook do PSP. */
export type PaymentWebhookEvent = 'received' | 'processed' | 'failed' | 'exhausted';

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
  private readonly paymentWebhooks: Record<PaymentWebhookEvent, Counter<string>>;
  private readonly paymentWebhookPendingRetry: Gauge<string>;

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

    // Contadores separados, não um só com label `status`: os dashboards e os
    // dois alertas de pagamento (Entrega 3) já foram escritos contra estes
    // nomes, e eles ficaram inertes por `unless absent()` até existirem.
    const contador = (nome: string, help: string) =>
      new Counter({ name: `vellun_api_payment_webhook_${nome}`, help, registers: [this.registry] });

    this.paymentWebhooks = {
      received: contador('received_total', 'Eventos de webhook do PSP recebidos e persistidos.'),
      processed: contador('processed_total', 'Eventos de webhook do PSP processados com sucesso.'),
      failed: contador(
        'failed_total',
        'Tentativas de processamento que falharam e foram reagendadas.',
      ),
      exhausted: contador(
        'exhausted_total',
        'Eventos que esgotaram o retry. Cada um pode ser um pagamento sem acesso concedido.',
      ),
    };

    /**
     * Fila de retry, medida a cada varredura.
     *
     * É um gauge por **processo**, não um total do cluster: com mais de uma
     * réplica, todas reportam o mesmo número do banco. Some isso num painel e o
     * valor vira N vezes o real — por isso o dashboard usa `max`, e o alerta
     * compara série a série.
     */
    this.paymentWebhookPendingRetry = new Gauge({
      name: 'vellun_api_payment_webhook_pending_retry',
      help: 'Eventos de webhook aguardando nova tentativa (status failed).',
      registers: [this.registry],
    });
  }

  /** Marca um evento no ciclo de vida do webhook de pagamento. */
  observePaymentWebhook(evento: PaymentWebhookEvent, quantidade = 1): void {
    this.paymentWebhooks[evento].inc(quantidade);
  }

  setPaymentWebhookPendingRetry(total: number): void {
    this.paymentWebhookPendingRetry.set(total);
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

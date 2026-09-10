import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('expõe texto Prometheus com o content-type correto', async () => {
    const { body, contentType } = await metrics.scrape();

    expect(contentType).toContain('text/plain');
    expect(body).toContain('# HELP');
    expect(body).toContain('# TYPE');
  });

  it('rotula toda série com serviço e ambiente', async () => {
    // É o que permite distinguir api de ai-agent, e produção de staging, no
    // mesmo Prometheus.
    metrics.observeHttpRequest({
      method: 'get',
      route: '/transactions/:id',
      status: 200,
      durationSeconds: 0.05,
    });

    const { body } = await metrics.scrape();
    expect(body).toContain('service="api"');
    expect(body).toContain('env=');
  });

  it('normaliza o método para maiúsculas', async () => {
    // `get` e `GET` como labels distintos dobrariam as séries sem informar nada.
    metrics.observeHttpRequest({
      method: 'get',
      route: '/x',
      status: 200,
      durationSeconds: 0.01,
    });

    const { body } = await metrics.scrape();
    expect(body).toContain('method="GET"');
    expect(body).not.toContain('method="get"');
  });

  it('acumula contador e histograma na mesma observação', async () => {
    for (let i = 0; i < 3; i++) {
      metrics.observeHttpRequest({
        method: 'POST',
        route: '/transactions',
        status: 201,
        durationSeconds: 0.2,
      });
    }

    const { body } = await metrics.scrape();
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/transactions"[^}]*\} 3/);
    expect(body).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/transactions"[^}]*\} 3/,
    );
  });

  it('inclui métricas de processo com prefixo próprio', async () => {
    const { body } = await metrics.scrape();

    expect(body).toContain('vellun_api_process_');
  });
});

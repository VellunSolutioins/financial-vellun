import { OpsGrafanaService } from './ops-grafana.service';

function setup(env: Record<string, string | undefined>) {
  const config = { get: (chave: string) => env[chave] } as any;
  return new OpsGrafanaService(config);
}

describe('OpsGrafanaService', () => {
  describe('dashboards', () => {
    it('devolve lista vazia sem OPS_GRAFANA_URL, em vez de link quebrado', () => {
      expect(setup({}).dashboards()).toEqual([]);
    });

    it('monta as URLs a partir dos UIDs versionados em infra/observability', () => {
      const links = setup({ OPS_GRAFANA_URL: 'https://org.grafana.net' }).dashboards();

      expect(links).toHaveLength(4);
      expect(links.map((link) => link.key)).toEqual(['overview', 'api', 'whatsapp', 'payments']);
      expect(links[0].url).toBe('https://org.grafana.net/d/vellun-overview/vellun-visao-geral');
    });

    it('tolera barra final na configuração, sem duplicá-la na URL', () => {
      const [primeiro] = setup({ OPS_GRAFANA_URL: 'https://org.grafana.net//' }).dashboards();

      expect(primeiro.url).toBe('https://org.grafana.net/d/vellun-overview/vellun-visao-geral');
    });
  });

  describe('logsUrl', () => {
    const completo = {
      OPS_GRAFANA_URL: 'https://org.grafana.net',
      OPS_GRAFANA_LOKI_DATASOURCE_UID: 'loki-uid',
    };

    it('exige base, datasource e correlação — falta qualquer uma, não há link', () => {
      expect(setup(completo).logsUrl(null)).toBeNull();
      expect(setup({ OPS_GRAFANA_URL: completo.OPS_GRAFANA_URL }).logsUrl('corr-1')).toBeNull();
      expect(
        setup({
          OPS_GRAFANA_LOKI_DATASOURCE_UID: 'loki-uid',
        }).logsUrl('corr-1'),
      ).toBeNull();
    });

    it('filtra pela correlação nos dois serviços que escrevem log', () => {
      const url = setup(completo).logsUrl('corr-1');

      const panes = JSON.parse(new URL(url!).searchParams.get('panes')!);
      expect(panes.falha.queries[0].expr).toBe(
        '{service=~"api|ai-agent"} | json | correlationId="corr-1"',
      );
      expect(panes.falha.range).toEqual({ from: 'now-24h', to: 'now' });
    });

    it('escapa aspas na correlação, que entra numa expressão LogQL', () => {
      const url = setup(completo).logsUrl('a"b\\c');

      const panes = JSON.parse(new URL(url!).searchParams.get('panes')!);
      expect(panes.falha.queries[0].expr).toContain('correlationId="a\\"b\\\\c"');
    });
  });
});

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Um dashboard versionado em `infra/observability/dashboards/`. */
export interface GrafanaLink {
  key: string;
  label: string;
  url: string;
}

/**
 * Os UIDs vêm dos JSONs em `infra/observability/dashboards/`, que são a fonte de
 * verdade — o `uid` de cada arquivo é estável e sobrevive a renomear o título.
 */
const DASHBOARDS: { key: string; label: string; uid: string; slug: string }[] = [
  { key: 'overview', label: 'Visão geral', uid: 'vellun-overview', slug: 'vellun-visao-geral' },
  { key: 'api', label: 'API', uid: 'vellun-api', slug: 'vellun-api' },
  { key: 'whatsapp', label: 'Pipeline WhatsApp', uid: 'vellun-whatsapp', slug: 'vellun-whatsapp' },
  { key: 'payments', label: 'Pagamentos', uid: 'vellun-payments', slug: 'vellun-pagamentos' },
];

/**
 * Monta os links para o Grafana Cloud.
 *
 * O painel **não** consulta o Grafana: ele leva até lá. Proxyar consultas de
 * métrica pela API significaria carregar credencial de leitura do Grafana no
 * backend e reimplementar seletor de intervalo, o que não se paga — o Grafana já
 * é a ferramenta, e o operador já tem conta na organização.
 *
 * Sem `OPS_GRAFANA_URL` configurado, os métodos devolvem lista vazia e `null`, e
 * a tela some com a seção. Melhor do que oferecer link quebrado.
 */
@Injectable()
export class OpsGrafanaService {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('OPS_GRAFANA_URL')?.trim();
    if (!raw) return null;
    return raw.replace(/\/+$/, '');
  }

  dashboards(): GrafanaLink[] {
    const base = this.baseUrl;
    if (!base) return [];

    return DASHBOARDS.map((dashboard) => ({
      key: dashboard.key,
      label: dashboard.label,
      url: `${base}/d/${dashboard.uid}/${dashboard.slug}`,
    }));
  }

  /**
   * Link do Explore já filtrado por `correlationId` — a ponte entre uma falha do
   * catálogo e as linhas de log que a produziram.
   *
   * Exige também o UID da fonte de dados Loki (`OPS_GRAFANA_LOKI_DATASOURCE_UID`),
   * porque o Explore não aceita datasource por nome na URL. O `correlationId` é
   * gerado pela aplicação (UUID ou cabeçalho saneado), mas ainda assim vai entre
   * aspas escapadas: ele entra numa expressão LogQL.
   */
  logsUrl(correlationId: string | null, from = 'now-24h', to = 'now'): string | null {
    const base = this.baseUrl;
    const datasource = this.config.get<string>('OPS_GRAFANA_LOKI_DATASOURCE_UID')?.trim();
    if (!base || !datasource || !correlationId) return null;

    const escapado = correlationId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const expr = `{service=~"api|ai-agent"} | json | correlationId="${escapado}"`;

    const panes = {
      falha: {
        datasource,
        queries: [{ refId: 'A', datasource: { type: 'loki', uid: datasource }, expr }],
        range: { from, to },
      },
    };

    const params = new URLSearchParams({
      schemaVersion: '1',
      orgId: '1',
      panes: JSON.stringify(panes),
    });

    return `${base}/explore?${params.toString()}`;
  }
}

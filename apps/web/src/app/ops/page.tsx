'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { StatCard } from '@/components/ops/stat-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import { failureStatusLabels, paymentStatusLabels, type OpsOverview } from '@/lib/ops-types';

/**
 * Resumo da área de operações.
 *
 * Responde, na ordem: *está acontecendo agora?*, *o que está acumulado?* e *onde
 * vejo o detalhe?* — os números levam para a lista já filtrada, e os dashboards
 * levam para o Grafana, que é onde métrica e log de fato moram.
 */
export default function OpsOverviewPage() {
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await opsApiClient.get<OpsOverview>('/ops/overview'));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar o resumo.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-3">
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  if (!overview) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }

  const { failures, payments, grafana } = overview;
  const pendentes = failures.byStatus.pending;
  const presas = failures.byStatus.reprocessing;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Resumo</h1>
          <p className="text-sm text-muted-foreground">
            Atualizado em {formatDateTime(overview.generatedAt)}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Atualizar
        </Button>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Pipeline WhatsApp</h2>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Falhas pendentes"
            value={pendentes}
            emphasis={pendentes > 0}
            hint={
              failures.oldestPendingAt
                ? `mais antiga ${formatAge(failures.oldestPendingAt)}`
                : 'nada acumulado'
            }
          />
          <StatCard
            label="Capturadas em 24h"
            value={failures.last24h}
            hint="entradas novas no catálogo"
          />
          <StatCard
            label="Presas reprocessando"
            value={presas}
            emphasis={presas > 0}
            hint={presas > 0 ? 'publicar e marcar não são atômicos' : 'nenhuma em trânsito'}
          />
          <StatCard
            label="Reprocessadas"
            value={failures.byStatus.reprocessed}
            hint={`${failures.byStatus.discarded} descartada(s)`}
          />
        </div>

        {failures.topErrorTypes.length > 0 && (
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Erros mais frequentes entre as pendentes</CardTitle>
              <CardDescription>
                O que está quebrado agora — não o histórico do que já foi resolvido.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <ul className="space-y-1.5">
                {failures.topErrorTypes.map((item) => (
                  <li key={item.errorType} className="flex items-center justify-between gap-3">
                    <Link
                      href={`/ops/falhas?status=pending&errorType=${encodeURIComponent(item.errorType)}`}
                      className="min-w-0 truncate text-sm underline-offset-4 hover:underline"
                    >
                      {item.errorType}
                    </Link>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {item.count}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Button asChild variant="outline" size="sm">
          <Link href="/ops/falhas?status=pending">Ver falhas pendentes</Link>
        </Button>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Webhooks de pagamento</h2>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label={paymentStatusLabels.failed}
            value={payments.byStatus.failed}
            emphasis={payments.byStatus.failed > 0}
            hint={`${payments.last24hFailed} nas últimas 24h`}
          />
          <StatCard
            label="Em aberto"
            value={payments.byStatus.received + payments.byStatus.processing}
            hint={
              payments.oldestUnresolvedAt
                ? `mais antigo ${formatAge(payments.oldestUnresolvedAt)}`
                : 'nada em aberto'
            }
          />
          <StatCard label={paymentStatusLabels.processed} value={payments.byStatus.processed} />
          <StatCard
            label="Recebidos"
            value={Object.values(payments.byStatus).reduce((soma, n) => soma + n, 0)}
            hint="total histórico"
          />
        </div>

        <Button asChild variant="outline" size="sm">
          <Link href="/ops/pagamentos?status=failed">Ver eventos que falharam</Link>
        </Button>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Métricas e logs</h2>
        {grafana.dashboards.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sem <code>OPS_GRAFANA_URL</code> configurado, o painel não tem para onde apontar.
            Métrica e log continuam sendo coletados; só o atalho está desligado.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {grafana.dashboards.map((dashboard) => (
              <Button key={dashboard.key} asChild variant="outline" size="sm">
                <a href={dashboard.url} target="_blank" rel="noreferrer noopener">
                  {dashboard.label}
                </a>
              </Button>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        As contagens de falha vêm do catálogo em Postgres, nunca da DLQ: abrir esta página não
        consome fila. Estados possíveis:{' '}
        {Object.values(failureStatusLabels).join(', ').toLowerCase()}.
      </p>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { DefinitionList } from '@/components/ops/definition-list';
import { JsonBlock } from '@/components/ops/json-block';
import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { FailureStatusBadge } from '@/components/ops/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import { failureSourceLabels, type FailureDetail } from '@/lib/ops-types';

/**
 * Detalhe de uma falha do catálogo.
 *
 * Três blocos, na ordem em que a investigação acontece: *o que falhou*, *o que
 * chegou a ser processado* (payload, mascarado por padrão) e *para onde ir*
 * (log correlacionado). Reprocessar e descartar são a Entrega 7 — a tela diz
 * isso em vez de mostrar botão que não existe.
 */
export default function OpsFalhaDetalhePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [falha, setFalha] = useState<FailureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setFalha(await opsApiClient.get<FailureDetail>(`/ops/failures/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar a falha.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Falha</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/ops/falhas">Voltar à lista</Link>
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      {!falha && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}

      {falha && (
        <>
          <Card>
            <CardHeader className="p-4 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{falha.errorType}</CardTitle>
                <FailureStatusBadge status={falha.status} />
                <Badge variant="outline">{failureSourceLabels[falha.source]}</Badge>
                {falha.permanent && <Badge variant="destructive">Permanente</Badge>}
              </div>
              <CardDescription className="break-words">{falha.errorMessage}</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <DefinitionList
                items={[
                  { label: 'Fila de origem', value: falha.sourceQueue },
                  { label: 'Tentativas', value: falha.attempts },
                  {
                    label: 'Primeira falha',
                    value: `${formatDateTime(falha.firstFailedAt)} (${formatAge(falha.firstFailedAt)})`,
                  },
                  { label: 'Última falha', value: formatDateTime(falha.failedAt) },
                  {
                    label: 'Capturada no catálogo',
                    value: `${formatDateTime(falha.capturedAt)} (${formatAge(falha.capturedAt)})`,
                  },
                  { label: 'Reprocessada em', value: formatDateTime(falha.reprocessedAt) },
                  { label: 'Retenção até', value: formatDateTime(falha.retentionUntil) },
                  {
                    label: 'Correlação',
                    value: falha.correlationId ?? '—',
                    wide: true,
                  },
                  { label: 'Id da mensagem no provedor', value: falha.providerMessageId ?? '—' },
                  { label: 'Job', value: falha.jobId ?? '—' },
                  {
                    label: 'Telefone (hash)',
                    value: falha.phoneHash ?? '—',
                    wide: true,
                  },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Payload</CardTitle>
              <CardDescription>
                {falha.sensitiveRevealed
                  ? 'Conteúdo em claro. Esta visualização ficou registrada na auditoria.'
                  : 'Telefone e conteúdo aparecem mascarados. Ver em claro exige a permissão de dados sensíveis.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <JsonBlock value={falha.payload} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Investigação</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
              <div className="flex flex-wrap gap-2">
                {falha.logsUrl ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={falha.logsUrl} target="_blank" rel="noreferrer noopener">
                      Logs desta correlação
                    </a>
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {falha.correlationId
                      ? 'Sem Grafana configurado, não há atalho para os logs desta correlação.'
                      : 'Esta falha não tem correlação registrada — não há como filtrar o log por ela.'}
                  </p>
                )}
                {falha.correlationId && (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/ops/falhas?correlationId=${encodeURIComponent(falha.correlationId)}`}
                    >
                      Outras falhas da correlação
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline" size="sm">
                  <Link href={`/ops/auditoria?targetType=ops_failed_message&targetId=${falha.id}`}>
                    Histórico de ações
                  </Link>
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Reprocessar e descartar ainda não existem: são a Entrega 7, e dependem de destino
                validado por allowlist no servidor e de confirmação de publicação.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

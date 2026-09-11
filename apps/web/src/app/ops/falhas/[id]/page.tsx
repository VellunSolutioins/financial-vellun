'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ActionDialog } from '@/components/ops/action-dialog';
import { DefinitionList } from '@/components/ops/definition-list';
import { JsonBlock } from '@/components/ops/json-block';
import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { FailureStatusBadge } from '@/components/ops/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useOpsSession } from '@/contexts/ops-session-context';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import {
  failureSourceLabels,
  reprocessOutcomeLabels,
  type FailureDetail,
  type ReprocessItemResult,
} from '@/lib/ops-types';

type Acao = 'reprocess' | 'discard' | null;

/**
 * Detalhe de uma falha do catálogo.
 *
 * Quatro blocos, na ordem em que a investigação acontece: *o que falhou*, *o que
 * chegou a ser processado* (payload, mascarado por padrão), *o que fazer* e
 * *para onde ir* (log correlacionado, trilha da operação).
 */
export default function OpsFalhaDetalhePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const toast = useToast();
  const { hasRole } = useOpsSession();

  const [falha, setFalha] = useState<FailureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acao, setAcao] = useState<Acao>(null);
  const [ultimoDesfecho, setUltimoDesfecho] = useState<ReprocessItemResult | null>(null);

  const podeReprocessar = hasRole('operator', 'ops_admin');
  const podeDescartar = hasRole('ops_admin');

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

  const reprocessar = async (reason: string) => {
    try {
      const desfecho = await opsApiClient.post<ReprocessItemResult>(
        `/ops/failures/${id}/reprocess`,
        { reason },
      );
      setUltimoDesfecho(desfecho);

      if (desfecho.outcome === 'republished') {
        toast.success('Mensagem republicada na fila de origem.');
      } else {
        // Nem todo 200 é sucesso: o desfecho está no corpo, e tratar "recusada"
        // ou "sem desfecho" como vitória seria o pior erro possível desta tela.
        toast.error(`Reprocessamento ${reprocessOutcomeLabels[desfecho.outcome].toLowerCase()}.`);
      }
      setAcao(null);
      await load();
    } catch (err) {
      toast.error(err instanceof OpsApiError ? err.message : 'Não foi possível reprocessar.');
    }
  };

  const descartar = async (reason: string) => {
    try {
      await opsApiClient.post(`/ops/failures/${id}/discard`, { reason });
      toast.success('Falha descartada.');
      setAcao(null);
      await load();
    } catch (err) {
      toast.error(err instanceof OpsApiError ? err.message : 'Não foi possível descartar.');
    }
  };

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
                  { label: 'Republicada em', value: formatDateTime(falha.reprocessedAt) },
                  { label: 'Retenção até', value: formatDateTime(falha.retentionUntil) },
                  { label: 'Correlação', value: falha.correlationId ?? '—', wide: true },
                  { label: 'Id da mensagem no provedor', value: falha.providerMessageId ?? '—' },
                  { label: 'Job', value: falha.jobId ?? '—' },
                  { label: 'Telefone (hash)', value: falha.phoneHash ?? '—', wide: true },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Ações</CardTitle>
              <CardDescription>
                {falha.status === 'pending'
                  ? 'Reprocessar republica o payload original na fila de origem, com o mesmo destino de sempre — a rota nunca vem desta tela.'
                  : falha.status === 'reprocessing'
                    ? 'Uma solicitação está em curso. Se ela não concluir, a reconciliação devolve a falha a pendente em até 15 minutos.'
                    : 'Só falhas pendentes podem ser reprocessadas ou descartadas.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
              {falha.status === 'reprocessed' && (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  A mensagem foi <strong>republicada</strong>, o que não é o mesmo que processada
                  com sucesso — o catálogo não acompanha o pipeline depois da publicação.{' '}
                  {falha.subsequentFailures > 0 ? (
                    <>
                      Esta correlação voltou a falhar {falha.subsequentFailures} vez(es) depois
                      disso.
                    </>
                  ) : (
                    <>Nenhuma falha posterior desta correlação foi registrada.</>
                  )}
                </p>
              )}

              {ultimoDesfecho && ultimoDesfecho.outcome !== 'republished' && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                >
                  {reprocessOutcomeLabels[ultimoDesfecho.outcome]}
                  {ultimoDesfecho.detail ? `: ${ultimoDesfecho.detail}` : '.'}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!podeReprocessar || falha.status !== 'pending'}
                  onClick={() => setAcao('reprocess')}
                >
                  Reprocessar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={!podeDescartar || falha.status !== 'pending'}
                  onClick={() => setAcao('discard')}
                >
                  Descartar
                </Button>
              </div>

              {!podeReprocessar && (
                <p className="text-xs text-muted-foreground">
                  Seu papel permite ler, não agir. Reprocessar exige operador; descartar exige
                  admin.
                </p>
              )}
              {podeReprocessar && !podeDescartar && (
                <p className="text-xs text-muted-foreground">
                  Descartar exige admin: é a decisão de que esta mensagem do cliente não será
                  atendida, e ela não volta atrás.
                </p>
              )}
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
                {falha.lastOperationId && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/ops/auditoria?operationId=${falha.lastOperationId}`}>
                      Operação que a tocou
                    </Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <ActionDialog
            open={acao === 'reprocess'}
            title="Reprocessar falha"
            description={
              <>
                O payload original volta para a fila de origem. Reprocessar duas vezes não cria dois
                lançamentos — a idempotência do pipeline (<code>jobId</code>,{' '}
                <code>providerMessageId</code>) cuida disso.
              </>
            }
            confirmLabel="Reprocessar"
            onClose={() => setAcao(null)}
            onConfirm={reprocessar}
          />

          <ActionDialog
            open={acao === 'discard'}
            title="Descartar falha"
            destructive
            description="A mensagem não será reprocessada. Se era um lançamento de cliente, ele não vai acontecer."
            confirmLabel="Descartar"
            onClose={() => setAcao(null)}
            onConfirm={descartar}
          />
        </>
      )}
    </div>
  );
}

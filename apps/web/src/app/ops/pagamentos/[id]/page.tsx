'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ActionDialog } from '@/components/ops/action-dialog';
import { DefinitionList } from '@/components/ops/definition-list';
import { JsonBlock } from '@/components/ops/json-block';
import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { PaymentStatusBadge } from '@/components/ops/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useOpsSession } from '@/contexts/ops-session-context';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import { recoverOutcomeLabels, type PaymentEventDetail, type RecoverResult } from '@/lib/ops-types';

/**
 * Detalhe de um evento de webhook de pagamento.
 *
 * O payload já foi sanitizado no ingest (sem cartão nem segredo) e ainda passa
 * pela máscara de identidade na leitura — ver em claro exige a permissão de
 * dados sensíveis e deixa linha na auditoria.
 */
export default function OpsPagamentoDetalhePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const toast = useToast();
  const { hasRole } = useOpsSession();
  const podeRecuperar = hasRole('operator', 'ops_admin');

  const [evento, setEvento] = useState<PaymentEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState(false);
  const [ultimoDesfecho, setUltimoDesfecho] = useState<RecoverResult | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setEvento(await opsApiClient.get<PaymentEventDetail>(`/ops/payments/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar o evento.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const recuperar = async (reason: string) => {
    try {
      const desfecho = await opsApiClient.post<RecoverResult>(`/ops/payments/${id}/recover`, {
        reason,
      });
      setUltimoDesfecho(desfecho);

      if (desfecho.outcome === 'processed') {
        toast.success('Evento processado.');
      } else {
        // O 200 diz que a tentativa aconteceu, não que deu certo.
        toast.error(`Recuperação: ${recoverOutcomeLabels[desfecho.outcome].toLowerCase()}.`);
      }
      setDialogo(false);
      await load();
    } catch (err) {
      toast.error(err instanceof OpsApiError ? err.message : 'Não foi possível recuperar.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Evento de webhook</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/ops/pagamentos">Voltar à lista</Link>
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

      {!evento && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}

      {evento && (
        <>
          <Card>
            <CardHeader className="p-4 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{evento.eventType}</CardTitle>
                <PaymentStatusBadge status={evento.status} />
              </div>
              {evento.lastError && (
                <CardDescription className="break-words">{evento.lastError}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <DefinitionList
                items={[
                  { label: 'Id no provedor', value: evento.providerEventId, wide: true },
                  { label: 'Tentativas', value: evento.attempts },
                  {
                    label: 'Recebido',
                    value: `${formatDateTime(evento.receivedAt)} (${formatAge(evento.receivedAt)})`,
                  },
                  { label: 'Última tentativa', value: formatDateTime(evento.attemptedAt) },
                  { label: 'Processado', value: formatDateTime(evento.processedAt) },
                  {
                    label: 'Próxima tentativa',
                    value: evento.nextRetryAt ? formatDateTime(evento.nextRetryAt) : '—',
                  },
                  { label: 'Assinatura', value: evento.subscriptionId ?? '—', wide: true },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Payload</CardTitle>
              <CardDescription>
                {evento.sensitiveRevealed
                  ? 'Identidade do cliente em claro. Esta visualização ficou registrada na auditoria.'
                  : 'Nome, e-mail, documento e telefone aparecem mascarados. Cartão e segredos nunca são persistidos.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <JsonBlock value={evento.payload} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Recuperação</CardTitle>
              <CardDescription>
                {evento.status === 'exhausted'
                  ? 'O retry automático acabou. Recuperar devolve o evento à fila e roda uma tentativa agora.'
                  : evento.status === 'failed'
                    ? 'Há retry agendado: este evento vai ser tentado sozinho. Não há o que fazer até ele esgotar.'
                    : 'Só eventos esgotados são recuperáveis.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
              {ultimoDesfecho && ultimoDesfecho.outcome !== 'processed' && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                >
                  {recoverOutcomeLabels[ultimoDesfecho.outcome]}
                  {ultimoDesfecho.lastError ? `: ${ultimoDesfecho.lastError}` : '.'}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!podeRecuperar || evento.status !== 'exhausted'}
                  onClick={() => setDialogo(true)}
                >
                  Recuperar
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/ops/auditoria?targetType=payment_webhook_event&targetId=${evento.id}`}
                  >
                    Histórico de ações
                  </Link>
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Não há descarte aqui: descartar um evento de pagamento seria decidir que um dinheiro
                que entrou não será reconhecido.
              </p>
            </CardContent>
          </Card>

          <ActionDialog
            open={dialogo}
            title="Recuperar evento"
            description="O evento volta à fila e uma tentativa roda agora. Ela não reinicia o orçamento de tentativas: se falhar de novo, esgota na hora. Recupere depois de corrigir a causa."
            confirmLabel="Recuperar"
            onClose={() => setDialogo(false)}
            onConfirm={recuperar}
          />
        </>
      )}
    </div>
  );
}

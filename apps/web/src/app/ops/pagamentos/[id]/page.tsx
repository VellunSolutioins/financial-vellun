'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { DefinitionList } from '@/components/ops/definition-list';
import { JsonBlock } from '@/components/ops/json-block';
import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { PaymentStatusBadge } from '@/components/ops/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import type { PaymentEventDetail } from '@/lib/ops-types';

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

  const [evento, setEvento] = useState<PaymentEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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
                  { label: 'Processado', value: formatDateTime(evento.processedAt) },
                  { label: 'Última atualização', value: formatDateTime(evento.updatedAt) },
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
              <CardTitle className="text-sm">Investigação</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
              <Button asChild variant="outline" size="sm">
                <Link
                  href={`/ops/auditoria?targetType=payment_webhook_event&targetId=${evento.id}`}
                >
                  Histórico de ações
                </Link>
              </Button>
              <p className="text-xs text-muted-foreground">
                Reprocessar um evento que falhou é a Entrega 8 — e depende de corrigir antes a
                durabilidade do retry, não só de expor um botão.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

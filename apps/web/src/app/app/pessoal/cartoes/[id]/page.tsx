'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CreditCard as CreditCardIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CardSetupForm } from '@/components/credit-cards/CardSetupForm';
import { OpeningPositionForm } from '@/components/credit-cards/OpeningPositionForm';
import { ResourcePeriodView } from '@/components/resources/ResourcePeriodView';
import type { CreditCard } from '@/hooks/useCreditCards';
import { apiClient } from '@/lib/api-client';
import { formatDateBR } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** Um cartão: lançamentos por período. As faturas ficam na tela Faturas (docs/adrs/0020). */
export default function CartaoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const [card, setCard] = useState<CreditCard | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editingOpening, setEditingOpening] = useState(false);

  const load = useCallback(() => {
    apiClient
      .get<CreditCard>(`/credit-cards/${id}`)
      .then(setCard)
      .catch(() => setNotFound(true));
  }, [id]);
  useEffect(load, [load]);

  if (notFound) {
    return (
      <div className="space-y-4">
        <Link href="/app/pessoal/cartoes" className="text-sm underline">
          Voltar para Cartões
        </Link>
        <p className="text-sm text-muted-foreground">Cartão não encontrado.</p>
      </div>
    );
  }

  const indicators =
    card && !card.needsSetup
      ? [
          {
            label: 'Fatura atual',
            value: card.currentInvoice ?? 0,
            hint: `a pagar ${formatCurrency(card.currentInvoiceRemaining ?? 0)} · vence ${formatDateBR(card.currentDueDate!)}`,
          },
          {
            label: 'Parcelas futuras a pagar',
            value: card.futureInstallments ?? 0,
            hint:
              (card.futureCharges ?? 0) !== (card.futureInstallments ?? 0)
                ? `cobradas ${formatCurrency(card.futureCharges ?? 0)}, parte já paga`
                : undefined,
          },
          {
            label: 'Dívida efetiva',
            value: card.totalDebt ?? 0,
            hint:
              (card.appliedCredit ?? 0) > 0
                ? `bruta ${formatCurrency(card.grossDebt ?? 0)} − créditos ${formatCurrency(card.appliedCredit ?? 0)}`
                : (card.overdue ?? 0) > 0
                  ? `vencido ${formatCurrency(card.overdue ?? 0)}`
                  : undefined,
          },
          card.available !== null
            ? { label: 'Limite disponível (estimado)', value: card.available }
            : { label: 'Saldo credor', value: card.credit ?? 0 },
        ]
      : [];

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="space-y-1">
        <Link
          href="/app/pessoal/cartoes"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Cartões
        </Link>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
            style={{ backgroundColor: card?.color ?? '#94a3b8' }}
          >
            <CreditCardIcon className="h-4 w-4" />
          </span>
          <h1 className="min-w-0 truncate text-xl font-bold sm:text-2xl">{card?.name ?? '...'}</h1>
          {card && !card.isActive && <Badge variant="secondary">Arquivado</Badge>}
        </div>
        {card && !card.needsSetup && (
          <p className="text-sm text-muted-foreground">
            Fecha dia {card.closingDay} · vence dia {card.dueDay}
          </p>
        )}
      </div>

      {card?.needsSetup && (
        <Card className="rounded-2xl border-amber-200">
          <CardContent className="p-4">
            <p className="mb-3 text-sm font-medium">Configurar fechamento</p>
            <CardSetupForm card={card} onSuccess={load} onCancel={() => undefined} />
          </CardContent>
        </Card>
      )}

      {card && !card.needsSetup && (card.forecast ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          Previsto neste cartão: {formatCurrency(card.forecast ?? 0)} (assinaturas e compras com
          data futura). Entra na fatura em que vai cair, mas só vira dívida na data da cobrança.
        </p>
      )}

      {indicators.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:gap-4 lg:grid-cols-4">
          {indicators.map((item) => (
            <Card key={item.label} className="rounded-2xl">
              <CardContent className="p-3 sm:p-4">
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="truncate text-base font-bold sm:text-lg">
                  {formatCurrency(item.value)}
                </p>
                {'hint' in item && item.hint && (
                  <p className="text-xs text-muted-foreground">{item.hint}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {card && !card.needsSetup && (
        <Card className="rounded-2xl">
          <CardContent className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Posição inicial</p>
              {!editingOpening && (
                <Button size="sm" variant="outline" onClick={() => setEditingOpening(true)}>
                  {card.openingPosition ? 'Alterar' : 'Informar'}
                </Button>
              )}
            </div>
            {editingOpening ? (
              <OpeningPositionForm
                card={card}
                onSuccess={() => {
                  setEditingOpening(false);
                  load();
                }}
                onCancel={() => setEditingOpening(false)}
              />
            ) : card.openingPosition ? (
              <p className="text-xs text-muted-foreground">
                Fatura anterior ao controle:{' '}
                {formatCurrency(card.openingPosition.previousInvoiceAmount)}
                {card.openingPosition.previousInvoiceDueDate &&
                  ` (vence ${formatDateBR(card.openingPosition.previousInvoiceDueDate)})`}
                {card.openingPosition.credit > 0 &&
                  ` · crédito ${formatCurrency(card.openingPosition.credit)}`}
                . Aparece nas faturas e é paga como qualquer outra.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Compras de antes de{' '}
                {card.invoiceTrackingStart ? formatDateBR(card.invoiceTrackingStart) : '—'} ficam
                fora das faturas. Se a fatura anterior ainda não estava paga, informe aqui — o app
                não presume que foi paga.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {card && !card.needsSetup && (
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href={`/app/pessoal/faturas?cartao=${card.id}`}>Ver e pagar as faturas</Link>
        </Button>
      )}

      <ResourcePeriodView selection={{ accountIds: [], cardIds: [id] }} basis="card" />
    </div>
  );
}

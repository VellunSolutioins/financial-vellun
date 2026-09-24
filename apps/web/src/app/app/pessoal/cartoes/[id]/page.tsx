'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CreditCard as CreditCardIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { CardSetupForm } from '@/components/credit-cards/CardSetupForm';
import { InvoicesTab } from '@/components/credit-cards/InvoicesTab';
import { ResourcePeriodView } from '@/components/resources/ResourcePeriodView';
import type { CreditCard } from '@/hooks/useCreditCards';
import { apiClient } from '@/lib/api-client';
import { cn, formatDateBR } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

const TABS = [
  { key: 'periodo', label: 'Por período' },
  { key: 'faturas', label: 'Faturas' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** Um cartão: lançamentos por período (competência) e faturas. */
export default function CartaoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const [card, setCard] = useState<CreditCard | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>('faturas');

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
            hint: `vence ${formatDateBR(card.currentDueDate!)}`,
          },
          { label: 'Parcelas futuras', value: card.futureInstallments ?? 0 },
          { label: 'Dívida total', value: card.totalDebt ?? 0 },
          card.available !== null
            ? { label: 'Limite disponível', value: card.available }
            : { label: 'Crédito no cartão', value: card.credit ?? 0 },
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
            <CardSetupForm card={card} onSuccess={load} onCancel={() => setTab('periodo')} />
          </CardContent>
        </Card>
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

      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:inline-grid">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'h-9 rounded-md px-4 text-sm font-medium transition-colors',
              tab === t.key ? 'bg-background shadow-sm' : 'text-muted-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'periodo' ? (
        <ResourcePeriodView selection={{ accountIds: [], cardIds: [id] }} basis="card" />
      ) : card && !card.needsSetup ? (
        <InvoicesTab card={card} onChanged={load} />
      ) : (
        <p className="text-sm text-muted-foreground">
          As faturas aparecem depois de configurar o fechamento do cartão.
        </p>
      )}
    </div>
  );
}

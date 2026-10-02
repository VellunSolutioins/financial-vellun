'use client';
import { useEffect, useState } from 'react';
import { CreditCard as CreditCardIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { CategoryDonut, type CategoryShare } from '@/components/transactions/CategoryDonut';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface CardCommitment {
  accountId: string;
  name: string;
  color: string | null;
  creditLimit: number | null;
  /** O que falta pagar das compras parceladas deste cartão. */
  committed: number;
  /** `null` quando o cartão não tem limite cadastrado. */
  percentage: number | null;
  health: { key: string; label: string; message: string } | null;
}

export interface InstallmentsSummaryData {
  /** Só cartões com alguma parcela a pagar. */
  byCard: CardCommitment[];
  /** Restante a pagar (parcelas de hoje em diante). */
  remaining: number;
  byCategory: CategoryShare[];
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** Mesmas cores da barra de limite na tela de Cartões (faixas de card-health.ts na API). */
const healthStyles: Record<string, { bar: string; badge: string }> = {
  tranquilo: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
  saudavel: { bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700' },
  atencao: { bar: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700' },
  apertado: { bar: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700' },
  no_limite: { bar: 'bg-rose-500', badge: 'bg-rose-100 text-rose-700' },
  limite_atingido: { bar: 'bg-rose-600', badge: 'bg-rose-100 text-rose-700' },
};
const noLimitStyle = { bar: 'bg-muted-foreground/40', badge: 'bg-muted text-muted-foreground' };

function CardBar({ card }: { card: CardCommitment }) {
  const style = (card.health && healthStyles[card.health.key]) ?? noLimitStyle;
  const width = Math.max(0, Math.min(100, card.percentage ?? 0));
  return (
    <li className="space-y-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: card.color ?? '#94a3b8' }}
          />
          <span className="truncate">{card.name}</span>
        </span>
        <Badge className={cn('shrink-0', style.badge)}>
          {card.health?.label ?? 'Sem limite cadastrado'}
        </Badge>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-lg font-bold">{formatCurrency(card.committed)}</span>
        {card.creditLimit ? (
          <span className="text-sm text-muted-foreground">
            / {formatCurrency(card.creditLimit)} de limite
          </span>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={`Limite do ${card.name} ocupado pelas parcelas que faltam pagar`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full transition-all', style.bar)}
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {card.percentage !== null
          ? `Falta pagar destas compras: ocupa ${card.percentage.toFixed(0)}% do limite.`
          : 'Falta pagar destas compras. Cadastre o limite do cartão para ver quanto ele ocupa.'}
      </p>
    </li>
  );
}

interface Props {
  /** Muda a cada escrita na lista, para o resumo acompanhar. */
  version: number;
}

/**
 * Por cartão, quanto falta pagar das compras parceladas e quanto isso ocupa do
 * limite (cartão sem parcelamento não aparece); e o restante a pagar dos
 * parcelamentos por categoria.
 */
export function InstallmentsSummary({ version }: Props) {
  const [summary, setSummary] = useState<InstallmentsSummaryData | null>(null);

  useEffect(() => {
    let active = true;
    apiClient
      .get<InstallmentsSummaryData>('/installments/summary')
      .then((data) => active && setSummary(data))
      .catch(() => active && setSummary(null));
    return () => {
      active = false;
    };
  }, [version]);

  if (!summary || (summary.byCard.length === 0 && summary.byCategory.length === 0)) return null;

  return (
    <div className="space-y-4 sm:space-y-6">
      {summary.byCard.length > 0 && (
        <Card className="rounded-2xl">
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
                <CreditCardIcon className="h-4 w-4" />
              </span>
              <span className="text-sm text-muted-foreground">Parcelas no cartão a pagar</span>
            </div>
            <ul className="space-y-4">
              {summary.byCard.map((card) => (
                <CardBar key={card.accountId} card={card} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {summary.byCategory.length > 0 && (
        <CategoryDonut
          title="Parcelamentos por Categoria"
          subtitle={`Restante a pagar: ${formatCurrency(summary.remaining)}`}
          data={summary.byCategory}
        />
      )}
    </div>
  );
}

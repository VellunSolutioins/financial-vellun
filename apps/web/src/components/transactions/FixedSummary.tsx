'use client';
import { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { CategoryDonut, type CategoryShare } from '@/components/transactions/CategoryDonut';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export interface FixedSummaryData {
  income: number;
  committed: number;
  percentage: number;
  health: { key: string; label: string };
  byCategory: CategoryShare[];
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** Cores do selo/barra por faixa de comprometimento (ver buildFixedSummary na API). */
const healthStyles: Record<string, { bar: string; badge: string }> = {
  excelente: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
  saudavel: { bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700' },
  atencao: { bar: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700' },
  apertado: { bar: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700' },
  alto_risco: { bar: 'bg-rose-500', badge: 'bg-rose-100 text-rose-700' },
  sem_receita: { bar: 'bg-muted-foreground/40', badge: 'bg-muted text-muted-foreground' },
};

interface Props {
  /** Muda a cada escrita na lista, para o resumo acompanhar. */
  version: number;
}

/**
 * Comprometimento da receita fixa e divisão das despesas fixas por categoria,
 * no equivalente mensal das recorrências ativas (uma anual de R$ 1.200 conta
 * R$ 100 por mês).
 */
export function FixedSummary({ version }: Props) {
  const [summary, setSummary] = useState<FixedSummaryData | null>(null);

  useEffect(() => {
    let active = true;
    apiClient
      .get<FixedSummaryData>('/recurrences/summary')
      .then((data) => active && setSummary(data))
      .catch(() => active && setSummary(null));
    return () => {
      active = false;
    };
  }, [version]);

  const health = healthStyles[summary?.health.key ?? 'sem_receita'] ?? healthStyles.sem_receita;
  const barWidth = summary ? Math.max(0, Math.min(100, summary.percentage)) : 0;

  return (
    <>
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
                <Repeat className="h-4 w-4" />
              </span>
              <span className="text-sm text-muted-foreground">Comprometido com fixos</span>
            </div>
            <Badge className={health.badge}>{summary?.health.label ?? '—'}</Badge>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-2xl font-bold">{formatCurrency(summary?.committed ?? 0)}</span>
            <span className="text-sm text-muted-foreground">
              / {formatCurrency(summary?.income ?? 0)} de receita
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Receita fixa comprometida"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(barWidth)}
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn('h-full rounded-full transition-all', health.bar)}
              style={{ width: `${barWidth}%` }}
            />
          </div>
          {summary && summary.health.key !== 'sem_receita' && (
            <p className="text-xs text-muted-foreground">
              {summary.percentage.toFixed(0)}% da receita fixa comprometida com despesas fixas.
            </p>
          )}
        </CardContent>
      </Card>

      {summary && summary.byCategory.length > 0 && (
        <CategoryDonut title="Fixos por Categoria" data={summary.byCategory} />
      )}
    </>
  );
}

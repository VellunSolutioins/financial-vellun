'use client';
import { useEffect, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Repeat } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export interface FixedSummaryData {
  income: number;
  committed: number;
  percentage: number;
  health: { key: string; label: string };
  byCategory: {
    categoryId: string | null;
    categoryName: string;
    color: string | null;
    total: number;
    percentage: number;
  }[];
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function tooltipCurrency(v: unknown) {
  return typeof v === 'number' ? formatCurrency(v) : String(v);
}

const CATEGORY_COLORS = [
  '#10b981',
  '#3b82f6',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#14b8a6',
];

/** Cores do selo/barra por faixa de comprometimento (ver buildFixedSummary na API). */
const healthStyles: Record<string, { bar: string; badge: string }> = {
  excelente: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
  saudavel: { bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700' },
  atencao: { bar: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700' },
  apertado: { bar: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700' },
  alto_risco: { bar: 'bg-rose-500', badge: 'bg-rose-100 text-rose-700' },
  sem_receita: { bar: 'bg-muted-foreground/40', badge: 'bg-muted text-muted-foreground' },
};

function colorOf(c: FixedSummaryData['byCategory'][number], i: number) {
  return c.color ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length];
}

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
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">Fixos por Categoria</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <ResponsiveContainer width="100%" height={180} className="sm:max-w-[180px]">
                <PieChart>
                  <Pie
                    data={summary.byCategory}
                    dataKey="total"
                    nameKey="categoryName"
                    innerRadius={45}
                    outerRadius={75}
                  >
                    {summary.byCategory.map((c, i) => (
                      <Cell key={c.categoryId ?? `sem-${i}`} fill={colorOf(c, i)} />
                    ))}
                  </Pie>
                  <Tooltip formatter={tooltipCurrency} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="w-full space-y-2 text-sm sm:w-auto">
                {summary.byCategory.map((c, i) => (
                  <li
                    key={c.categoryId ?? `sem-${i}`}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: colorOf(c, i) }}
                      />
                      <span className="truncate">{c.categoryName}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatCurrency(c.total)} · {c.percentage.toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

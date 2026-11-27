'use client';
import { useEffect, useState } from 'react';
import { Amount, SectionHeading } from '@/components/dashboard/home-ledger';
import { TopCategories } from '@/components/dashboard/TopCategories';
import { type CategoryShare } from '@/components/transactions/CategoryDonut';
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

/** Cor da barra e do rótulo por faixa de comprometimento (ver buildFixedSummary na API). */
const healthStyles: Record<string, { bar: string; text: string }> = {
  excelente: { bar: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
  saudavel: { bar: 'bg-primary', text: 'text-primary' },
  atencao: { bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  apertado: { bar: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-400' },
  alto_risco: { bar: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
  sem_receita: { bar: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
};

interface Props {
  /** Muda a cada escrita na lista, para o resumo acompanhar. */
  version: number;
}

/**
 * Comprometimento da receita fixa e divisão das despesas fixas por categoria,
 * no equivalente mensal das recorrências ativas (uma anual de R$ 1.200 conta
 * R$ 100 por mês). O número principal vem com uma frase que diz o que ele
 * significa; as categorias, em linhas de extrato.
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
  const hasIncome = !!summary && summary.health.key !== 'sem_receita';

  return (
    <>
      <section
        aria-label="Comprometido com fixos"
        className="bg-glow-page relative overflow-hidden rounded-3xl border border-border p-6 shadow-sm sm:p-8"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-xs lowercase tracking-wide text-muted-foreground">
            <span className="text-primary">fixos</span> · por mês
          </p>
          <span className={cn('whitespace-nowrap font-mono text-xs lowercase', health.text)}>
            {summary?.health.label ?? '—'}
          </span>
        </div>
        <Amount
          value={summary?.committed ?? 0}
          animate
          className="mt-2 text-5xl font-bold tracking-tight sm:text-6xl"
        />
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          de {formatCurrency(summary?.income ?? 0)} de receita fixa
        </p>
        <div
          role="progressbar"
          aria-label="Receita fixa comprometida"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(barWidth)}
          className="mt-4 h-3 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn('h-full rounded-full transition-all', health.bar)}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground sm:text-base">
          {hasIncome ? (
            <>
              De cada R$ 100 da sua receita fixa,{' '}
              <em className="text-emphasis">
                R$ {Math.round(summary?.percentage ?? 0)} já têm destino
              </em>{' '}
              antes do mês começar.
            </>
          ) : (
            'Cadastre sua receita fixa (como o salário) para ver quanto dela os fixos ocupam.'
          )}
        </p>
      </section>

      {summary && summary.byCategory.length > 0 && (
        <section
          aria-labelledby="fixos-categorias"
          className="space-y-4 border-t border-border pt-6"
        >
          <SectionHeading
            id="fixos-categorias"
            number={1}
            eyebrow="por categoria"
            title="Para onde vão"
            emphasis="os fixos"
          />
          <TopCategories
            slices={summary.byCategory}
            label="Despesas fixas por categoria"
            emptyText="Sem despesas fixas."
          />
        </section>
      )}
    </>
  );
}

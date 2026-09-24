'use client';
import { useState } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { DateBasisNote } from '@/components/resources/DateBasisNote';
import { useTransactions } from '@/hooks/useTransactions';
import { useTransactionSummary } from '@/hooks/useTransactionSummary';
import { resourceQuery, type ResourceSelection } from '@/hooks/useResourceFilter';
import { cn, formatDateBR } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

interface Props {
  selection: ResourceSelection;
  basis?: 'competence' | 'card';
}

/**
 * Visão "Por período" de um recurso fixo (uma conta ou um cartão): totais,
 * despesas por categoria e a lista paginada, todos com o mesmo recorte.
 */
export function ResourcePeriodView({ selection, basis = 'competence' }: Props) {
  const [month, setMonth] = useState(currentMonth);
  const [page, setPage] = useState(1);
  const { start, end } = monthRange(month);
  const base = { periodStart: start, periodEnd: end, ...resourceQuery(selection) };

  const { data: summary } = useTransactionSummary(base);
  const { data, meta, loading } = useTransactions({ ...base, page, limit: 10 });
  const expenses = (summary?.byCategory ?? []).filter((c) => c.type === 'expense');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateBasisNote variant={basis} className="max-w-md" />
        <Input
          type="month"
          aria-label="Mês"
          value={month}
          onChange={(e) => {
            if (!e.target.value) return;
            setMonth(e.target.value);
            setPage(1);
          }}
          className="h-9 w-auto text-sm"
        />
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[
          { label: 'Receitas', value: summary?.income ?? 0, tone: 'text-emerald-600' },
          { label: 'Despesas', value: summary?.expense ?? 0, tone: 'text-rose-600' },
          {
            label: 'Resultado',
            value: summary?.net ?? 0,
            tone: (summary?.net ?? 0) >= 0 ? 'text-foreground' : 'text-rose-600',
          },
        ].map((item) => (
          <Card key={item.label} className="rounded-2xl">
            <CardContent className="p-3 sm:p-4">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className={cn('truncate text-sm font-bold sm:text-lg', item.tone)}>
                {formatCurrency(item.value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="rounded-2xl lg:col-span-2">
          <CardContent className="space-y-3 p-4">
            <p className="text-sm font-medium">Despesas por categoria</p>
            {expenses.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem despesas no período.</p>
            ) : (
              <ul className="space-y-3">
                {expenses.map((c) => (
                  <li key={c.categoryId ?? 'none'} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">{c.categoryName}</span>
                      <span className="shrink-0 font-medium">{formatCurrency(c.total)}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-rose-500"
                        style={{
                          width: `${Math.min(100, c.percentage)}%`,
                          backgroundColor: c.color ?? undefined,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl lg:col-span-3">
          <CardContent className="p-0">
            {loading ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Carregando...</p>
            ) : data.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                Nenhum lançamento no período.
              </p>
            ) : (
              <ul className="divide-y">
                {data.map((tx) => (
                  <li key={tx.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p
                        className={cn(
                          'truncate text-sm font-medium',
                          tx.status === 'cancelled' && 'text-muted-foreground line-through',
                        )}
                      >
                        {tx.description}
                        {tx.installmentTotal
                          ? ` (${tx.installmentNumber}/${tx.installmentTotal})`
                          : ''}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {formatDateBR(tx.transactionDate)} · {tx.category?.name ?? 'Sem categoria'}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-sm font-semibold',
                        tx.type === 'income' ? 'text-emerald-600' : 'text-rose-600',
                      )}
                    >
                      {tx.type === 'income' ? '+' : '-'}
                      {formatCurrency(Number(tx.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {meta.total > 0 && (
        <Pagination
          page={meta.page}
          totalPages={meta.total_pages}
          onPageChange={setPage}
          summary={`${meta.total} lançamento${meta.total === 1 ? '' : 's'}`}
        />
      )}
    </div>
  );
}

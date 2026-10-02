'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';
import type { TransactionFilters } from '@/hooks/useTransactions';

export interface CategoryTotal {
  type: 'income' | 'expense';
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  total: number;
  percentage: number;
}

export interface TransactionSummary {
  /** `due`: período pela data de vencimento; `event`: pela data do fato (compra). */
  dateBasis?: 'due' | 'event';
  income: number;
  expense: number;
  net: number;
  /** Ainda a receber/pagar (conta comum) entre os lançamentos filtrados. */
  openIncome: number;
  openExpense: number;
  count: number;
  byCategory: CategoryTotal[];
}

/**
 * Totais de `GET /transactions/summary` com os mesmos filtros da listagem — de
 * todas as páginas, não só da atual. Paginação e ordenação são ignoradas.
 */
export function useTransactionSummary(filters: Omit<TransactionFilters, 'page' | 'limit'>) {
  const [data, setData] = useState<TransactionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const filtersKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    Object.entries(JSON.parse(filtersKey) as Record<string, unknown>).forEach(([k, v]) => {
      if (v !== undefined && v !== '' && !['page', 'limit', 'sortBy', 'order'].includes(k)) {
        params.set(k, String(v));
      }
    });
    setLoading(true);
    apiClient
      .get<TransactionSummary>(`/transactions/summary?${params}`)
      .then((res) => !cancelled && setData(res))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filtersKey, version]);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);
  return { data, loading, refetch };
}

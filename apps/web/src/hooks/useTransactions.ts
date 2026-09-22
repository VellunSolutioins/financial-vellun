'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

export interface Transaction {
  id: string;
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  description: string;
  transactionDate: string;
  status: 'confirmed' | 'pending' | 'cancelled';
  source: 'manual' | 'whatsapp' | 'ai' | 'import' | 'recurring';
  categoryId?: string;
  accountId: string;
  category?: { id: string; name: string };
  account?: { id: string; name: string };
  createdAt: string;
}

export interface TransactionFilters {
  page?: number;
  limit?: number;
  type?: string;
  categoryId?: string;
  accountId?: string;
  status?: string;
  source?: string;
  search?: string;
  periodStart?: string;
  periodEnd?: string;
  sortBy?: string;
  order?: 'asc' | 'desc';
}

interface TransactionsResponse {
  data: Transaction[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages?: number;
    total_pages?: number;
  };
}

export function useTransactions(filters: TransactionFilters) {
  const [data, setData] = useState<Transaction[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 10, total_pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filtersKey = JSON.stringify(filters);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      Object.entries(JSON.parse(filtersKey) as TransactionFilters).forEach(([k, v]) => {
        if (v !== undefined && v !== '') params.set(k, String(v));
      });
      const res = await apiClient.get<TransactionsResponse>(`/transactions?${params}`);
      setData(res.data);
      setMeta({
        total: res.meta.total,
        page: res.meta.page,
        limit: res.meta.limit,
        total_pages: res.meta.total_pages ?? res.meta.totalPages ?? 1,
      });
    } catch {
      setError('Erro ao carregar lançamentos');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  useEffect(() => {
    void fetchTransactions();
  }, [fetchTransactions]);

  return { data, meta, loading, error, refetch: fetchTransactions };
}

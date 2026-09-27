'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

/**
 * Uma compra parcelada é a série de lançamentos `parcelado` com o mesmo
 * `seriesId` — não existe registro próprio.
 */
export interface Installment {
  seriesId: string;
  description: string;
  type: 'income' | 'expense';
  totalAmount: number;
  installmentAmount: number;
  installmentTotal: number;
  /** Parcelas que ainda existem (menos que o total se as futuras foram excluídas). */
  parcelCount: number;
  /** Parcelas com data anterior a hoje. */
  pastCount: number;
  /** Parcelas de hoje em diante. */
  futureCount: number;
  status: 'active' | 'finished' | 'cancelled';
  firstDate: string;
  lastDate: string;
  nextDate: string | null;
  nextNumber: number | null;
  accountId: string;
  categoryId: string | null;
  account?: { id: string; name: string; type?: string } | null;
  category?: { id: string; name: string; color?: string | null } | null;
  canDeleteAll: boolean;
  deleteAllBlockedReason: string | null;
  canDeleteFuture: boolean;
  deleteFutureBlockedReason: string | null;
  /** Parcela usada para estornar a compra inteira; null se não há o que estornar. */
  refundAnchorId: string | null;
}

export function useInstallments() {
  const [data, setData] = useState<Installment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInstallments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<Installment[]>('/installments'));
    } catch {
      setError('Erro ao carregar parcelamentos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInstallments();
  }, [fetchInstallments]);

  return { data, loading, error, refetch: fetchInstallments };
}

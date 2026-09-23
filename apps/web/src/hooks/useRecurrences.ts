'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export type RecurrenceFrequency = 'monthly' | 'bimonthly' | 'semiannual' | 'annual';

/**
 * Uma recorrência é a série de lançamentos fixos com o mesmo `seriesId` — não
 * existe registro próprio. Os campos descrevem a próxima ocorrência.
 */
export interface Recurrence {
  seriesId: string;
  description: string;
  type: 'income' | 'expense';
  amount: number;
  frequency: RecurrenceFrequency;
  dueDay: number;
  isActive: boolean;
  nextDate: string;
  /** Ocorrências confirmadas de hoje em diante. */
  remaining: number;
  accountId: string;
  categoryId: string | null;
  account?: { id: string; name: string } | null;
  category?: { id: string; name: string; color?: string | null } | null;
}

export function useRecurrences() {
  const [data, setData] = useState<Recurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecurrences = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<Recurrence[]>('/recurrences'));
    } catch {
      setError('Erro ao carregar recorrências');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRecurrences();
  }, [fetchRecurrences]);

  return { data, loading, error, refetch: fetchRecurrences };
}

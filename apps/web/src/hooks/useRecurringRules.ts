'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export type RecurringFrequency = 'monthly' | 'bimonthly' | 'semiannual' | 'annual';

export interface RecurringRule {
  id: string;
  type: 'income' | 'expense';
  description: string;
  amount: number;
  accountId: string;
  categoryId?: string | null;
  frequency: RecurringFrequency;
  dueDay: number;
  startDate: string;
  endDate?: string | null;
  isActive: boolean;
  category?: { id: string; name: string; color?: string | null } | null;
  account?: { id: string; name: string } | null;
}

export interface RecurringRuleSummary {
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

export function useRecurringRules() {
  const [data, setData] = useState<RecurringRule[]>([]);
  const [summary, setSummary] = useState<RecurringRuleSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const [rules, summaryData] = await Promise.all([
        apiClient.get<RecurringRule[]>('/recurring-rules'),
        apiClient.get<RecurringRuleSummary>('/recurring-rules/summary'),
      ]);
      setData(rules);
      setSummary(summaryData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, summary, loading, refetch };
}

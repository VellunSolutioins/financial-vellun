'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export interface SpendingGoal {
  id: string;
  categoryId: string;
  category: { id: string; name: string; color?: string | null };
  amount: number;
  spent: number;
  percentage: number;
  health: { key: string; label: string };
}

export interface SpendingGoalSummary {
  budget: number;
  spent: number;
  percentage: number;
  health: { key: string; label: string };
}

export function useSpendingGoals() {
  const [data, setData] = useState<SpendingGoal[]>([]);
  const [summary, setSummary] = useState<SpendingGoalSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const [goals, summaryData] = await Promise.all([
        apiClient.get<SpendingGoal[]>('/spending-goals'),
        apiClient.get<SpendingGoalSummary>('/spending-goals/summary'),
      ]);
      setData(goals);
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

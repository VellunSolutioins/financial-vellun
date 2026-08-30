'use client';
import { useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export interface FinancialScore {
  key: string;
  title: string;
  emoji: string;
  score: number;
  band: { key: string; label: string };
  description: string;
  indicators: { label: string; value: string }[];
}

export function useFinancialScores() {
  const [data, setData] = useState<FinancialScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiClient
      .get<FinancialScore[]>('/financial-analysis/scores')
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}

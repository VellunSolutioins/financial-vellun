'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export type SavingsYieldPeriod = 'monthly' | 'annual';

export interface SavingsContribution {
  id: string;
  amount: number;
  contributedAt: string;
  note?: string | null;
  yieldCompetence?: string | null;
}

export interface SavingsBox {
  id: string;
  name: string;
  color?: string | null;
  targetAmount: number | null;
  targetDate?: string | null;
  yieldRate?: number | null;
  yieldPeriod?: SavingsYieldPeriod | null;
  saved: number;
  percentage: number | null;
  progress: { key: string; label: string; message: string } | null;
  contributions: SavingsContribution[];
}

export function useSavingsBoxes() {
  const [data, setData] = useState<SavingsBox[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const boxes = await apiClient.get<SavingsBox[]>('/savings-boxes');
      setData(boxes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, refetch };
}

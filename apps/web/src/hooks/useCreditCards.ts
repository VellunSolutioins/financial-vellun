'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export interface CreditCard {
  id: string;
  accountId: string;
  name: string;
  brand?: string | null;
  color?: string | null;
  creditLimit: number | null;
  dueDay: number;
  isPrimary: boolean;
  currentInvoice: number;
  available: number | null;
  percentage: number | null;
  health: { key: string; emoji: string; label: string; message: string } | null;
}

export interface CreditCardSummary {
  totalCommitted: number;
  totalLimit: number;
  cardCount: number;
  monthlyIncome: number;
  incomePercentage: number | null;
  incomeHealth: { key: string; emoji: string; label: string } | null;
}

export function useCreditCards() {
  const [data, setData] = useState<CreditCard[]>([]);
  const [summary, setSummary] = useState<CreditCardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const [cards, summaryData] = await Promise.all([
        apiClient.get<CreditCard[]>('/credit-cards'),
        apiClient.get<CreditCardSummary>('/credit-cards/summary'),
      ]);
      setData(cards);
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

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
  closingDay: number | null;
  dueDay: number | null;
  /** `YYYY-MM-DD`: a partir daqui os lançamentos contam como dívida. */
  invoiceTrackingStart: string | null;
  paymentAccountId: string | null;
  /** Cartão legado sem fechamento/vencimento/início do controle. */
  needsSetup: boolean;
  isActive: boolean;
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
  const [archived, setArchived] = useState<CreditCard[]>([]);
  const [summary, setSummary] = useState<CreditCardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const [cards, summaryData] = await Promise.all([
        apiClient.get<CreditCard[]>('/credit-cards?includeArchived=true'),
        apiClient.get<CreditCardSummary>('/credit-cards/summary'),
      ]);
      setData(cards.filter((c) => c.isActive));
      setArchived(cards.filter((c) => !c.isActive));
      setSummary(summaryData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, archived, summary, loading, refetch };
}

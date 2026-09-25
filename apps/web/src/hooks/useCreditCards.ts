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
  /** Pré-selecionado em novos lançamentos (um só entre contas e cartões). */
  isPreferred: boolean;
  // Indicadores: todos nulos enquanto a configuração estiver pendente.
  /** Total da fatura aberta hoje. */
  currentInvoice: number | null;
  currentInvoiceRemaining: number | null;
  currentInvoiceId: string | null;
  currentClosingDate: string | null;
  currentDueDate: string | null;
  /** Cobranças em faturas que fecham depois da atual. */
  futureInstallments: number | null;
  /** Restante de faturas já fechadas. */
  closedUnpaid: number | null;
  totalDebt: number | null;
  /** Limite comprometido (= dívida total). */
  committed: number | null;
  /** Limite disponível para novas compras. */
  available: number | null;
  /** Pago acima do cobrado. */
  credit: number | null;
  percentage: number | null;
  health: { key: string; emoji: string; label: string; message: string } | null;
}

export type InvoicePaymentStatus = 'unpaid' | 'partial' | 'paid' | 'credit';

export interface CardInvoice {
  id: string;
  referenceMonth: string;
  periodStart: string;
  closingDate: string;
  dueDate: string;
  state: 'open' | 'closed';
  isCurrent: boolean;
  isFuture: boolean;
  charges: number;
  refunds: number;
  payments: number;
  total: number;
  remaining: number;
  paymentStatus: InvoicePaymentStatus;
}

export interface InvoiceItem {
  id: string;
  /** Compra/parcela ou estorno. */
  type: 'expense' | 'refund';
  description: string;
  amount: number;
  transactionDate: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  category: { id: string; name: string; color: string | null } | null;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  paymentDate: string;
  status: 'active' | 'reversed';
  reversedAt: string | null;
  sourceAccount: { id: string; name: string };
}

/** Fatura com os lançamentos que a compõem e os pagamentos. */
export interface CardInvoiceDetail extends CardInvoice {
  items: InvoiceItem[];
  paymentRecords: InvoicePayment[];
}

export interface CreditCardSummary {
  /** Dívida total dos cartões configurados. */
  totalCommitted: number;
  /** Soma das faturas abertas hoje. */
  totalCurrentInvoices: number;
  totalLimit: number;
  cardCount: number;
  pendingSetupCount: number;
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

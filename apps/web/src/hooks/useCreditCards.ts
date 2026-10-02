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
  /** `false`: sem configuração, a dívida é desconhecida (não é zero). */
  debtKnown: boolean;
  /** Fatura anterior não paga e crédito no início do controle. */
  openingPosition: {
    previousInvoiceAmount: number;
    previousInvoiceDueDate: string | null;
    credit: number;
  } | null;
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
  /** Cobranças efetivas em faturas futuras (bruto). */
  futureCharges: number | null;
  /** O que ainda falta pagar das faturas futuras (sem o pago antecipado). */
  futureInstallments: number | null;
  /** Restante de faturas já fechadas. */
  closedUnpaid: number | null;
  /** Restante de faturas vencidas. */
  overdue: number | null;
  /** Assinaturas e compras futuras previstas: não são dívida. */
  forecast: number | null;
  /** Soma dos restantes antes dos créditos entre faturas. */
  grossDebt: number | null;
  /** Créditos aplicados entre faturas. */
  appliedCredit: number | null;
  /** Dívida efetiva (depois de pagamentos e créditos). */
  totalDebt: number | null;
  /** Limite comprometido (= dívida efetiva). */
  committed: number | null;
  /** Limite disponível estimado para novas compras. */
  available: number | null;
  /** Saldo credor: crédito sem cobrança onde ser aplicado. */
  credit: number | null;
  percentage: number | null;
  health: { key: string; emoji: string; label: string; message: string } | null;
}

export type InvoicePaymentStatus = 'unpaid' | 'partial' | 'paid' | 'credit';

/** Crédito aplicado entre faturas do mesmo cartão (origem ou destino). */
export interface CreditApplication {
  invoiceId: string;
  referenceMonth: string;
  amount: number;
}

export interface CardInvoice {
  id: string;
  referenceMonth: string;
  periodStart: string;
  closingDate: string;
  dueDate: string;
  state: 'open' | 'closed';
  isCurrent: boolean;
  isFuture: boolean;
  /** Fatura anterior ao início do controle (posição inicial). */
  isOpening: boolean;
  isOverdue: boolean;
  charges: number;
  refunds: number;
  payments: number;
  openingDebt: number;
  openingCredit: number;
  /** Cobranças previstas (fora do total e da dívida). */
  forecast: number;
  total: number;
  /** Restante antes de créditos de outras faturas. */
  grossRemaining: number;
  /** Créditos de outras faturas aplicados aqui, com a origem. */
  creditsApplied: CreditApplication[];
  /** O que falta pagar (nunca negativo). */
  remaining: number;
  /** Crédito que esta fatura gerou e para onde foi. */
  surplus: number;
  surplusAppliedTo: CreditApplication[];
  unappliedSurplus: number;
  paymentStatus: InvoicePaymentStatus;
}

export interface InvoiceItem {
  id: string;
  /** Compra/parcela, estorno ou posição inicial. */
  type: 'expense' | 'refund' | 'opening_debt' | 'opening_credit';
  /** Data do fato ainda não chegou: previsão, não cobrança efetiva. */
  isForecast?: boolean;
  description: string;
  amount: number;
  transactionDate: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  /** Parcela adiantada para esta fatura. */
  advancedAt?: string | null;
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
  /** Dívida efetiva de todos os cartões configurados, inclusive arquivados. */
  totalDebt: number;
  /** Limite comprometido dos cartões ativos. */
  totalCommitted: number;
  /** Soma das faturas abertas hoje. */
  totalCurrentInvoices: number;
  totalOverdue: number;
  totalFutureInstallments: number;
  totalForecast: number;
  /** Saldo credor somado. */
  totalCredit: number;
  /** Limite dos cartões ativos. */
  totalLimit: number;
  totalAvailable: number;
  cardCount: number;
  archivedCount: number;
  archivedWithDebtCount: number;
  pendingSetupCount: number;
  /** Cartões sem configuração: a dívida deles fica fora do total (desconhecida). */
  incompleteCards: number;
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

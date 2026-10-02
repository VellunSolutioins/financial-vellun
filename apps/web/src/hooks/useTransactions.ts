'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';
import type { LedgerType, SettlementState } from '@/lib/transaction-display';

export interface Transaction {
  id: string;
  /** `refund` = estorno; `transfer` = perna de pagamento de fatura ou de transferência. */
  type: LedgerType;
  amount: number;
  description: string;
  /** Data da ocorrência: vencimento ou previsão (na parcela, a data dela). */
  transactionDate: string;
  /** Data do fato (na parcela, a da compra). */
  eventDate?: string;
  /** Previsão (ex.: assinatura): não é obrigação constituída. */
  forecast?: boolean;
  /** Estado de liquidação calculado pela API. */
  state?: SettlementState;
  /** Quanto já foi pago/recebido. */
  settledAmount?: number;
  /** Quanto ainda falta (0 se liquidado, de cartão ou movimentação). */
  remaining?: number;
  /** Em aberto com vencimento passado: continua visível até ser pago. */
  isOverdue?: boolean;
  purchaseId?: string | null;
  accountTransferId?: string | null;
  status: 'confirmed' | 'cancelled';
  source: 'manual' | 'whatsapp' | 'ai' | 'import' | 'recurring';
  categoryId?: string;
  accountId: string;
  category?: { id: string; name: string };
  /** `type: credit_card` = conta interna de um cartão. */
  account?: { id: string; name: string; type?: string };
  recurrenceType: 'avulso' | 'fixo' | 'parcelado';
  recurrenceFrequency?: 'monthly' | 'bimonthly' | 'semiannual' | 'annual' | null;
  seriesId?: string | null;
  installmentNumber?: number | null;
  installmentTotal?: number | null;
  invoiceId?: string | null;
  refundOfId?: string | null;
  cardPaymentId?: string | null;
  transferDirection?: 'in' | 'out' | null;
  /** Parcela adiantada: data do adiantamento (ver AdvanceInstallmentDialog). */
  advancedAt?: string | null;
  /** Data prevista da parcela antes do adiantamento. */
  advancedFromDate?: string | null;
  /** Valor antes do desconto do adiantamento; nulo sem desconto. */
  amountBeforeAdvance?: number | null;
  createdAt: string;
}

export interface TransactionFilters {
  page?: number;
  limit?: number;
  type?: string;
  categoryId?: string;
  accountId?: string;
  /** Ids separados por vírgula (ver `resourceQuery`). */
  accountIds?: string;
  cardIds?: string;
  status?: string;
  source?: string;
  search?: string;
  recurrenceType?: string;
  periodStart?: string;
  periodEnd?: string;
  /** Estado de liquidação: open, partial, settled, overdue ou forecast. */
  settlement?: string;
  /** A que data o período se aplica: vencimento (`due`, padrão) ou fato (`event`). */
  dateBasis?: 'due' | 'event';
  sortBy?: string;
  order?: 'asc' | 'desc';
}

interface TransactionsResponse {
  data: Transaction[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages?: number;
    total_pages?: number;
  };
}

export function useTransactions(filters: TransactionFilters) {
  const [data, setData] = useState<Transaction[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, total_pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filtersKey = JSON.stringify(filters);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      Object.entries(JSON.parse(filtersKey) as TransactionFilters).forEach(([k, v]) => {
        if (v !== undefined && v !== '') params.set(k, String(v));
      });
      const res = await apiClient.get<TransactionsResponse>(`/transactions?${params}`);
      setData(res.data);
      setMeta({
        total: res.meta.total,
        page: res.meta.page,
        limit: res.meta.limit,
        total_pages: res.meta.total_pages ?? res.meta.totalPages ?? 1,
      });
    } catch {
      setError('Erro ao carregar lançamentos');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  useEffect(() => {
    void fetchTransactions();
  }, [fetchTransactions]);

  return { data, meta, loading, error, refetch: fetchTransactions };
}

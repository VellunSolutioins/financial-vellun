'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  /**
   * A que data o período se aplica: vencimento (`due`, padrão), fato (`event`)
   * ou mês do gasto (`spending`: a parcela no mês dela, como no dashboard).
   */
  dateBasis?: 'due' | 'event' | 'spending';
  /** Só gastos realizados (mesmo critério do dashboard). */
  realizedOnly?: boolean;
  /** Abas da listagem: vencimento até hoje (`past`) ou de amanhã em diante (`upcoming`). */
  timing?: 'past' | 'upcoming';
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

type Meta = { total: number; page: number; limit: number; total_pages: number };
type Page = { data: Transaction[]; meta: Meta; at: number };

/**
 * Páginas já carregadas, por filtro (inclusive página, ordem e aba). Voltar a
 * uma aba ou página mostra o que já se tinha na hora e revalida em segundo
 * plano; uma escrita (`refetch`) descarta tudo. Fica na memória da aba do
 * navegador: dado financeiro não é guardado em disco nem no servidor.
 */
const pageCache = new Map<string, Page>();
/** Até aqui, reaproveita sem nem revalidar (trocar de aba e voltar logo). */
const FRESH_MS = 30_000;
const MAX_ENTRIES = 50;

const keyOf = (filters: TransactionFilters) => JSON.stringify(filters);

async function loadPage(key: string): Promise<Page> {
  const params = new URLSearchParams();
  Object.entries(JSON.parse(key) as TransactionFilters).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v));
  });
  const res = await apiClient.get<TransactionsResponse>(`/transactions?${params}`);
  const page: Page = {
    data: res.data,
    meta: {
      total: res.meta.total,
      page: res.meta.page,
      limit: res.meta.limit,
      total_pages: res.meta.total_pages ?? res.meta.totalPages ?? 1,
    },
    at: Date.now(),
  };
  pageCache.delete(key);
  pageCache.set(key, page);
  // Descarta as mais antigas: a ordem de inserção do Map é a de uso.
  while (pageCache.size > MAX_ENTRIES) pageCache.delete(pageCache.keys().next().value!);
  return page;
}

/** Esquece tudo o que estava guardado (logout, troca de usuário). */
export function clearTransactionsCache() {
  pageCache.clear();
}

/** Carrega uma página em segundo plano (ex.: a outra aba), se ainda não houver. */
export function prefetchTransactions(filters: TransactionFilters) {
  const key = keyOf(filters);
  if (pageCache.has(key)) return;
  void loadPage(key).catch(() => undefined);
}

/**
 * Lançamentos com os filtros dados. `loading` só quando não há nada para
 * mostrar; ao trocar de filtro sem a página guardada, a lista anterior continua
 * na tela (`refreshing`) até a nova chegar — a tela não pisca nem muda de
 * altura. Revalidar a mesma lista acontece em segundo plano, sem aviso.
 */
export function useTransactions(filters: TransactionFilters) {
  const key = keyOf(filters);
  const [page, setPage] = useState<(Page & { key: string }) | null>(() => {
    const hit = pageCache.get(key);
    return hit ? { ...hit, key } : null;
  });
  const [error, setError] = useState<string | null>(null);
  // Filtro atual: respostas de um filtro anterior (troca rápida de aba) são ignoradas.
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(
    async (force: boolean) => {
      const hit = pageCache.get(key);
      if (hit) setPage({ ...hit, key });
      if (!force && hit && Date.now() - hit.at < FRESH_MS) return;
      setError(null);
      try {
        const fresh = await loadPage(key);
        if (keyRef.current === key) setPage({ ...fresh, key });
      } catch {
        if (keyRef.current === key) setError('Erro ao carregar lançamentos');
      }
    },
    [key],
  );

  // Ao abrir a tela, revalida mesmo o que está guardado: outra tela pode ter
  // mudado os lançamentos (pagar fatura, receber). Depois, só o que envelheceu.
  const mounted = useRef(false);
  useEffect(() => {
    void load(!mounted.current);
    mounted.current = true;
  }, [load]);

  /** Depois de uma escrita: tudo o que estava guardado pode ter mudado. */
  const refetch = useCallback(async () => {
    pageCache.clear();
    await load(true);
  }, [load]);

  return {
    data: page?.data ?? [],
    meta: page?.meta ?? { total: 0, page: 1, limit: 20, total_pages: 1 },
    loading: page === null && !error,
    /** Mostrando a lista do filtro anterior enquanto a nova carrega. */
    refreshing: page !== null && page.key !== key && !error,
    error,
    refetch,
  };
}

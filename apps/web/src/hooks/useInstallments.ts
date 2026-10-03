'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

/**
 * Uma compra parcelada: a compra (data e total próprios, `seriesId`) e as
 * parcelas como calendário de cobrança (docs/adrs/0018).
 */
export interface Installment {
  seriesId: string;
  description: string;
  type: 'income' | 'expense';
  /** Data da compra: é nela que o gasto conta, não em cada parcela. */
  purchaseDate: string;
  /** Compra cadastrada com data futura: previsão, ainda não é compromisso. */
  isForecast: boolean;
  /** Valor contratado (antes de descontos e cancelamentos). */
  contractAmount: number | null;
  /** O que ainda falta pagar das parcelas (já sem o pago). */
  remainingCommitment: number;
  totalAmount: number;
  installmentAmount: number;
  installmentTotal: number;
  /** Parcelas que ainda existem (menos que o total se as futuras foram excluídas). */
  parcelCount: number;
  /** Parcelas com data anterior a hoje. */
  pastCount: number;
  /** Parcelas de hoje em diante. */
  futureCount: number;
  status: 'active' | 'finished' | 'cancelled';
  firstDate: string;
  lastDate: string;
  nextDate: string | null;
  nextNumber: number | null;
  /** Parcela do mês atual (no cartão, a da fatura aberta); 0 se a compra ainda não começou. */
  currentNumber: number;
  /** Primeira parcela de um mês seguinte (não adiantada). */
  upcomingNumber: number | null;
  upcomingDate: string | null;
  accountId: string;
  categoryId: string | null;
  account?: { id: string; name: string; type?: string } | null;
  category?: { id: string; name: string; color?: string | null } | null;
  canDeleteAll: boolean;
  deleteAllBlockedReason: string | null;
  canDeleteFuture: boolean;
  deleteFutureBlockedReason: string | null;
  /** Parcela usada para estornar a compra inteira; null se não há o que estornar. */
  refundAnchorId: string | null;
  /** Parcelas que podem ser adiantadas, da última para a primeira. */
  advanceable: {
    id: string;
    installmentNumber: number | null;
    amount: number;
    transactionDate: string;
  }[];
  /** Por que não há o que adiantar; null quando há. */
  advanceBlockedReason: string | null;
  /** Parcelas já adiantadas. */
  advancedCount: number;
}

export function useInstallments() {
  const [data, setData] = useState<Installment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInstallments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<Installment[]>('/installments'));
    } catch {
      setError('Erro ao carregar parcelamentos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInstallments();
  }, [fetchInstallments]);

  return { data, loading, error, refetch: fetchInstallments };
}

/**
 * Uma compra para os diálogos de parcelamento: a recebida pronta (tela de
 * Parcelamentos) ou buscada pelo `seriesId` quando o diálogo abre (tela de
 * Lançamentos). Resposta de uma busca anterior é descartada — abrir A, fechar
 * e abrir B não pode terminar mostrando (e agindo sobre) A.
 */
export function useInstallment({
  installment: given,
  seriesId,
  open,
}: {
  installment?: Installment;
  seriesId?: string;
  open: boolean;
}) {
  const [fetched, setFetched] = useState<Installment | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFetched(null);
    setFailed(false);
    if (!open || given || !seriesId) return;
    let stale = false;
    apiClient
      .get<Installment>(`/installments/${seriesId}`)
      .then((i) => !stale && setFetched(i))
      .catch(() => !stale && setFailed(true));
    return () => {
      stale = true;
    };
  }, [open, given, seriesId]);

  return { installment: given ?? fetched, failed };
}

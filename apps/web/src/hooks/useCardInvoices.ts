'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';
import type { CardInvoice, CardInvoiceDetail } from '@/hooks/useCreditCards';

/** Faturas de um cartão, da mais antiga para a mais nova (`GET /credit-cards/:id/invoices`). */
export function useCardInvoices(cardId: string | null) {
  const [data, setData] = useState<CardInvoice[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!cardId) return;
    let cancelled = false;
    setData(null);
    apiClient
      .get<CardInvoice[]>(`/credit-cards/${cardId}/invoices`)
      .then((rows) => {
        if (cancelled) return;
        setData([...rows].sort((a, b) => a.referenceMonth.localeCompare(b.referenceMonth)));
      })
      .catch(() => !cancelled && setData([]));
    return () => {
      cancelled = true;
    };
  }, [cardId, version]);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);
  return { data, refetch };
}

/** Uma fatura com as compras e os pagamentos (`GET /credit-cards/:id/invoices/:invoiceId`). */
export function useInvoiceDetail(cardId: string | null, invoiceId: string | null) {
  const [data, setData] = useState<CardInvoiceDetail | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!cardId || !invoiceId) {
      setData(null);
      return;
    }
    let cancelled = false;
    apiClient
      .get<CardInvoiceDetail>(`/credit-cards/${cardId}/invoices/${invoiceId}`)
      .then((detail) => !cancelled && setData(detail))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [cardId, invoiceId, version]);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);
  return { data, refetch };
}

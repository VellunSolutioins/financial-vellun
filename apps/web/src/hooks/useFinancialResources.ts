'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export interface ResourceAccount {
  id: string;
  name: string;
  type: string;
  currentBalance: number;
}

/** Cartão como recurso de lançamento: o valor gravado no lançamento é o `accountId`. */
export interface ResourceCard {
  id: string;
  accountId: string;
  name: string;
  brand: string | null;
  color: string | null;
  isPrimary: boolean;
  needsSetup: boolean;
  isActive: boolean;
}

export interface FinancialResources {
  accounts: ResourceAccount[];
  cards: ResourceCard[];
}

/** Contas comuns e cartões do usuário, separados (`GET /financial-resources`). */
export function useFinancialResources() {
  const [data, setData] = useState<FinancialResources | null>(null);

  const refetch = useCallback(async () => {
    try {
      setData(await apiClient.get<FinancialResources>('/financial-resources'));
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, refetch };
}

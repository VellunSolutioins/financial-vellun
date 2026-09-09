'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

import {
  OpsApiError,
  type OpsOperatorSession,
  type OpsRole,
  opsApiClient,
} from '@/lib/ops-api-client';

interface OpsSessionContextValue {
  operator: OpsOperatorSession | null;
  loading: boolean;
  /** Relê a sessão no servidor (também é o que renova o cookie deslizante). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** `true` se o papel do operador está entre os informados. */
  hasRole: (...roles: OpsRole[]) => boolean;
}

const OpsSessionContext = createContext<OpsSessionContextValue>({
  operator: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
  hasRole: () => false,
});

/**
 * Sessão do operador, **isolada** da do produto (`AuthProvider`).
 *
 * As duas coexistem no mesmo app Next sem se enxergar: são cookies e endpoints
 * diferentes, e nenhuma delas serve de fallback para a outra.
 */
export function OpsSessionProvider({ children }: { children: React.ReactNode }) {
  const [operator, setOperator] = useState<OpsOperatorSession | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setOperator(await opsApiClient.get<OpsOperatorSession>('/ops/auth/me'));
    } catch (error) {
      // 403 aqui é o caso normal de "não logado" — a área de operações nunca
      // responde 401, para não convidar o usuário do produto a autenticar.
      if (error instanceof OpsApiError && error.isSessionMissing) {
        setOperator(null);
        return;
      }
      setOperator(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await opsApiClient.post('/ops/auth/logout');
    } finally {
      // Mesmo se o POST falhar, a sessão local vai embora: melhor pedir login de
      // novo do que deixar a tela parecendo autenticada.
      setOperator(null);
    }
  }, []);

  const hasRole = useCallback(
    (...roles: OpsRole[]) => (operator ? roles.includes(operator.role) : false),
    [operator],
  );

  return (
    <OpsSessionContext.Provider value={{ operator, loading, refresh, logout, hasRole }}>
      {children}
    </OpsSessionContext.Provider>
  );
}

export function useOpsSession() {
  return useContext(OpsSessionContext);
}

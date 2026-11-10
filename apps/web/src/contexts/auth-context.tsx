'use client';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { type User, getMe, logout as logoutApi } from '@/lib/auth';
import { type SubscriptionAccess, getSubscription } from '@/lib/billing';
import { type FeatureFlags, allFeaturesOff, getFeatures } from '@/lib/features';
import { clearTransactionsCache } from '@/hooks/useTransactions';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  subscriptionAccess: SubscriptionAccess | null;
  /** Funcionalidades ligadas no /ops. `null` enquanto carrega (ou sem usuário). */
  features: FeatureFlags | null;
  setUser: (user: User | null) => void;
  refreshSubscriptionAccess: () => Promise<void>;
  refreshFeatures: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  subscriptionAccess: null,
  features: null,
  setUser: () => {},
  refreshSubscriptionAccess: async () => {},
  refreshFeatures: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscriptionAccess, setSubscriptionAccess] = useState<SubscriptionAccess | null>(null);
  const [features, setFeatures] = useState<FeatureFlags | null>(null);

  const refreshSubscriptionAccess = useCallback(async () => {
    try {
      const state = await getSubscription();
      setSubscriptionAccess(state.access);
    } catch {
      setSubscriptionAccess(null);
    }
  }, []);

  // Em caso de erro, trata tudo como desligado: as rotas com flag mostram o
  // dashboard em vez de uma página que a API recusaria de qualquer forma.
  const refreshFeatures = useCallback(async () => {
    try {
      setFeatures(await getFeatures());
    } catch {
      setFeatures(allFeaturesOff());
    }
  }, []);

  useEffect(() => {
    getMe()
      .then((u) => {
        setUser(u);
        void refreshSubscriptionAccess();
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [refreshSubscriptionAccess]);

  // Lançamentos guardados em memória são de um usuário só: troca ou saída esquece tudo.
  const userId = user?.id ?? null;
  useEffect(() => {
    clearTransactionsCache();
  }, [userId]);

  // Pelo id, e não dentro do `getMe`: login e cadastro chamam `setUser` direto.
  useEffect(() => {
    setFeatures(null);
    if (userId) void refreshFeatures();
  }, [userId, refreshFeatures]);

  const logout = async () => {
    await logoutApi();
    clearTransactionsCache();
    setUser(null);
    setSubscriptionAccess(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        subscriptionAccess,
        features,
        setUser,
        refreshSubscriptionAccess,
        refreshFeatures,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

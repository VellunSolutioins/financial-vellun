'use client';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { type User, getMe, logout as logoutApi } from '@/lib/auth';
import { type Plan, type SubscriptionAccess, getSubscription } from '@/lib/billing';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  subscriptionAccess: SubscriptionAccess | null;
  plan: Plan | null;
  setUser: (user: User | null) => void;
  refreshSubscriptionAccess: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  subscriptionAccess: null,
  plan: null,
  setUser: () => {},
  refreshSubscriptionAccess: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscriptionAccess, setSubscriptionAccess] = useState<SubscriptionAccess | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);

  const refreshSubscriptionAccess = useCallback(async () => {
    try {
      const state = await getSubscription();
      setSubscriptionAccess(state.access);
      setPlan(state.plan);
    } catch {
      setSubscriptionAccess(null);
      setPlan(null);
    }
  }, []);

  useEffect(() => {
    getMe()
      // Espera o plano carregar junto — o layout usa `plan` (Business?) pra
      // decidir se aplica a trava de área por perfil; sem aguardar aqui,
      // `loading` vira false antes do plano chegar e a trava roda com
      // `isBusinessPlan` ainda falso, chutando o dono do plano Business pra
      // fora de /app/empresa mesmo tendo acesso.
      .then(async (u) => {
        setUser(u);
        await refreshSubscriptionAccess();
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [refreshSubscriptionAccess]);

  const logout = async () => {
    await logoutApi();
    setUser(null);
    setSubscriptionAccess(null);
    setPlan(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        subscriptionAccess,
        plan,
        setUser,
        refreshSubscriptionAccess,
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

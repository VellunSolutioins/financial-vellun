'use client';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { type User, getMe, logout as logoutApi } from '@/lib/auth';
import { type SubscriptionAccess, getSubscription } from '@/lib/billing';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  subscriptionAccess: SubscriptionAccess | null;
  setUser: (user: User | null) => void;
  refreshSubscriptionAccess: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  subscriptionAccess: null,
  setUser: () => {},
  refreshSubscriptionAccess: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscriptionAccess, setSubscriptionAccess] = useState<SubscriptionAccess | null>(null);

  const refreshSubscriptionAccess = useCallback(async () => {
    try {
      const state = await getSubscription();
      setSubscriptionAccess(state.access);
    } catch {
      setSubscriptionAccess(null);
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

  const logout = async () => {
    await logoutApi();
    setUser(null);
    setSubscriptionAccess(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        subscriptionAccess,
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

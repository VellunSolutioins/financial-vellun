'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { appHomePath } from '@/lib/auth';

/**
 * Login e cadastro: quem já chega com sessão vai direto para o app.
 *
 * Só olha a sessão encontrada ao abrir a página. Depois disso, quem decide o
 * destino é o próprio formulário (o cadastro, por exemplo, leva para a
 * verificação do WhatsApp, e não para o dashboard).
 */
export function useRedirectIfAuthenticated() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const checked = useRef(false);

  useEffect(() => {
    if (loading || checked.current) return;
    checked.current = true;
    if (user) router.replace(appHomePath(user));
  }, [loading, user, router]);
}

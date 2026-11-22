'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { appHomePath } from '@/lib/auth';

/** Segunda saída da 404: o app para quem tem sessão, o login para os demais. */
export function NotFoundAppLink() {
  const { user, loading } = useAuth();
  const href = !loading && user ? appHomePath(user) : '/login';

  return (
    <Button size="xl" variant="outline" asChild>
      <Link href={href}>{href === '/login' ? 'Entrar na minha conta' : 'Ir para o app'}</Link>
    </Button>
  );
}

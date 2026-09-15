'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { OpsSessionProvider, useOpsSession } from '@/contexts/ops-session-context';
import { OPS_LOGIN_PATH } from '@/lib/ops-api-client';

const navItems = [
  { href: '/ops', label: 'Resumo' },
  { href: '/ops/falhas', label: 'Falhas' },
  { href: '/ops/pagamentos', label: 'Pagamentos' },
  { href: '/ops/auditoria', label: 'Auditoria' },
];

const roleLabels: Record<string, string> = {
  viewer: 'Leitura',
  operator: 'Operador',
  ops_admin: 'Admin',
};

/**
 * Layout da área de operações.
 *
 * Usa **apenas tokens de cor** (`bg-background`, `bg-card`,
 * `text-muted-foreground`). O resto do app usa `bg-white`/`bg-gray-50`
 * hard-coded, o que torna o dark mode configurado no Tailwind inutilizável — o
 * painel novo não vai fundo nessa dívida.
 */
function OpsShell({ children }: { children: React.ReactNode }) {
  const { operator, loading, logout, hasRole } = useOpsSession();
  const pathname = usePathname();
  const router = useRouter();

  const isLoginPage = pathname === OPS_LOGIN_PATH;

  useEffect(() => {
    if (!loading && !operator && !isLoginPage) {
      router.replace(OPS_LOGIN_PATH);
    }
  }, [loading, operator, isLoginPage, router]);

  if (isLoginPage) {
    return <div className="min-h-screen bg-background text-foreground">{children}</div>;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Verificando sessão…</p>
      </div>
    );
  }

  // O redirecionamento acima já está em curso; não pisca conteúdo protegido.
  if (!operator) return null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Operações</p>
              <p className="truncate text-xs text-muted-foreground">
                {operator.githubLogin} · {roleLabels[operator.role] ?? operator.role}
                {operator.canViewSensitive ? ' · dados sensíveis' : ''}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              Sair
            </Button>
          </div>

          {/* Navegação rola horizontalmente em telas estreitas em vez de quebrar. */}
          <nav className="-mx-4 mt-3 overflow-x-auto px-4">
            <ul className="flex w-max gap-1">
              {navItems.map((item) => {
                const active =
                  item.href === '/ops' ? pathname === '/ops' : pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={[
                        'block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      ].join(' ')}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
              {hasRole('ops_admin') && (
                <li>
                  <Link
                    href="/ops/operadores"
                    className={[
                      'block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors',
                      pathname.startsWith('/ops/operadores')
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    ].join(' ')}
                  >
                    Operadores
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4 sm:py-6">{children}</main>
    </div>
  );
}

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <OpsSessionProvider>
      <OpsShell>{children}</OpsShell>
    </OpsSessionProvider>
  );
}

'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import type { SubscriptionAccess } from '@/lib/billing';

const ASSINATURA_PATH = '/app/conta/assinatura';

/** Aviso global de inadimplência/grace, ocultado na própria página de assinatura. */
function SubscriptionBanner({
  access,
  pathname,
}: {
  access: SubscriptionAccess | null;
  pathname: string;
}) {
  if (!access || pathname === ASSINATURA_PATH) return null;

  // Liberado por grace (past_due): alerta amarelo.
  if (access.allowed && access.reason === 'grace_period') {
    return (
      <div className="mb-4 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
        Seu último pagamento não foi confirmado. Regularize para não perder o acesso.{' '}
        <Link href={ASSINATURA_PATH} className="font-semibold underline">
          Ver assinatura
        </Link>
      </div>
    );
  }

  // Sem acesso: alerta vermelho.
  if (!access.allowed) {
    return (
      <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
        Sua assinatura não está ativa. Contrate um plano para usar o produto.{' '}
        <Link href={ASSINATURA_PATH} className="font-semibold underline">
          Assinar agora
        </Link>
      </div>
    );
  }

  return null;
}

const navItems = {
  individual: [
    { href: '/app/pessoal/dashboard', label: 'Dashboard' },
    { href: '/app/pessoal/lancamentos', label: 'Lançamentos' },
    { href: '/app/pessoal/recorrencias', label: 'Recorrências' },
    { href: '/app/pessoal/metas', label: 'Metas de Gastos' },
    { href: '/app/pessoal/contas', label: 'Contas' },
    { href: '/app/pessoal/categorias', label: 'Categorias' },
  ],
  business: [
    { href: '/app/empresa/dashboard', label: 'Dashboard' },
    { href: '/app/pessoal/lancamentos', label: 'Lançamentos' },
    { href: '/app/empresa/contas-a-receber', label: 'Contas a Receber' },
    { href: '/app/empresa/contas-a-pagar', label: 'Contas a Pagar' },
    { href: '/app/empresa/clientes', label: 'Clientes' },
    { href: '/app/empresa/fornecedores', label: 'Fornecedores' },
    { href: '/app/pessoal/contas', label: 'Contas' },
    { href: '/app/empresa/categorias', label: 'Categorias' },
  ],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout, subscriptionAccess } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Fecha o menu lateral ao navegar (relevante apenas em mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    // Profile-based area isolation: individual users cannot access /app/empresa/*
    if (user.profileType === 'individual' && pathname.startsWith('/app/empresa')) {
      router.push('/app/pessoal/dashboard');
    } else if (user.profileType === 'business' && pathname.startsWith('/app/pessoal/dashboard')) {
      router.push('/app/empresa/dashboard');
    }
  }, [user, loading, router, pathname]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Carregando...</div>
      </div>
    );
  }
  if (!user) return null;

  const items = navItems[user.profileType] ?? navItems.individual;

  return (
    <div className="min-h-screen lg:flex lg:h-screen">
      {/* Top bar (mobile) */}
      <header className="lg:hidden sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-white px-4">
        <button
          type="button"
          aria-label="Abrir menu"
          onClick={() => setSidebarOpen(true)}
          className="-ml-2 inline-flex h-10 w-10 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="font-bold text-primary">Financial Vellun</span>
        <span className="w-10" aria-hidden />
      </header>

      {/* Backdrop (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 transform flex-col border-r bg-white transition-transform duration-200 ease-in-out lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:shrink-0 lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b p-6">
          <div className="min-w-0">
            <span className="font-bold text-primary">Financial Vellun</span>
            <p className="text-xs text-muted-foreground mt-1 truncate">{user.name}</p>
          </div>
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={() => setSidebarOpen(false)}
            className="-mr-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 lg:hidden"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                pathname === item.href
                  ? 'bg-primary text-primary-foreground'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t space-y-1">
          <Link
            href="/app/conta"
            className={`block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              pathname === '/app/conta'
                ? 'bg-primary text-primary-foreground'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            Minha Conta
          </Link>
          <Link
            href="/app/conta/assinatura"
            className={`block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              pathname === '/app/conta/assinatura'
                ? 'bg-primary text-primary-foreground'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            Assinatura
          </Link>
          <Button variant="ghost" className="w-full justify-start text-sm" onClick={logout}>
            Sair
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-50 min-w-0 lg:h-screen lg:min-h-0">
        <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
          <SubscriptionBanner access={subscriptionAccess} pathname={pathname} />
          {children}
        </div>
      </main>
    </div>
  );
}

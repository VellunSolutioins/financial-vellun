'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Receipt,
  Repeat,
  Target,
  CreditCard,
  Calendar,
  StickyNote,
  Wallet,
  Tag,
  ArrowDownCircle,
  ArrowUpCircle,
  Users,
  Truck,
  User,
  Sparkles,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SubscriptionAccess } from '@/lib/billing';

const ASSINATURA_PATH = '/app/conta/assinatura';
const SIDEBAR_COLLAPSED_KEY = 'fv:sidebar-collapsed';

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

const VERIFICAR_WHATSAPP_PATH = '/app/verificar-whatsapp';

/** Aviso enquanto o WhatsApp não é verificado: sem ele, o bot não reconhece o usuário. */
function WhatsappBanner({ verified, pathname }: { verified?: boolean; pathname: string }) {
  if (verified || pathname === VERIFICAR_WHATSAPP_PATH || pathname === '/app/conta') return null;
  return (
    <div className="mb-4 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      Seu WhatsApp ainda não está verificado: o bot só registra lançamentos depois disso.{' '}
      <Link href={VERIFICAR_WHATSAPP_PATH} className="font-semibold underline">
        Verificar agora
      </Link>
    </div>
  );
}

const navItems: Record<
  'individual' | 'business',
  { href: string; label: string; icon: LucideIcon }[]
> = {
  individual: [
    { href: '/app/pessoal/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/app/pessoal/lancamentos', label: 'Lançamentos', icon: Receipt },
    { href: '/app/pessoal/recorrencias', label: 'Recorrências', icon: Repeat },
    { href: '/app/pessoal/metas', label: 'Metas de Gastos', icon: Target },
    { href: '/app/pessoal/cartoes', label: 'Cartões', icon: CreditCard },
    { href: '/app/pessoal/agenda', label: 'Agenda e Lembretes', icon: Calendar },
    { href: '/app/pessoal/anotacoes', label: 'Anotações', icon: StickyNote },
    { href: '/app/pessoal/contas', label: 'Contas', icon: Wallet },
    { href: '/app/pessoal/categorias', label: 'Categorias', icon: Tag },
  ],
  business: [
    { href: '/app/empresa/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/app/pessoal/lancamentos', label: 'Lançamentos', icon: Receipt },
    { href: '/app/empresa/contas-a-receber', label: 'Contas a Receber', icon: ArrowDownCircle },
    { href: '/app/empresa/contas-a-pagar', label: 'Contas a Pagar', icon: ArrowUpCircle },
    { href: '/app/empresa/clientes', label: 'Clientes', icon: Users },
    { href: '/app/empresa/fornecedores', label: 'Fornecedores', icon: Truck },
    { href: '/app/pessoal/contas', label: 'Contas', icon: Wallet },
    { href: '/app/empresa/categorias', label: 'Categorias', icon: Tag },
  ],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout, subscriptionAccess } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Fecha o menu lateral ao navegar (relevante apenas em mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Lembra a preferência de sidebar recolhida (só afeta telas grandes).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
    } catch {
      // localStorage indisponível (ex.: modo privado) — ignora, mantém expandida.
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // ignora falha ao persistir
      }
      return next;
    });
  };

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

  const navLinkClass = (active: boolean) =>
    cn(
      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      collapsed && 'lg:justify-center lg:px-2',
      active ? 'bg-primary/10 text-primary' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
    );

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
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
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
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 transform flex-col border-r bg-white transition-all duration-200 ease-in-out lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:shrink-0 lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed && 'lg:w-20',
        )}
      >
        <div
          className={cn(
            'flex items-center justify-between gap-2 border-b p-6',
            collapsed && 'lg:justify-center lg:px-3',
          )}
        >
          <div className={cn('min-w-0', collapsed && 'lg:hidden')}>
            <span className="font-bold text-primary">Financial Vellun</span>
            <p className="text-xs text-muted-foreground mt-1 truncate">{user.name}</p>
          </div>
          {collapsed && (
            <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground lg:flex">
              FV
            </span>
          )}
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={() => setSidebarOpen(false)}
            className="-mr-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 lg:hidden"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-4">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={navLinkClass(pathname === item.href)}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className={cn(collapsed && 'lg:hidden')}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-4 space-y-1">
          <Link
            href="/app/conta"
            title={collapsed ? 'Minha Conta' : undefined}
            className={navLinkClass(pathname === '/app/conta')}
          >
            <User className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && 'lg:hidden')}>Minha Conta</span>
          </Link>
          <Link
            href="/app/conta/assinatura"
            title={collapsed ? 'Assinatura' : undefined}
            className={navLinkClass(pathname === '/app/conta/assinatura')}
          >
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && 'lg:hidden')}>Assinatura</span>
          </Link>
          <Button
            variant="ghost"
            onClick={logout}
            className={cn(
              'w-full justify-start gap-3 text-sm',
              collapsed && 'lg:justify-center lg:px-2',
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && 'lg:hidden')}>Sair</span>
          </Button>
          <button
            type="button"
            onClick={toggleCollapsed}
            className={cn(
              'hidden w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 lg:flex',
              collapsed && 'lg:justify-center lg:px-2',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4 shrink-0" />
            ) : (
              <PanelLeftClose className="h-4 w-4 shrink-0" />
            )}
            <span className={cn(collapsed && 'lg:hidden')}>Recolher</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-50 min-w-0 lg:h-screen lg:min-h-0">
        <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
          <SubscriptionBanner access={subscriptionAccess} pathname={pathname} />
          <WhatsappBanner verified={user.whatsappVerified} pathname={pathname} />
          {children}
        </div>
      </main>
    </div>
  );
}

'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';

const navItems = {
  individual: [
    { href: '/app/pessoal/dashboard', label: 'Dashboard' },
    { href: '/app/pessoal/lancamentos', label: 'Lançamentos' },
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
    { href: '/app/pessoal/categorias', label: 'Categorias' },
  ],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

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
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-white flex flex-col">
        <div className="p-6 border-b">
          <span className="font-bold text-primary">Financial Vellun</span>
          <p className="text-xs text-muted-foreground mt-1 truncate">{user.name}</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
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
        <div className="p-4 border-t">
          <Button variant="ghost" className="w-full justify-start text-sm" onClick={logout}>
            Sair
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-50">
        <div className="max-w-6xl mx-auto p-8">{children}</div>
      </main>
    </div>
  );
}

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { MobileMenu } from './mobile-menu';
import { container, focusRing } from './styles';

const NAV_LINKS = [
  { href: '/#como-funciona', label: 'Como funciona' },
  { href: '/#recursos', label: 'Recursos' },
];

/**
 * Cabeçalho fixo das páginas públicas; as âncoras levam à home de qualquer
 * página. No mobile: marca, "Criar conta" e menu. A partir do `md`, as âncoras
 * e "Entrar" ficam visíveis e o menu some.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background">
      <div className={cn(container, 'flex h-16 items-center justify-between gap-2')}>
        <Brand />
        <nav aria-label="Principal" className="hidden md:flex md:items-center md:gap-2">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-muted hover:text-ink',
                focusRing,
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1 md:gap-2">
          <Button variant="ghost" asChild className="hidden h-11 rounded-xl md:inline-flex">
            <Link href="/login">Entrar</Link>
          </Button>
          <Button asChild className="h-11 rounded-xl px-3 hover:bg-primary-hover sm:px-5">
            <Link href="/cadastro">Criar conta</Link>
          </Button>
          <MobileMenu links={[...NAV_LINKS, { href: '/login', label: 'Entrar' }]} />
        </div>
      </div>
    </header>
  );
}

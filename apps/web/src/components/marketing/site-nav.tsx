'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { appHomePath } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { MobileMenu } from './mobile-menu';
import { homeSectionLinks, type HomePath } from './sections';
import { focusRing } from './styles';
import { ThemeToggle } from './theme-toggle';
import { useActiveSection } from './use-active-section';

/** Âncoras da home no cabeçalho (a partir do `md`), com a seção atual destacada. */
export function SiteNav({ home = '/' }: { home?: HomePath }) {
  const active = useActiveSection();

  return (
    <nav aria-label="Principal" className="hidden md:flex md:items-center md:gap-1 lg:gap-2">
      {homeSectionLinks(home).map((link) => {
        const current = link.id === active;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? 'location' : undefined}
            className={cn(
              'relative inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-muted hover:text-ink',
              // Traço sob o link ativo; sem transição, para não piscar ao rolar rápido.
              "after:absolute after:inset-x-3 after:bottom-1.5 after:h-0.5 after:rounded-full after:content-['']",
              current && 'text-ink after:bg-primary',
              focusRing,
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Ações do cabeçalho. Com sessão aberta, "Entrar" e "Criar conta" dão lugar a
 * "Ir para o app". Enquanto a sessão carrega, mostra a versão de visitante, que
 * é o caso da maioria de quem chega à home.
 */
export function HeaderActions({
  home = '/',
  themeToggle = true,
}: {
  home?: HomePath;
  /** `false` na landing v1, que fica sempre no tema claro. */
  themeToggle?: boolean;
}) {
  const { user, loading } = useAuth();
  const active = useActiveSection();
  const appHref = !loading && user ? appHomePath(user) : null;

  const menuLinks = [
    ...homeSectionLinks(home).map((link) => ({ ...link, current: link.id === active })),
    appHref
      ? { href: appHref, label: 'Ir para o app', current: false }
      : { href: '/login', label: 'Entrar', current: false },
  ];

  return (
    <div className="flex items-center gap-1 md:gap-2">
      {themeToggle && <ThemeToggle />}
      {appHref ? (
        <Button asChild className="h-11 rounded-xl px-3 hover:bg-primary-hover sm:px-5">
          <Link href={appHref}>Ir para o app</Link>
        </Button>
      ) : (
        <>
          <Button variant="ghost" asChild className="hidden h-11 rounded-xl md:inline-flex">
            <Link href="/login">Entrar</Link>
          </Button>
          <Button asChild className="h-11 rounded-xl px-3 hover:bg-primary-hover sm:px-5">
            <Link href="/cadastro">Criar conta</Link>
          </Button>
        </>
      )}
      <MobileMenu links={menuLinks} />
    </div>
  );
}

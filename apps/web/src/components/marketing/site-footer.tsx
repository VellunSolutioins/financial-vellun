import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { container, focusRing } from './styles';

const FOOTER_LINKS = [
  { href: '/login', label: 'Entrar' },
  { href: '/cadastro', label: 'Criar conta' },
  { href: '/privacidade', label: 'Privacidade' },
  { href: '/termos', label: 'Termos' },
];

export function SiteFooter() {
  return (
    <footer className="border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div
        className={cn(
          container,
          'flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between',
        )}
      >
        <div>
          <Brand />
          <p className="text-sm text-ink-muted">
            © {new Date().getFullYear()} Financial Vellun. Todos os direitos reservados.
          </p>
        </div>
        <nav aria-label="Rodapé" className="-ml-3 flex flex-wrap gap-x-2 sm:ml-0 sm:justify-end">
          {FOOTER_LINKS.map((link) => (
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
      </div>
    </footer>
  );
}

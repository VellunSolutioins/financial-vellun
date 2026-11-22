import Link from 'next/link';
import { ZELOO_SLOGAN } from '@/components/brand/zeloo-logo';
import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { CompanyInfo } from './company-info';
import { homeSectionLinks, type HomePath } from './sections';
import { container, focusRing } from './styles';

const footerGroups = (home: HomePath) => [
  { title: 'Conheça', links: homeSectionLinks(home) },
  {
    title: 'Sua conta',
    links: [
      { href: '/login', label: 'Entrar' },
      { href: '/cadastro', label: 'Criar conta' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/privacidade', label: 'Privacidade' },
      { href: '/termos', label: 'Termos' },
    ],
  },
];

/**
 * Rodapé das páginas públicas. Mobile: marca e, abaixo, os grupos de links em
 * duas colunas. A partir do `lg`, marca à esquerda e grupos lado a lado.
 */
export function SiteFooter({ home = '/' }: { home?: HomePath }) {
  return (
    <footer className="border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className={cn(container, 'grid gap-8 py-10 lg:grid-cols-[1fr_auto] lg:gap-16')}>
        <div>
          <Brand href={home} />
          <p className="text-sm font-medium text-ink">{ZELOO_SLOGAN}</p>
          <p className="mt-1 text-sm text-ink-muted">
            © {new Date().getFullYear()} Zeloo. Todos os direitos reservados.
          </p>
        </div>
        <nav
          aria-label="Rodapé"
          className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:gap-x-12"
        >
          {footerGroups(home).map((group) => (
            <div key={group.title}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink">
                {group.title}
              </h2>
              <ul className="-ml-3 mt-1">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className={cn(
                        'inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-muted hover:text-ink',
                        focusRing,
                      )}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className={cn(container, 'border-t py-6')}>
        <CompanyInfo />
      </div>
    </footer>
  );
}

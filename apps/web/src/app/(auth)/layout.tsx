import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { AuthAside } from '@/components/auth/auth-aside';
import { Brand } from '@/components/marketing/brand';
import { focusRing } from '@/components/marketing/styles';

const LEGAL_LINKS = [
  { href: '/privacidade', label: 'Privacidade' },
  { href: '/termos', label: 'Termos' },
];

/**
 * Layout do login e do cadastro. Mobile: uma coluna, sem card e sem centralizar
 * na vertical (o teclado virtual não pode esconder campos nem o botão). A
 * partir do `lg`, a área de apresentação entra à esquerda.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-ink supports-[min-height:100dvh]:min-h-dvh lg:grid lg:grid-cols-2">
      <div className="flex min-w-0 flex-col pb-[env(safe-area-inset-bottom)]">
        <header className="flex h-16 items-center justify-between gap-3 px-4 sm:px-8 lg:px-12">
          <Brand />
          <Link
            href="/"
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-muted hover:text-ink ${focusRing}`}
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
            Início
          </Link>
        </header>
        <main className="flex-1 px-4 pb-12 pt-6 sm:px-8 sm:pt-10 lg:px-12">{children}</main>
        <footer className="px-4 pb-4 sm:px-8 lg:px-12">
          <nav aria-label="Informações legais" className="-ml-2 flex flex-wrap gap-x-2">
            {LEGAL_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`inline-flex min-h-11 items-center rounded-lg px-2 text-sm text-ink-muted hover:text-ink ${focusRing}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </footer>
      </div>
      <AuthAside />
    </div>
  );
}

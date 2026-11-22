import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NotFoundAppLink } from '@/components/marketing/not-found-app-link';
import { MAIN_CONTENT_ID } from '@/components/marketing/sections';
import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';
import { container } from '@/components/marketing/styles';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Página não encontrada — Zeloo',
};

/** 404 de qualquer rota: mesma moldura das páginas públicas e saídas claras. */
export default function NotFound() {
  return (
    <div data-public-page className="bg-glow-page flex min-h-screen flex-col text-ink">
      <SiteHeader />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className={cn(container, 'flex-1 py-16 focus:outline-none sm:py-24')}
      >
        <div className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">Erro 404</p>
          <h1 className="mt-3 text-balance text-[clamp(2rem,1.5rem+2.2vw,3rem)] font-bold leading-tight tracking-tight">
            Não encontramos esta página
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-ink-muted">
            O endereço pode ter mudado ou estar digitado errado. Você pode voltar ao início ou
            entrar na sua conta.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button size="xl" asChild className="hover:bg-primary-hover">
              <Link href="/">
                <ArrowLeft aria-hidden />
                Voltar ao início
              </Link>
            </Button>
            <NotFoundAppLink />
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

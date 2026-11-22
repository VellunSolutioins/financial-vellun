import type { Metadata } from 'next';
import { ZELOO_SLOGAN } from '@/components/brand/zeloo-logo';
import { Faq } from '@/components/marketing/faq';
import { FinalCta } from '@/components/marketing/final-cta';
import { SiteFooter } from '@/components/marketing/site-footer';
import { MAIN_CONTENT_ID } from '@/components/marketing/sections';
import { SiteHeader } from '@/components/marketing/site-header';
import { Hero } from '@/components/marketing/v1/hero';
import { HowItWorks } from '@/components/marketing/v1/how-it-works';
import { ProductOverview } from '@/components/marketing/v1/product-overview';

export const metadata: Metadata = {
  title: `Zeloo — ${ZELOO_SLOGAN}`,
  description:
    'Controle financeiro pelo WhatsApp: registre seus gastos numa mensagem e acompanhe tudo organizado em um só lugar.',
};

/**
 * Landing atual (v1). A versão nova fica em `/v2` para comparação; esta segue
 * sempre no tema claro (`data-theme-locked`) e sem o botão de tema.
 */
export default function HomePage() {
  return (
    <div data-public-page data-theme-locked className="bg-background text-ink">
      <SiteHeader themeToggle={false} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="focus:outline-none">
        <Hero />
        <HowItWorks />
        <ProductOverview />
        <Faq variant="v1" />
        <FinalCta variant="v1" />
      </main>
      <SiteFooter />
    </div>
  );
}

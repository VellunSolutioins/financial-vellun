import type { Metadata } from 'next';
import { ZELOO_SLOGAN } from '@/components/brand/zeloo-logo';
import { Faq } from '@/components/marketing/faq';
import { FinalCta } from '@/components/marketing/final-cta';
import { Hero } from '@/components/marketing/hero';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { ProductOverview } from '@/components/marketing/product-overview';
import { SiteFooter } from '@/components/marketing/site-footer';
import { MAIN_CONTENT_ID } from '@/components/marketing/sections';
import { SiteHeader } from '@/components/marketing/site-header';

/**
 * Landing nova (redesenho), publicada em `/v2` para a equipe comparar com a
 * atual em `/`. Fora dos buscadores até virar a home: não pode competir com
 * ela nos resultados.
 */
export const metadata: Metadata = {
  title: `Zeloo — ${ZELOO_SLOGAN}`,
  description:
    'Controle financeiro pelo WhatsApp: registre seus gastos numa mensagem e acompanhe tudo organizado em um só lugar.',
  robots: { index: false, follow: false },
};

export default function HomePageV2() {
  return (
    <div data-public-page className="bg-background text-ink">
      <SiteHeader home="/v2" />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="focus:outline-none">
        <Hero />
        <HowItWorks />
        <ProductOverview />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter home="/v2" />
    </div>
  );
}

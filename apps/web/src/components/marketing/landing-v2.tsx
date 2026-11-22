import type { Metadata } from 'next';
import { ZELOO_SLOGAN } from '@/components/brand/zeloo-logo';
import { Faq } from './faq';
import { FinalCta } from './final-cta';
import { Hero } from './hero';
import type { CoinVariant } from './hero-coin';
import { HowItWorks } from './how-it-works';
import { ProductOverview } from './product-overview';
import { MAIN_CONTENT_ID, type HomePath } from './sections';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * Metadados das rotas da landing nova. Fora dos buscadores até virar a home:
 * não podem competir com ela nos resultados.
 */
export const landingV2Metadata: Metadata = {
  title: `Zeloo — ${ZELOO_SLOGAN}`,
  description:
    'Controle financeiro pelo WhatsApp: registre seus gastos numa mensagem e acompanhe tudo organizado em um só lugar.',
  robots: { index: false, follow: false },
};

/**
 * Landing nova (redesenho), em avaliação ao lado da atual em `/`. As rotas
 * `/v2`, `/v2/solida` e `/v2/pixel` só mudam a moeda do hero.
 */
export function LandingV2({ coin, home }: { coin: CoinVariant; home: HomePath }) {
  return (
    <div data-public-page className="bg-background text-ink">
      <SiteHeader home={home} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="focus:outline-none">
        <Hero coin={coin} />
        <HowItWorks />
        <ProductOverview />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter home={home} />
    </div>
  );
}

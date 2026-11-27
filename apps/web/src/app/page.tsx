import type { Metadata } from 'next';
import { ZELOO_SLOGAN } from '@/components/brand/zeloo-logo';
import { Faq } from '@/components/marketing/faq';
import { FinalCta } from '@/components/marketing/final-cta';
import { Hero } from '@/components/marketing/hero';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { ProductOverview } from '@/components/marketing/product-overview';
import { MAIN_CONTENT_ID } from '@/components/marketing/sections';
import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';

export const metadata: Metadata = {
  title: `Zeloo — ${ZELOO_SLOGAN}`,
  description:
    'Controle financeiro pelo WhatsApp: registre seus gastos numa mensagem e acompanhe tudo organizado em um só lugar.',
};

export default function HomePage() {
  return (
    <div data-public-page className="bg-background text-ink">
      <SiteHeader />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="focus:outline-none">
        <Hero />
        <HowItWorks />
        <ProductOverview />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

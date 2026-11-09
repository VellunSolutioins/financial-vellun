import type { Metadata } from 'next';
import { Faq } from '@/components/marketing/faq';
import { FinalCta } from '@/components/marketing/final-cta';
import { Hero } from '@/components/marketing/hero';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { ProductOverview } from '@/components/marketing/product-overview';
import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';

export const metadata: Metadata = {
  title: 'Financial Vellun — controle financeiro pelo WhatsApp',
  description: 'Registre seus gastos pelo WhatsApp e acompanhe tudo organizado em um só lugar.',
};

export default function HomePage() {
  return (
    <div className="bg-background text-ink">
      <SiteHeader />
      <main>
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

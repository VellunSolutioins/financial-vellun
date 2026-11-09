import Link from 'next/link';
import { ArrowRight, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ProductDemo } from './product-demo';
import { container } from './styles';

/** Promessa + demonstração. Mobile: texto, CTAs e demo, nessa ordem. */
export function Hero() {
  return (
    <section
      className={cn(
        container,
        'grid gap-10 py-10 sm:py-16 lg:grid-cols-2 lg:items-center lg:gap-16 lg:py-24',
      )}
    >
      <div>
        <p className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-sm font-medium text-primary">
          <MessageCircle aria-hidden className="h-4 w-4" />
          Controle financeiro pelo WhatsApp
        </p>
        <h1 className="mt-5 text-balance text-[clamp(2.25rem,1.5rem+3.4vw,4rem)] font-bold leading-[1.08] tracking-tight text-ink">
          Seu controle financeiro começa com uma mensagem.
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
          Registre seus gastos pelo WhatsApp e acompanhe tudo organizado em um só lugar.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button size="xl" asChild className="hover:bg-primary-hover">
            <Link href="/cadastro">
              Criar minha conta
              <ArrowRight aria-hidden />
            </Link>
          </Button>
          <Button size="xl" variant="outline" asChild>
            <Link href="#como-funciona">Ver como funciona</Link>
          </Button>
        </div>
      </div>
      <ProductDemo />
    </section>
  );
}

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HalftoneCoin } from './halftone-coin';
import { LiveClock } from './live-clock';
import { container } from './styles';

/**
 * Promessa + moeda em meia-tinta. Mobile: status, título, texto, botões e a
 * moeda (menor), nessa ordem. A partir do `lg`, a moeda vai para a direita e o
 * campo de pixels sangra até a borda.
 */
export function Hero() {
  return (
    <section className="bg-glow-hero relative overflow-hidden">
      <div
        className={cn(
          container,
          'grid gap-6 pb-10 pt-8 sm:pb-16 sm:pt-12 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-10 lg:py-16',
        )}
      >
        <div className="relative z-10">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs lowercase text-ink-muted">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              controle financeiro pelo whatsapp
            </span>
            <span>
              <LiveClock /> em brasília
            </span>
          </p>
          <h1 className="mt-6 text-balance text-[clamp(2.5rem,1.6rem+3.8vw,4.5rem)] font-medium leading-[1.04] tracking-tight text-ink">
            Seu controle financeiro <em className="font-bold italic">começa com uma mensagem.</em>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
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
        <figure className="relative -mx-4 sm:mx-0">
          <div className="aspect-square w-full sm:aspect-[5/4] lg:aspect-square">
            <HalftoneCoin />
          </div>
          <figcaption className="mt-2 flex justify-between px-4 font-mono text-xs lowercase text-ink-muted sm:px-0">
            <span>fig. 01 · seu dinheiro</span>
            <span>com cuidado</span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

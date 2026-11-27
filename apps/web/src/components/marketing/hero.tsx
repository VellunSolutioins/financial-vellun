import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HeroWallet } from './hero-wallet';
import { LiveClock } from './live-clock';
import { container } from './styles';

/**
 * Promessa + fig. 01. No celular e no tablet, a carteira animada vem abaixo do
 * texto e dos botões; a partir do `lg`, vai para a direita.
 */
export function Hero() {
  return (
    <section className="bg-glow-hero relative overflow-hidden">
      <div
        className={cn(
          container,
          'grid gap-6 pb-10 pt-8 sm:pb-16 sm:pt-12 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-10 lg:py-16 xl:grid-cols-[minmax(0,46rem)_minmax(0,1fr)]',
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
          <h1 className="mt-6 text-balance text-[clamp(2.5rem,1.6rem+3.8vw,4.5rem)] font-medium xl:text-[4.15rem] leading-[1.04] tracking-tight text-ink">
            {/* A partir do xl, "Seu controle financeiro" fica em uma linha só. */}
            <span className="xl:whitespace-nowrap">
              Seu controle <em className="text-brand-gradient font-bold italic">financeiro</em>
            </span>{' '}
            começa com uma <em className="text-brand-gradient font-bold italic">mensagem</em>.
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
        {/* A cena tem fundo transparente: no xl ela avança sobre a margem da
            direita e o vão do grid, para ganhar tamanho sem apertar o texto. */}
        <HeroWallet className="lg:justify-self-end xl:-ml-10 xl:-mr-10 xl:w-[calc(100%+5rem)]" />
      </div>
    </section>
  );
}

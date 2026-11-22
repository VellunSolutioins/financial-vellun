'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { HalftoneCoin } from './halftone-coin';
import { COIN_FALLBACK_EVENT } from './particle-coin';
import { SolidCoin } from './solid-coin';
import { focusRing } from './styles';
import { useCoinEnabled } from './use-coin-enabled';

export type CoinVariant = 'particulas' | 'solida' | 'pixel';

/** As três moedas em avaliação, cada uma na sua rota (para mandar à equipe). */
export const COIN_VARIANTS: { id: CoinVariant; label: string; href: string }[] = [
  { id: 'particulas', label: 'partículas', href: '/v2' },
  { id: 'solida', label: 'sólida', href: '/v2/solida' },
  { id: 'pixel', label: 'pixel', href: '/v2/pixel' },
];

/**
 * Área da moeda no hero e a legenda com os links entre as versões.
 *
 * Sólida e pixel desenham no próprio quadro. Nas partículas, o quadro fica
 * vazio e serve só de âncora (`data-coin-anchor`): o canvas cobre a seção
 * inteira (`ParticleCoin`) e posiciona a moeda aqui. Quando a equipe escolher,
 * basta deixar só a escolhida e tirar os links.
 */
export function HeroCoin({ variant }: { variant: CoinVariant }) {
  const enabled = useCoinEnabled();
  const [current, setCurrent] = useState(variant);
  // Sem WebGL, sólida e partículas não existem: mostra a pixel no lugar.
  const fallback = useCallback(() => setCurrent('pixel'), []);
  useEffect(() => {
    window.addEventListener(COIN_FALLBACK_EVENT, fallback);
    return () => window.removeEventListener(COIN_FALLBACK_EVENT, fallback);
  }, [fallback]);

  return (
    // No celular a figura inteira sai (o CSS esconde antes de o JS medir a tela).
    <figure className="relative hidden md:block">
      <div data-coin-anchor className="aspect-[5/4] w-full lg:aspect-square">
        {enabled && current === 'pixel' && <HalftoneCoin />}
        {enabled && current === 'solida' && <SolidCoin onUnsupported={fallback} />}
      </div>
      <figcaption className="relative z-10 mt-2 flex items-center justify-between gap-3 font-mono text-xs lowercase text-ink-muted">
        <span>fig. 01 · seu dinheiro</span>
        <nav aria-label="Versões da moeda" className="flex items-center gap-1">
          {COIN_VARIANTS.map((option, i) => (
            <span key={option.id} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>·</span>}
              <Link
                href={option.href}
                scroll={false}
                aria-current={variant === option.id ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 items-center rounded px-1 lowercase hover:text-ink',
                  variant === option.id && 'text-primary underline underline-offset-4',
                  focusRing,
                )}
              >
                {option.label}
              </Link>
            </span>
          ))}
        </nav>
      </figcaption>
    </figure>
  );
}

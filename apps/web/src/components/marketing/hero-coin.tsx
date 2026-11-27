'use client';
import { useCallback, useLayoutEffect, useState } from 'react';
import { COIN_FALLBACK_EVENT } from './particle-coin';

/**
 * Área da moeda no hero. O quadro fica vazio e serve só de âncora
 * (`data-coin-anchor`): o canvas de partículas cobre a seção inteira
 * (`ParticleCoin`) e posiciona a moeda aqui. No celular a figura sai, e sem
 * WebGL também: o hero fica só com o texto e os botões.
 */
export function HeroCoin() {
  const [unsupported, setUnsupported] = useState(false);
  const fallback = useCallback(() => setUnsupported(true), []);
  // Layout effect, e não `useEffect`: o `ParticleCoin` vem antes no hero e avisa
  // a falta de WebGL no próprio efeito. Na navegação pelo cliente os dois montam
  // no mesmo commit, e um `useEffect` aqui só ouviria depois do aviso.
  useLayoutEffect(() => {
    window.addEventListener(COIN_FALLBACK_EVENT, fallback);
    return () => window.removeEventListener(COIN_FALLBACK_EVENT, fallback);
  }, [fallback]);

  if (unsupported) return null;

  return (
    // No celular a figura inteira sai (o CSS esconde antes de o JS medir a tela).
    <figure className="relative hidden md:block">
      <div data-coin-anchor className="aspect-[5/4] w-full lg:aspect-square" />
      <figcaption className="relative z-10 mt-2 flex items-center justify-between gap-3 font-mono text-xs lowercase text-ink-muted">
        <span>fig. 01 · seu dinheiro</span>
        <span>com cuidado</span>
      </figcaption>
    </figure>
  );
}

'use client';
import { useSyncExternalStore } from 'react';

/**
 * A moeda animada só existe a partir do tablet (`md`, 768 px). No celular ela
 * nem é montada: sem WebGL, sem canvas e sem loop de desenho, o hero fica só
 * com o texto e os botões.
 */
const QUERY = '(min-width: 768px)';

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** No servidor, `false`: a moeda entra só no navegador, depois de medir a tela. */
export function useCoinEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

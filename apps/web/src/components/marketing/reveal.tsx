'use client';

import { useEffect, useRef } from 'react';

/** Intervalo entre itens que entram na tela juntos. */
const STAGGER_MS = 100;

function reveal(el: HTMLElement, order: number) {
  el.style.setProperty('--reveal-stagger', `${order * STAGGER_MS}ms`);
  el.setAttribute('data-revealed', '');
}

/**
 * Entrada em sequência ao rolar a página. Os descendentes com a classe `reveal`
 * ficam ocultos (ver `globals.css`) até entrarem na tela; os que entram juntos
 * aparecem em cascata. Com `group`, todos aparecem quando o bloco entra, cada um
 * no seu `--reveal-delay` (coreografia fixa, como a demo do hero).
 *
 * Sem JS ou com movimento reduzido, o CSS não oculta nada.
 */
export function Reveal({
  group = false,
  className,
  children,
}: {
  group?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));

    if (typeof IntersectionObserver === 'undefined') {
      items.forEach((el, i) => reveal(el, i));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        let order = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          if (group) {
            items.forEach((el, i) => reveal(el, i));
          } else {
            reveal(entry.target as HTMLElement, order++);
          }
        }
      },
      // Coreografia só começa com boa parte do bloco à vista; itens soltos, ao despontar.
      { rootMargin: '0px 0px -10% 0px', threshold: group ? 0.4 : 0 },
    );

    if (group) observer.observe(root);
    else items.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [group]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

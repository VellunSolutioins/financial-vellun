'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { HOME_SECTIONS, type HomeSectionId } from './sections';

/**
 * Seção da home que está sob o cabeçalho agora, para destacar o link dela.
 * Fora da home, ou no topo (hero), não há seção ativa.
 *
 * A faixa observada é estreita e fica logo abaixo do cabeçalho fixo: a seção
 * ativa é a que cruza essa linha, e não a que ocupa mais espaço na tela.
 */
export function useActiveSection(): HomeSectionId | null {
  const pathname = usePathname();
  const [active, setActive] = useState<HomeSectionId | null>(null);

  useEffect(() => {
    if (pathname !== '/' || typeof IntersectionObserver === 'undefined') {
      setActive(null);
      return;
    }

    const elements = HOME_SECTIONS.map((section) => document.getElementById(section.id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Na ordem da página: se duas cruzam a linha na mesma hora, vale a de cima.
        const current = HOME_SECTIONS.find((section) => visible.has(section.id));
        setActive(current?.id ?? null);
      },
      // Linha a ~20% da altura, abaixo do cabeçalho de 65 px.
      { rootMargin: '-80px 0px -80% 0px', threshold: 0 },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pathname]);

  return active;
}

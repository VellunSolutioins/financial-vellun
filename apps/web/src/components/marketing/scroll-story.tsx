'use client';
import { useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Peças comuns às seções contadas pelo scroll (Organização e Como funciona):
 * o texto de apoio por etapa (número grande, nome da etapa, primeira frase em
 * destaque e o resto embaixo), a barra de progresso e as luzes de fundo em
 * parallax que alternam de tom por etapa. Tudo é atualizado por `paintStory`
 * a cada quadro, sem re-render do React.
 */

export interface StoryChapter {
  step: string;
  lead: string;
  rest?: string;
}

export interface StoryRefs {
  text: (HTMLDivElement | null)[];
  bars: (HTMLSpanElement | null)[];
  glows: (HTMLDivElement | null)[];
}

export function useStoryRefs() {
  return useRef<StoryRefs>({ text: [], bars: [], glows: [] }).current;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Aplica o estado em `p`: opacidade de cada texto, trechos da barra (cada um
 * enche durante a sua etapa, `spans`) e posição/tom das luzes do fundo.
 */
export function paintStory(
  refs: StoryRefs,
  p: number,
  opacity: number[],
  spans: [number, number][],
) {
  refs.text.forEach((el, i) => {
    if (!el) return;
    const o = opacity[i] ?? 0;
    el.style.opacity = String(o);
    el.style.transform = `translateY(${((1 - o) * 18).toFixed(1)}px)`;
    el.style.visibility = o < 0.01 ? 'hidden' : 'visible';
  });
  refs.bars.forEach((el, i) => {
    if (!el || !spans[i]) return;
    const [a, b] = spans[i];
    el.style.transform = `scaleX(${clamp01((p - a) / (Math.min(1, b) - a)).toFixed(3)})`;
  });
  // Parallax: cada luz anda numa velocidade; o tom alterna nas etapas pares.
  const even = opacity.reduce((sum, o, i) => (i % 2 ? sum + o : sum), 0);
  const [g0, g1, g2] = refs.glows;
  if (g0)
    g0.style.transform = `translate3d(${(-6 + p * 10).toFixed(2)}%, ${(18 - p * 36).toFixed(2)}%, 0)`;
  if (g1) {
    g1.style.transform = `translate3d(${(8 - p * 14).toFixed(2)}%, ${(-10 + p * 26).toFixed(2)}%, 0)`;
    g1.style.opacity = String(0.35 + 0.65 * even);
  }
  if (g2) {
    g2.style.transform = `translate3d(${(p * 8).toFixed(2)}%, ${(30 - p * 60).toFixed(2)}%, 0)`;
    g2.style.opacity = String(1 - 0.6 * even);
  }
}

/** Luzes de fundo (azul da marca e verde), atrás da cena. */
export function StoryGlows({ refs }: { refs: StoryRefs }) {
  const set = (i: number) => (el: HTMLDivElement | null) => {
    refs.glows[i] = el;
  };
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div
        ref={set(0)}
        className="absolute -left-[20%] top-[5%] h-[90%] w-[75%] rounded-full bg-[radial-gradient(closest-side,hsl(var(--brand)/0.3),transparent)] blur-2xl will-change-transform"
      />
      <div
        ref={set(1)}
        className="absolute -right-[15%] -top-[10%] h-[80%] w-[65%] rounded-full bg-[radial-gradient(closest-side,rgb(16_185_129/0.26),transparent)] blur-2xl will-change-transform"
      />
      <div
        ref={set(2)}
        className="absolute -bottom-[25%] right-[5%] h-[75%] w-[55%] rounded-full bg-[radial-gradient(closest-side,hsl(var(--brand)/0.24),transparent)] blur-2xl will-change-transform"
      />
    </div>
  );
}

/**
 * Coluna do texto de apoio. `side`: de que lado ela fica no desktop (no
 * celular fica sempre em cima, com a cena embaixo).
 */
export function StoryText({
  refs,
  chapters,
  number,
  label,
  side,
}: {
  refs: StoryRefs;
  chapters: StoryChapter[];
  number: string;
  label: string;
  side: 'left' | 'right';
}) {
  return (
    <div
      className={cn(
        'absolute inset-x-4 top-6 sm:inset-x-6 sm:top-10',
        // Desktop: centrada na altura (`translate`, e não `transform`: o
        // transform inline faz o fade de subida de cada texto).
        'lg:top-1/2 lg:[translate:0_-50%]',
        side === 'right' ? 'lg:left-[52%] lg:right-8' : 'lg:left-8 lg:right-auto lg:w-[30rem]',
      )}
    >
      <p className="font-mono text-xs lowercase tracking-wide text-ink-muted">
        <span className="text-brand">nº {number}</span> — {label}
      </p>
      {/* Progresso: um trecho por etapa, enche conforme o scroll. */}
      <div aria-hidden className="mt-4 flex max-w-sm gap-1.5">
        {chapters.map((c, i) => (
          <span key={c.step} className="h-1 flex-1 overflow-hidden rounded-full bg-ink/10">
            <span
              ref={(el) => {
                refs.bars[i] = el;
              }}
              className="block h-full w-full origin-left scale-x-0 rounded-full bg-gradient-to-r from-brand to-emerald-500"
            />
          </span>
        ))}
      </div>

      <div className="relative mt-6 min-h-[12rem] sm:min-h-[14rem] lg:mt-10 lg:min-h-[20rem]">
        {chapters.map((c, i) => (
          <div
            key={c.lead}
            ref={(el) => {
              refs.text[i] = el;
            }}
            className="absolute inset-x-0 top-0"
            style={{ opacity: i === 0 ? 1 : 0 }}
          >
            <p className="flex items-baseline gap-3 font-mono lowercase text-ink-muted">
              <span
                aria-hidden
                className="text-5xl font-semibold leading-none text-brand/25 lg:text-7xl"
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="text-xs tracking-wide sm:text-sm">{c.step}</span>
            </p>
            <p className="mt-3 text-balance text-3xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-4xl lg:mt-5 lg:text-[3.25rem]">
              {c.lead}
            </p>
            {c.rest && (
              <p className="mt-3 max-w-xl text-lg leading-snug text-ink-muted sm:text-2xl lg:mt-5 lg:text-[1.75rem]">
                {c.rest}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

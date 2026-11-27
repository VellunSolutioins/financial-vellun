'use client';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  StoryGlows,
  StoryText,
  paintStory,
  useStoryRefs,
  type StoryChapter,
} from '../scroll-story';
import { container } from '../styles';
import { CHAPTERS as SHOTS, flowPose } from './timeline';

/**
 * Seção Organização: a cena fica presa na tela e o scroll conduz a história
 * (ver `timeline.ts`). As moedas do Zeloo descem pelos canos, caem nas caixas
 * das categorias e as pilhas viram o gráfico do mês. O texto de apoio segue o
 * mesmo padrão do "Como funciona" (ver `scroll-story.tsx`).
 */

const CHAPTERS: StoryChapter[] = [
  {
    step: 'para onde vai',
    lead: 'Entenda para onde seu dinheiro está indo.',
    rest: 'Cada gasto que você manda pelo WhatsApp vira uma moeda no caminho certo.',
  },
  {
    step: 'categorias',
    lead: 'Cada gasto na categoria certa.',
    rest: 'Aluguel, mercado, streaming, combustível ou farmácia: cada gasto que você manda vai direto para a categoria dele.',
  },
  {
    step: 'visão do mês',
    lead: 'Evite surpresas!',
    rest: 'Tenha uma visão clara das suas finanças: veja o que entrou, quanto foi gasto em cada categoria e quais contas ainda vão vencer.',
  },
];

/** Trechos da barra de progresso: cada etapa vai do começo dela ao da seguinte. */
const SPANS: [number, number][] = [
  [0, SHOTS.follow[0]],
  [SHOTS.follow[0], SHOTS.pullBack[0]],
  [SHOTS.pullBack[0], 1],
];

/** Inércia do scroll, como na referência: a câmera chega, não "pula". */
const SPRING = 6; // 1/s

export function MoneyFlow() {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const story = useStoryRefs();

  useEffect(() => {
    const section = sectionRef.current;
    const canvasEl = canvasRef.current;
    if (!section || !canvasEl) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let target = 0;
    let p = 0;
    let time = 0;
    let frame = 0;
    let last = 0;
    let running = false;
    let stage: import('./scene').FlowStage | null = null;
    let disposed = false;

    const readScroll = () => {
      const r = section.getBoundingClientRect();
      const travel = r.height - window.innerHeight;
      target = travel > 0 ? Math.min(1, Math.max(0, -r.top / travel)) : 0;
    };
    const paint = () => paintStory(story, p, flowPose(p).text, SPANS);
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      readScroll();
      p = reduced ? target : p + (target - p) * (1 - Math.exp(-dt * SPRING));
      if (!reduced) time += dt;
      paint();
      stage?.render(p, time);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    const size = () => {
      const r = canvasEl.getBoundingClientRect();
      if (stage && r.width && r.height) stage.resize(r.width, r.height);
    };

    void Promise.all([
      import('./scene'),
      fetch('/marca/zeloo-simbolo.svg').then((r) => r.text()),
    ]).then(([{ createFlowStage }, svg]) => {
      if (disposed) return;
      try {
        stage = createFlowStage(canvasEl, svg);
      } catch {
        return; // Sem WebGL: fica só o texto.
      }
      canvasEl.dataset.ready = '';
      size();
      readScroll();
      p = target;
      stage.render(p, time);
    });

    const observer = new IntersectionObserver(([entry]) =>
      entry.isIntersecting ? start() : stop(),
    );
    observer.observe(section);
    const resizer = new ResizeObserver(size);
    resizer.observe(canvasEl);
    readScroll();
    p = target;
    paint();

    return () => {
      disposed = true;
      stop();
      observer.disconnect();
      resizer.disconnect();
      stage?.dispose();
    };
  }, [story]);

  return (
    <section
      id="organizacao"
      ref={sectionRef}
      aria-labelledby="organizacao-titulo"
      // Trilha do scroll: quatro telas para três capítulos e duas transições.
      className="bg-glow-page relative h-[420vh]"
    >
      <div className="sticky top-16 h-[calc(100svh-4rem)] overflow-hidden">
        <StoryGlows refs={story} />
        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-0 h-full w-full opacity-0 transition-opacity duration-500 data-[ready]:opacity-100"
        />
        <div className={cn(container, 'pointer-events-none relative h-full')}>
          <h2 id="organizacao-titulo" className="sr-only">
            Organização: para onde vai o seu dinheiro
          </h2>
          <StoryText refs={story} chapters={CHAPTERS} number="02" label="organização" side="left" />
        </div>
      </div>
    </section>
  );
}

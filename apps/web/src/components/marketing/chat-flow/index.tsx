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
import { CHAPTER_SPANS, chapterOpacity } from './timeline';

/**
 * Seção "Como funciona": a conversa com o Zeloo acontece no celular conforme
 * o scroll (ver `timeline.ts`), e o texto de apoio troca a cada etapa (ver
 * `scroll-story.tsx`). A cena é three.js e só carrega no navegador.
 */

const CHAPTERS: StoryChapter[] = [
  { step: 'mensagem', lead: 'Conte ao Zeloo qual foi o pagamento.' },
  {
    step: 'áudio',
    lead: 'Menos digitação!',
    rest: 'Tá na correria? O Zeloo entende seus áudios contando sobre novos gastos.',
  },
  {
    step: 'comprovante',
    lead: 'Acabou de passar o cartão?',
    rest: 'Encaminhe o comprovante para o Zeloo e deixe o resto com ele ;)',
  },
  { step: 'em tempo real', lead: 'Controle em tempo real do seu dinheiro, feito por você!' },
];

/** Inércia do scroll: as mensagens chegam, não "pulam". */
const SPRING = 6; // 1/s

export function ChatFlow() {
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
    let stage: import('./scene').ChatStage | null = null;
    let disposed = false;

    const readScroll = () => {
      const r = section.getBoundingClientRect();
      const travel = r.height - window.innerHeight;
      target = travel > 0 ? Math.min(1, Math.max(0, -r.top / travel)) : 0;
    };
    const paint = () => paintStory(story, p, chapterOpacity(p), CHAPTER_SPANS);
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
      // A tela do celular usa a fonte do site: espera ela carregar.
      document.fonts.ready,
    ]).then(([{ createChatStage }, svg]) => {
      if (disposed) return;
      try {
        stage = createChatStage(canvasEl, svg, getComputedStyle(document.body).fontFamily);
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
      id="como-funciona"
      ref={sectionRef}
      aria-labelledby="como-funciona-titulo"
      // Trilha do scroll: seis telas para as quatro etapas da conversa.
      className="relative h-[600vh] bg-surface"
    >
      <div className="sticky top-16 h-[calc(100svh-4rem)] overflow-hidden">
        <StoryGlows refs={story} />
        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-0 h-full w-full opacity-0 transition-opacity duration-500 data-[ready]:opacity-100"
        />
        <div className={cn(container, 'pointer-events-none relative h-full')}>
          <h2 id="como-funciona-titulo" className="sr-only">
            Como funciona: do WhatsApp ao lançamento
          </h2>
          <StoryText
            refs={story}
            chapters={CHAPTERS}
            number="01"
            label="como funciona"
            side="right"
          />
        </div>
      </div>
    </section>
  );
}

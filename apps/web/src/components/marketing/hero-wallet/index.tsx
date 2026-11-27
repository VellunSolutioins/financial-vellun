'use client';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { END } from './timeline';

/** Com movimento reduzido, a figura já aparece no fim: a moeda parada no hero. */
const STILL_FOR_REDUCED_MOTION = END + 0.9;
/** A entrada começa na antecipação: a carteira abre assim que aparece. */
const START_AT = 1.3;
/**
 * Cena (three.js) e desenho do Z, buscados juntos e uma vez só: a carteira
 * aparece assim que os dois chegam.
 */
let assets: Promise<[typeof import('./scene'), string]> | undefined;
function loadAssets() {
  assets ??= Promise.all([
    import('./scene'),
    fetch('/marca/zeloo-simbolo.svg').then((r) => r.text()),
  ]);
  return assets;
}
// Começa a buscar já ao carregar este módulo, antes de o React montar a figura.
if (typeof window !== 'undefined') void loadAssets();

/** Quanto o ponteiro precisa andar, em larguras da figura, para o parallax chegar ao máximo. */
const POINTER_REACH = 0.9;

/**
 * fig. 01 do hero: a carteira de couro abre, as moedas do Zeloo escapam, a
 * carteira sai de cena e uma moeda vem até a tela e fica flutuando, seguindo
 * o ponteiro. A entrada toca uma vez, quando a figura aparece; depois, só a
 * moeda flutua. O three.js só carrega no navegador e a cena só roda enquanto
 * está na tela. `still` congela um momento (segundos).
 */
export function HeroWallet({ still, className }: { still?: number; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    let disposed = false;
    let cleanup = () => {};

    void loadAssets().then(([{ createStage }, svg]) => {
      if (disposed) return;
      let stage;
      try {
        stage = createStage(canvasEl, svg);
      } catch {
        return; // Sem WebGL: a figura fica vazia, o texto do hero segue.
      }
      if (disposed) {
        stage.dispose();
        return;
      }
      canvasEl.dataset.ready = '';
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const frozen = still ?? (reduced ? STILL_FOR_REDUCED_MOTION : undefined);

      let frame = 0;
      let playing = false;
      let elapsed = START_AT;
      let last = 0;
      // Ponteiro: o alvo vem do mouse, o valor usado segue com atraso (mola simples).
      const aim = { x: 0, y: 0 };
      const pointer = { x: 0, y: 0 };

      const draw = () => stage.render(frozen ?? elapsed, pointer);
      const size = () => {
        const { width, height } = canvasEl.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        // No lg o canvas tem 1,6× a caixa da figura (folga para a carteira
        // aberta não ser cortada); a cena ocupa o mesmo que antes (1,25×).
        stage.resize(width, height, window.innerWidth >= 1024 ? 1.25 / 1.6 : 1);
        draw();
      };
      const tick = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        elapsed += dt;
        const k = 1 - Math.exp(-dt * 6);
        pointer.x += (aim.x - pointer.x) * k;
        pointer.y += (aim.y - pointer.y) * k;
        draw();
        frame = requestAnimationFrame(tick);
      };
      const play = () => {
        if (playing || frozen !== undefined || document.hidden) return;
        playing = true;
        last = performance.now();
        frame = requestAnimationFrame(tick);
      };
      const pause = () => {
        playing = false;
        cancelAnimationFrame(frame);
      };

      // Parallax só com mouse: no toque, a moeda apenas flutua.
      const onPointer = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return;
        // Pela caixa da figura (o canvas é maior que ela no desktop).
        const r = (canvasEl.parentElement ?? canvasEl).getBoundingClientRect();
        const reach = r.width * POINTER_REACH;
        const clamp = (n: number) => Math.max(-1, Math.min(1, n));
        aim.x = clamp((e.clientX - (r.left + r.width / 2)) / reach);
        aim.y = clamp(-(e.clientY - (r.top + r.height / 2)) / reach);
      };
      const onLeave = () => {
        aim.x = 0;
        aim.y = 0;
      };

      const resizer = new ResizeObserver(size);
      resizer.observe(canvasEl);
      let visible = false;
      // Só toca com boa parte da figura à vista: no celular ela fica abaixo da
      // dobra, e a entrada acabaria antes de alguém vê-la.
      const observer = new IntersectionObserver(
        ([entry]) => {
          visible = entry.intersectionRatio >= 0.4;
          if (visible) play();
          else pause();
        },
        { threshold: [0, 0.4] },
      );
      observer.observe(canvasEl);
      const onVisibility = () => (document.hidden || !visible ? pause() : play());
      document.addEventListener('visibilitychange', onVisibility);
      if (frozen === undefined) {
        window.addEventListener('pointermove', onPointer, { passive: true });
        document.documentElement.addEventListener('pointerleave', onLeave);
      }
      size();

      cleanup = () => {
        pause();
        resizer.disconnect();
        observer.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pointermove', onPointer);
        document.documentElement.removeEventListener('pointerleave', onLeave);
        stage.dispose();
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [still]);

  return (
    <figure
      className={cn(
        'relative mx-auto aspect-[4/5] w-full max-w-[30rem] lg:mr-0 lg:max-w-none',
        // Por cima da coluna do texto: a carteira aberta pode passar dela.
        'pointer-events-none lg:z-20',
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Uma carteira de couro se abre, as moedas do Zeloo escapam e uma delas fica flutuando."
        className={cn(
          'absolute inset-0 h-full w-full',
          // A partir do lg, o canvas tem 1,6× a caixa da figura, sem mexer no
          // layout: o fundo é transparente e transborda, e a carteira aberta,
          // inclinada, tem folga dos lados em vez de ser cortada na borda.
          'lg:inset-auto lg:left-[-30%] lg:top-[-30%] lg:h-[160%] lg:w-[160%]',
          // As moedas saem por cima: o topo esmaece em vez de cortar seco.
          '[mask-image:linear-gradient(to_bottom,transparent,black_14%)]',
          // Entra com um fade curto quando a cena fica pronta, sem piscar.
          'opacity-0 transition-opacity duration-200 data-[ready]:opacity-100',
        )}
      />
    </figure>
  );
}

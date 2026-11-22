'use client';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { subscribeTheme } from '@/lib/public-theme';

/**
 * Moeda cunhada com o logo do Zeloo, desenhada em meia-tinta: uma grade de
 * quadrados cujo tamanho é a luz (ou a sombra) daquele ponto. A moeda gira
 * devagar, a luz segue o ponteiro (ou orbita sozinha) e um campo de "pixels"
 * pisca ao redor.
 *
 * Tudo em Canvas 2D, sem biblioteca: a cena é calculada por ponto (domo da
 * face, relevo do logo, perolado, aro serrilhado e espessura). Só o desenho do
 * relevo vem de uma máscara, feita na hora com o SVG do logo.
 * Pausa fora da tela e com a aba oculta; com movimento reduzido, fica parada.
 */

/** Lado da célula da grade, em px CSS. Fina o bastante para o nome "zeloo" se ler. */
const CELL_DESKTOP = 5;
const CELL_MOBILE = 4;
/** Raio da moeda em relação ao menor lado do canvas. */
const COIN_RADIUS = 0.38;
/** Onde começa o aro (em raios). */
const RIM_START = 0.88;
/** Espessura da borda (vista quando a moeda gira), em raios. */
const COIN_THICKNESS = 0.16;

interface Palette {
  ink: string;
  accent: string;
  /**
   * No tema escuro os quadrados são claros: o tamanho passa a ser a luz do
   * ponto, e não a sombra. Sem isso a moeda aparece "em negativo".
   */
  inkIsLight: boolean;
}

function readPalette(el: Element): Palette {
  const style = getComputedStyle(el);
  const hsl = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value ? `hsl(${value})` : fallback;
  };
  return {
    ink: hsl('--ink', '#0f172a'),
    accent: hsl('--primary', '#2563eb'),
    inkIsLight: document.documentElement.dataset.theme === 'dark',
  };
}

/**
 * Relevo da face, numa grade `size × size` que cobre o círculo unitário: o logo
 * ("Z" + "zeloo") no centro, um filete fino e um anel de contas (perolado),
 * como numa moeda. Vale só o alfa: 1 é relevo, 0 é campo.
 */
async function loadCoinMask(size: number): Promise<Float32Array> {
  const img = new Image();
  img.src = '/marca/zeloo-logo.svg';
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const mask = new Float32Array(size * size);
  if (!ctx) return mask;
  const c = size / 2;

  // Logo: 66% do diâmetro, proporção original 1768 × 477.
  const w = size * 0.66;
  const h = (w * 477) / 1768;
  ctx.drawImage(img, c - w / 2, c - h / 2, w, h);

  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  // Filete interno.
  ctx.lineWidth = size * 0.012;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  // Perolado: contas iguais em volta.
  const beads = 48;
  for (let i = 0; i < beads; i++) {
    const a = (i / beads) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * c * 0.8, c + Math.sin(a) * c * 0.8, size * 0.012, 0, Math.PI * 2);
    ctx.fill();
  }

  const data = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] / 255;
  return mask;
}

/** Pseudoaleatório estável por célula: o campo de pixels não "pula" a cada quadro. */
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function HalftoneCoin({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const MASK = 320;
    let mask: Float32Array | null = null;
    let palette = readPalette(canvas);
    let width = 0;
    let height = 0;
    let cell = CELL_DESKTOP;
    let raf = 0;
    let running = false;
    let visible = false;
    const start = performance.now();
    // Luz: alvo (ponteiro) e posição suavizada, em coordenadas da moeda (-1..1).
    const light = { x: -0.5, y: -0.6 };
    const target = { x: -0.5, y: -0.6, active: false };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      cell = width < 420 ? CELL_MOBILE : CELL_DESKTOP;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const sampleMask = (u: number, v: number) => {
      if (!mask) return 0;
      const x = Math.round(((u + 1) / 2) * (MASK - 1));
      const y = Math.round(((v + 1) / 2) * (MASK - 1));
      if (x < 0 || y < 0 || x >= MASK || y >= MASK) return 0;
      return mask[y * MASK + x];
    };

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0) return;

      // Sem ponteiro sobre a cena, a luz orbita devagar.
      if (!target.active) {
        target.x = Math.cos(t * 0.35) * 0.75;
        target.y = -0.45 + Math.sin(t * 0.35) * 0.35;
      }
      const k = reduced ? 1 : 0.06;
      light.x += (target.x - light.x) * k;
      light.y += (target.y - light.y) * k;
      const lz = 0.9;
      const ll = Math.hypot(light.x, light.y, lz);
      const L = { x: light.x / ll, y: light.y / ll, z: lz / ll };

      const R = Math.min(width, height) * COIN_RADIUS;
      const cx = width / 2;
      const cy = height / 2;
      // Giro de vaivém em torno do eixo vertical.
      const phi = reduced ? 0.35 : 0.5 * Math.sin(t * 0.32) + 0.15;
      const squash = Math.cos(phi);
      const edge = Math.sin(phi) * COIN_THICKNESS * R;

      const cols = Math.ceil(width / cell);
      const rows = Math.ceil(height / cell);
      let markerX = 0;
      let markerY = 0;
      let markerBest = -1;

      ctx.fillStyle = palette.ink;
      for (let j = 0; j < rows; j++) {
        const y = j * cell + cell / 2;
        for (let i = 0; i < cols; i++) {
          const x = i * cell + cell / 2;
          // Coordenadas na face da moeda (círculo unitário).
          const u = (x - cx) / (R * squash || 1);
          const v = (y - cy) / R;
          const r2 = u * u + v * v;
          let shade = 0;

          if (r2 <= 1) {
            // Face levemente abaulada.
            const nz = Math.sqrt(1 - r2 * 0.55);
            let nx = u * 0.45;
            let ny = v * 0.45;
            const r = Math.sqrt(r2);
            if (r > RIM_START) {
              // Aro em relevo com serrilha.
              const a = Math.atan2(v, u);
              nx += Math.cos(a) * 0.5 + Math.sin(a * 70) * 0.12;
              ny += Math.sin(a) * 0.5;
            } else {
              // Relevo do logo e do perolado: a inclinação vem da diferença da máscara.
              const d = 3 / MASK;
              const gx = sampleMask(u + d, v) - sampleMask(u - d, v);
              const gy = sampleMask(u, v + d) - sampleMask(u, v - d);
              nx -= gx * 1.8;
              ny -= gy * 1.8;
            }
            const nl = Math.hypot(nx, ny, nz);
            const diffuse = Math.max(0, (nx * L.x + ny * L.y + nz * L.z) / nl);
            // Ponto mais iluminado: onde fica o marcador de luz.
            // Só no campo liso: em cima do logo ele esconderia as letras.
            if (diffuse > markerBest && r < 0.7 && sampleMask(u, v) < 0.05) {
              markerBest = diffuse;
              markerX = x;
              markerY = y;
            }
            // Luz do ponto (0..1): o relevo é polido (bem mais claro que o campo
            // fosco) e o aro um pouco mais escuro; é esse contraste que deixa o
            // logo legível nos dois temas.
            const z = r > RIM_START ? 0 : sampleMask(u, v);
            let lit = 0.04 + diffuse * 0.46 + z * 0.5;
            if (r > RIM_START) lit = 0.2 + diffuse * 0.7;
            lit = Math.max(0, Math.min(1, lit));
            shade = palette.inkIsLight ? 0.1 + lit * 0.9 : 0.12 + (1 - lit) * 0.88;
          } else if (edge > 0) {
            // Espessura visível do lado para onde a moeda gira.
            const ue = (x - cx - edge) / (R * squash || 1);
            if (ue * ue + v * v <= 1 && x > cx) {
              const ridge = 0.5 + Math.sin(v * 40) * 0.08;
              shade = palette.inkIsLight ? 0.25 + ridge * 0.2 : 0.78 + ridge * 0.1;
            }
          }

          if (shade > 0) {
            const s = Math.min(1, shade) * cell * 0.92;
            ctx.fillRect(x - s / 2, y - s / 2, s, s);
            continue;
          }

          // Campo de pixels ao redor: mais denso perto da moeda e piscando devagar.
          const dist = Math.hypot((x - cx) / R, (y - cy) / R);
          const h = hash(i, j);
          // Com a grade fina, só ~8% das células acendem: o campo não vira ruído.
          if (h > 0.92 && dist < 2.6) {
            const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * (0.6 + h) + h * 40);
            const alpha = (1 - dist / 2.6) * 0.35 * pulse;
            if (alpha > 0.02) {
              ctx.globalAlpha = alpha;
              const s = cell * (0.35 + 0.5 * pulse);
              ctx.fillRect(x - s / 2, y - s / 2, s, s);
              ctx.globalAlpha = 1;
            }
          }
        }
      }

      // Toque de cor: alguns pixels no tom da marca e o marcador da luz.
      ctx.fillStyle = palette.accent;
      for (let n = 0; n < 6; n++) {
        const h = hash(n, 7);
        const pulse = reduced ? 1 : 0.5 + 0.5 * Math.sin(t * 0.8 + n * 1.7);
        const px = cx + (h - 0.5) * R * 3.4;
        const py = cy + (hash(7, n) - 0.5) * R * 2.6;
        ctx.globalAlpha = 0.25 + 0.55 * pulse;
        ctx.fillRect(
          Math.round(px / cell) * cell,
          Math.round(py / cell) * cell,
          cell - 1,
          cell - 1,
        );
      }
      ctx.globalAlpha = 1;
      if (markerBest > 0) {
        ctx.strokeStyle = palette.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(markerX, markerY, 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillRect(markerX - cell / 2, markerY - cell / 2, cell, cell);
      }
    };

    const loop = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    const play = () => {
      if (running || reduced || !visible || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const pause = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const R = Math.min(rect.width, rect.height) * COIN_RADIUS;
      target.x = Math.max(-1.2, Math.min(1.2, (e.clientX - rect.left - rect.width / 2) / R));
      target.y = Math.max(-1.2, Math.min(1.2, (e.clientY - rect.top - rect.height / 2) / R));
      target.active = true;
    };
    const onPointerLeave = () => {
      target.active = false;
    };
    const onVisibility = () => (document.hidden ? pause() : play());

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) play();
      else pause();
    });
    const resizeObserver = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    const unsubscribeTheme = subscribeTheme(() => {
      palette = readPalette(canvas);
      draw(performance.now());
    });

    resize();
    observer.observe(canvas);
    resizeObserver.observe(canvas);
    // O ponteiro é lido na seção inteira: a luz reage mesmo com o mouse no texto.
    const scope = canvas.closest('section') ?? canvas;
    scope.addEventListener('pointermove', onPointerMove as EventListener, { passive: true });
    scope.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);

    let cancelled = false;
    loadCoinMask(MASK)
      .then((m) => {
        if (cancelled) return;
        mask = m;
        draw(performance.now());
      })
      .catch(() => {
        // Sem o logo, a moeda fica lisa: segue funcionando.
      });
    draw(performance.now());

    return () => {
      cancelled = true;
      pause();
      observer.disconnect();
      resizeObserver.disconnect();
      unsubscribeTheme();
      scope.removeEventListener('pointermove', onPointerMove as EventListener);
      scope.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className={cn('block h-full w-full', className)} />;
}

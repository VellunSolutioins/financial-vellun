'use client';
import { useEffect, useRef } from 'react';
import { subscribeTheme } from '@/lib/public-theme';
import {
  CAMERA_DISTANCE,
  COIN_RADIUS,
  COIN_THICKNESS,
  COIN_TILT,
  RIM_START,
  coinSpin,
  drawCoinMask,
  idleLight,
} from './coin-mask';

/**
 * Moeda de partículas 3D: milhares de pontos formam a moeda (o logo mais denso
 * e brilhante que o campo, o aro e a borda), com a geometria, o giro e a luz de
 * `coin-mask.ts`. O canvas cobre a seção inteira do hero, então não há
 * "caixa" visível em volta da moeda: ela cai do alto, mais perto do centro da
 * tela e inclinada, pousa no lugar e quica rolando para a direita, até parar
 * com o logo reto. Depois, segue o mouse de leve (parallax no hover) e anda um
 * pouco mais devagar que a página na rolagem. Outras partículas ficam soltas
 * pelo fundo, subindo devagar. A luz orbita sozinha.
 *
 * WebGL puro (pontos redondos, sem biblioteca). A posição da moeda vem do
 * quadro `[data-coin-anchor]` do hero. Sem WebGL, avisa a página
 * (`COIN_FALLBACK_EVENT`), que esconde o quadro da moeda.
 * Pausa fora da tela e com a aba oculta; com movimento reduzido, fica parada.
 */

export const COIN_FALLBACK_EVENT = 'zeloo-coin-fallback';

const KIND = { field: 0, relief: 1, rim: 2, side: 3, ambient: 4 } as const;

/*
 * Entrada da moeda: cai do alto da seção, já inclinada e mais perto do centro
 * da tela, pousa na própria posição e quica, rolando para a direita até parar
 * com o logo reto. Valores em px CSS (multiplicados pelo DPR do canvas) e
 * segundos.
 */
/** Gravidade da queda: mais baixa que a "real" na tela, para a queda ser lida. */
const GRAVITY = 2400;
/** Quanto da velocidade sobra a cada quique (quiques macios, que somem logo). */
const RESTITUTION = 0.36;
/** Abaixo desta velocidade de impacto, a moeda para de quicar. */
const MIN_BOUNCE_SPEED = 90;
/**
 * Rolagem até a posição. A distância é a que falta até o centro da tela,
 * limitada a este tanto de raios (uma "leve rolada"); no tablet, com a moeda
 * já centralizada, ela não rola.
 */
const MAX_ROLL_RADII = 1.1;
/**
 * Atrito da rolagem, como uma mola criticamente amortecida: começa com o
 * embalo do impacto e freia até parar no lugar, sem passar do ponto.
 */
const ROLL_STIFFNESS = 3.6;
/** Fração do embalo que a moeda leva do impacto para a rolagem. */
const ROLL_KICK = 0.6;
/** Parallax com a rolagem da página: a moeda anda 15% mais devagar. */
const PARALLAX = 0.15;
/**
 * Parallax com o mouse sobre o hero: a moeda se inclina e se desloca de leve
 * na direção do ponteiro. Ângulos em rad, deslocamento em px CSS.
 */
const HOVER_TURN = 0.22;
const HOVER_TILT = 0.16;
const HOVER_SHIFT = 12;
/** Rapidez com que a moeda acompanha o ponteiro (maior = mais rápido). */
const HOVER_EASE = 5;

const VERTEX = `
attribute vec3 aPos;
attribute float aKind;
attribute vec4 aSeed;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uR;
uniform vec4 uRot;
uniform float uCam;
uniform float uT;
uniform float uLift;      // deslocamento vertical da moeda (queda, quique, flutuação), px
uniform float uShiftX;    // deslocamento horizontal da moeda (rolagem até a área), px
uniform vec2 uRoll;       // cos/sin do giro no próprio eixo (rolagem)
uniform float uScroll;    // rolagem da página, px (parallax)
uniform float uDpr;
uniform vec3 uLight;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uLightTheme;
varying vec4 vColor;

// Giro no plano da face (em torno do eixo da moeda). Com y para baixo, ângulo
// positivo é horário: o sentido de uma moeda rolando para a direita.
vec3 rollFace(vec3 v) {
  return vec3(v.x * uRoll.x - v.y * uRoll.y, v.x * uRoll.y + v.y * uRoll.x, v.z);
}

vec3 toWorld(vec3 v) {
  float x1 = v.x * uRot.x + v.z * uRot.y;
  float z1 = -v.x * uRot.y + v.z * uRot.x;
  return vec3(x1, v.y * uRot.z - z1 * uRot.w, v.y * uRot.w + z1 * uRot.z);
}

void main() {
  float w = aSeed.w;
  vec2 pos;
  float size;
  float alpha;
  vec3 col = uInk;

  if (aKind > 3.5) {
    // Ambiente: soltas pela seção inteira, subindo devagar, em três "planos".
    float depth = aPos.z;
    float x = aPos.x * uRes.x + sin(uT * (0.05 + 0.1 * w) + w * 40.0) * 30.0 * uDpr * (0.5 + depth);
    // Parallax: as mais próximas sobem mais rápido com a rolagem da página.
    float y = mod(aPos.y * uRes.y - uT * (4.0 + 10.0 * depth) * uDpr - uScroll * (0.08 + 0.22 * depth), uRes.y);
    pos = vec2(x, y);
    size = (0.8 + 1.4 * depth) * uDpr;
    float dist = length((pos - uCenter) / uR);
    float twinkle = 0.6 + 0.4 * sin(uT * (0.5 + w) + w * 30.0);
    // Mais presentes perto da moeda, discretas sob o texto.
    alpha = (0.08 + 0.24 * depth) * mix(0.35, 1.0, exp(-dist * 0.3)) * twinkle;
    if (aSeed.z > 0.94) col = uAccent;
  } else {
    // Moeda: posição na face/borda, com um respiro leve e o giro 3D.
    vec3 local = aPos + vec3(sin(uT * 0.9 + w * 50.0), cos(uT * 0.8 + w * 31.0), sin(uT * 0.7 + w * 17.0)) * 0.005;
    // Rolagem: a moeda gira no próprio eixo (o da face), como uma roda.
    local = rollFace(local);
    vec3 world = toWorld(local);
    float persp = uCam / (uCam - world.z);
    // A moeda inteira se move junto: queda, quique, rolagem e flutuação.
    pos = uCenter + vec2(uShiftX, uLift) + world.xy * persp * uR;

    // Luz: a normal gira com a moeda (face para a frente, borda para fora).
    vec3 nLocal = aKind > 2.5 ? vec3(normalize(aPos.xy), 0.0) : vec3(aPos.xy * 0.35, 1.0);
    vec3 n = normalize(toWorld(rollFace(nLocal)));
    float diff = max(dot(n, normalize(uLight)), 0.0);
    float strength = aKind < 0.5 ? 0.32 : (aKind < 1.5 ? 1.0 : (aKind < 2.5 ? 0.8 : 0.55));
    // O relevo nunca apaga de todo: é ele que mantém o logo legível no giro.
    alpha = strength * (aKind > 0.5 && aKind < 1.5 ? 0.55 + 0.45 * diff : 0.3 + 0.7 * diff);
    // Pontos finos: a forma vem da densidade, não do tamanho de cada um.
    float base = aKind < 0.5 ? 0.9 : (aKind < 1.5 ? 1.35 : 1.15);
    size = base * persp * uDpr * (0.85 + 0.3 * w);
    // A metade de trás da borda fica escondida atrás da face.
    if (aKind > 2.5) alpha *= smoothstep(-0.15, 0.25, n.z);
    if (aKind > 0.5 && aKind < 1.5 && aSeed.z > 0.985) col = uAccent;
    // Com milhares de pontos somando, cada um entra mais fraco: é o acúmulo
    // que acende a forma, sem estourar no branco.
    alpha *= 0.6;
  }

  // No tema claro a tinta não soma luz: pontos mais opacos.
  alpha = min(1.0, alpha * mix(1.0, 1.25, uLightTheme));
  gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
  gl_PointSize = max(1.0, size);
  vColor = vec4(col * alpha, alpha);
}
`;

const FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vColor * smoothstep(1.0, 0.45, r);
}
`;

/** Pseudoaleatório com semente: a moeda nasce sempre igual. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pontos da moeda e do ambiente: [x, y, z, tipo, sementes ×4] por partícula.
 * Na face, o relevo (logo, filete, perolado) recebe bem mais pontos que o campo.
 */
function buildParticles(mask: Uint8ClampedArray | null, maskSize: number, compact: boolean) {
  const rand = mulberry32(23);
  const counts = compact
    ? { relief: 9000, field: 5000, rim: 2400, side: 3200, ambient: 2400 }
    : { relief: 16000, field: 9000, rim: 4000, side: 5600, ambient: 5000 };
  // Sem a máscara (logo não carregou), a face inteira vira campo.
  if (!mask) {
    counts.field += counts.relief;
    counts.relief = 0;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const data = new Float32Array(total * 8);
  let n = 0;
  const h = COIN_THICKNESS / 2;
  const push = (x: number, y: number, z: number, kind: number) => {
    data.set([x, y, z, kind, rand(), rand(), rand(), rand()], n * 8);
    n++;
  };
  const maskAt = (u: number, v: number) => {
    if (!mask) return 0;
    const x = Math.round(((u + 1) / 2) * (maskSize - 1));
    const y = Math.round(((v + 1) / 2) * (maskSize - 1));
    return mask[(y * maskSize + x) * 4 + 3] / 255;
  };

  // Face: amostragem por rejeição; o relevo entra como "relief", o resto como "field".
  let relief = 0;
  let field = 0;
  let guard = 0;
  while ((relief < counts.relief || field < counts.field) && guard++ < 3000000) {
    const u = rand() * 2 - 1;
    const v = rand() * 2 - 1;
    const r = Math.hypot(u, v);
    if (r > RIM_START) continue;
    if (maskAt(u, v) > 0.5) {
      if (relief < counts.relief) {
        push(u, v, h, KIND.relief);
        relief++;
      }
    } else if (field < counts.field) {
      push(u, v, h, KIND.field);
      field++;
    }
  }
  // Aro da face.
  for (let i = 0; i < counts.rim; i++) {
    const a = rand() * Math.PI * 2;
    const r = RIM_START + rand() * (1 - RIM_START);
    push(Math.cos(a) * r, Math.sin(a) * r, h, KIND.rim);
  }
  // Borda (lateral do cilindro).
  for (let i = 0; i < counts.side; i++) {
    const a = rand() * Math.PI * 2;
    push(Math.cos(a), Math.sin(a), (rand() * 2 - 1) * h, KIND.side);
  }
  // Ambiente: posição relativa na seção (0..1) e profundidade.
  for (let i = 0; i < counts.ambient; i++) push(rand(), rand(), rand(), KIND.ambient);

  return { data: data.subarray(0, n * 8), count: n };
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** Cor de uma variável HSL do tema, em RGB 0..1. */
function cssRgb(el: Element, name: string, fallback: [number, number, number]) {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  if (!value) return fallback;
  const probe = document.createElement('span');
  probe.style.color = `hsl(${value})`;
  el.appendChild(probe);
  const rgb = getComputedStyle(probe)
    .color.match(/\d+(\.\d+)?/g)
    ?.map(Number);
  probe.remove();
  return rgb ? ([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255] as [number, number, number]) : fallback;
}

export function ParticleCoin() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const section = canvas?.closest('section');
    if (!canvas || !section) return;
    const fail = () => window.dispatchEvent(new Event(COIN_FALLBACK_EVENT));

    const gl = canvas.getContext('webgl', {
      premultipliedAlpha: true,
      antialias: false,
      alpha: true,
    });
    const vs = gl && compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = gl && compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl?.createProgram();
    if (!gl || !vs || !fs || !program) {
      fail();
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      fail();
      return;
    }
    gl.useProgram(program);
    gl.enable(gl.BLEND);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uni = {
      res: u('uRes'),
      center: u('uCenter'),
      r: u('uR'),
      rot: u('uRot'),
      cam: u('uCam'),
      t: u('uT'),
      lift: u('uLift'),
      shiftX: u('uShiftX'),
      roll: u('uRoll'),
      scroll: u('uScroll'),
      dpr: u('uDpr'),
      light: u('uLight'),
      ink: u('uInk'),
      accent: u('uAccent'),
      lightTheme: u('uLightTheme'),
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const buffer = gl.createBuffer();
    let count = 0;
    // Posição da moeda em relação ao lugar dela (px do canvas) e giro da rolagem.
    const motion = {
      phase: 'waiting' as 'waiting' | 'moving' | 'resting',
      y: 0,
      vy: 0,
      x: 0,
      vx: 0,
      angle: 0,
      landed: false,
      grounded: false,
      last: 0,
    };
    // Parallax do mouse: alvo (-1..1) e valor suavizado.
    const hover = { tx: 0, ty: 0, x: 0, y: 0 };
    let scrollPx = 0;
    let dpr = 1;
    let center = { x: 0, y: 0 };
    let radius = 0;
    let raf = 0;
    let running = false;
    let visible = false;
    const start = performance.now();
    // Luz orbitando sozinha.
    const light = { x: -0.5, y: -0.6 };

    let colors = { ink: [0, 0, 0], accent: [0, 0, 1], dark: false };
    const readColors = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      colors = {
        ink: cssRgb(section, '--ink', [0.06, 0.09, 0.16]),
        accent: cssRgb(section, '--primary', [0.15, 0.39, 0.92]),
        dark,
      };
      // Escuro: luz que soma (brilho). Claro: tinta sobre papel.
      if (dark) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    };
    readColors();

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const anchor = section.querySelector('[data-coin-anchor]');
      const a = anchor?.getBoundingClientRect();
      if (a) {
        center = {
          x: (a.left - rect.left + a.width / 2) * dpr,
          y: (a.top - rect.top + a.height / 2) * dpr,
        };
        radius = Math.min(a.width, a.height) * COIN_RADIUS * dpr;
      }
      scrollPx = window.scrollY * dpr;
    };

    /**
     * Avança a física um quadro: queda, quiques e rolagem ao mesmo tempo, como
     * uma moeda de verdade. Em passos pequenos, para a mola da rolagem não
     * oscilar quando um quadro demora.
     */
    const step = (now: number) => {
      const frame = Math.min(0.05, (now - motion.last) / 1000);
      motion.last = now;

      // O mouse é suavizado sempre, até com a moeda parada.
      const ease = 1 - Math.exp(-HOVER_EASE * frame);
      hover.x += (hover.tx - hover.x) * ease;
      hover.y += (hover.ty - hover.y) * ease;

      if (motion.phase !== 'moving') return;
      const g = GRAVITY * dpr;
      const w = ROLL_STIFFNESS;
      const steps = 4;
      const dt = frame / steps;
      for (let i = 0; i < steps; i++) {
        // Vertical: o "chão" é a posição de repouso (y = 0).
        if (!motion.grounded) {
          motion.vy += g * dt;
          motion.y += motion.vy * dt;
          if (motion.y >= 0) {
            motion.y = 0;
            if (!motion.landed) {
              // Primeiro impacto: parte do embalo vira rolagem para a direita.
              motion.landed = true;
              motion.vx = -motion.x * w * ROLL_KICK;
            }
            if (motion.vy < MIN_BOUNCE_SPEED * dpr) {
              motion.vy = 0;
              motion.grounded = true;
            } else {
              motion.vy = -motion.vy * RESTITUTION;
            }
          }
        }
        // Horizontal: depois do primeiro impacto, rola (inclusive entre quiques).
        if (motion.landed) {
          const ax = -w * w * motion.x - 2 * w * motion.vx;
          motion.vx += ax * dt;
          motion.x += motion.vx * dt;
        }
      }
      // Rola sem deslizar: o giro é a distância dividida pelo raio, então em
      // x = 0 o logo está reto na horizontal.
      motion.angle = radius > 0 ? motion.x / radius : 0;
      if (motion.grounded && Math.abs(motion.x) < 0.5 && Math.abs(motion.vx) < 4) {
        motion.x = 0;
        motion.vx = 0;
        motion.angle = 0;
        motion.phase = 'resting';
      }
    };

    const setup = (maskData: Uint8ClampedArray | null, size: number) => {
      const compact = canvas.getBoundingClientRect().width < 640;
      const built = buildParticles(maskData, size, compact);
      count = built.count;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, built.data, gl.STATIC_DRAW);
      const stride = 8 * 4;
      const attr = (name: string, size: number, offset: number) => {
        const loc = gl.getAttribLocation(program, name);
        if (loc < 0) return;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
      };
      attr('aPos', 3, 0);
      attr('aKind', 1, 3);
      attr('aSeed', 4, 4);
      // Com movimento reduzido, a moeda já aparece no lugar, parada.
      if (reduced) {
        motion.phase = 'resting';
        motion.y = 0;
      } else {
        motion.phase = 'moving';
        // Nasce acima da seção, fora da tela, mais perto do centro da tela e já
        // inclinada: a inclinação é a que a rolagem até a área vai desfazer.
        const rect = canvas.getBoundingClientRect();
        const screenCenterX = (window.innerWidth / 2 - rect.left) * dpr;
        const toCenter = Math.max(0, center.x - screenCenterX);
        motion.x = -Math.min(toCenter, radius * MAX_ROLL_RADII);
        motion.angle = radius > 0 ? motion.x / radius : 0;
        motion.y = -(center.y + radius * 1.4);
        motion.vy = 0;
        motion.vx = 0;
        motion.last = performance.now();
      }
    };

    const draw = (now: number) => {
      if (!count || canvas.width === 0) return;
      const t = (now - start) / 1000;
      const idle = idleLight(t);
      light.x = idle.x;
      light.y = idle.y;
      // Giro de vaivém + o quanto a moeda "olha" para o ponteiro.
      const phi = coinSpin(t, reduced) + hover.x * HOVER_TURN;
      const tilt = COIN_TILT - hover.y * HOVER_TILT;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uni.res, canvas.width, canvas.height);
      gl.uniform2f(uni.center, center.x, center.y);
      gl.uniform1f(uni.r, radius);
      gl.uniform4f(uni.rot, Math.cos(phi), Math.sin(phi), Math.cos(tilt), Math.sin(tilt));
      gl.uniform1f(uni.cam, CAMERA_DISTANCE);
      gl.uniform1f(uni.t, reduced ? 0 : t);
      const parallax = reduced ? 0 : scrollPx * PARALLAX;
      gl.uniform1f(uni.lift, motion.y + parallax + hover.y * HOVER_SHIFT * dpr);
      gl.uniform1f(uni.shiftX, motion.x + hover.x * HOVER_SHIFT * dpr);
      gl.uniform2f(uni.roll, Math.cos(motion.angle), Math.sin(motion.angle));
      gl.uniform1f(uni.scroll, reduced ? 0 : scrollPx);
      gl.uniform1f(uni.dpr, dpr);
      gl.uniform3f(uni.light, light.x, light.y, 0.9);
      gl.uniform3fv(uni.ink, colors.ink);
      gl.uniform3fv(uni.accent, colors.accent);
      gl.uniform1f(uni.lightTheme, colors.dark ? 0 : 1);
      gl.drawArrays(gl.POINTS, 0, count);
    };

    const loop = (now: number) => {
      step(now);
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    const play = () => {
      if (running || reduced || !visible || document.hidden) return;
      running = true;
      // Sem salto de física ao voltar de uma pausa.
      motion.last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const pause = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const onVisibility = () => (document.hidden ? pause() : play());
    const onScroll = () => {
      scrollPx = window.scrollY * dpr;
    };
    // Parallax no hover: só com mouse (no toque não há "passar por cima").
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || radius === 0) return;
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      // Normalizado por 3 raios: no centro da moeda é 0, nas bordas do hero ~±1.
      hover.tx = Math.max(-1, Math.min(1, (px - center.x) / (radius * 3)));
      hover.ty = Math.max(-1, Math.min(1, (py - center.y) / (radius * 3)));
    };
    const onPointerLeave = () => {
      hover.tx = 0;
      hover.ty = 0;
    };
    const onContextLost = (e: Event) => {
      e.preventDefault();
      pause();
      fail();
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) play();
      else pause();
    });
    const resizeObserver = new ResizeObserver(() => {
      layout();
      draw(performance.now());
    });
    const unsubscribeTheme = subscribeTheme(() => {
      readColors();
      draw(performance.now());
    });

    layout();
    observer.observe(canvas);
    resizeObserver.observe(section);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScroll, { passive: true });
    if (!reduced) {
      section.addEventListener('pointermove', onPointerMove, { passive: true });
      section.addEventListener('pointerleave', onPointerLeave);
    }
    canvas.addEventListener('webglcontextlost', onContextLost);

    let cancelled = false;
    const MASK = 256;
    drawCoinMask(MASK)
      .then((maskCanvas) => {
        const data = maskCanvas.getContext('2d')?.getImageData(0, 0, MASK, MASK).data ?? null;
        if (!cancelled) setup(data, MASK);
      })
      .catch(() => {
        // Sem o logo, a moeda sai lisa: segue funcionando.
        if (!cancelled) setup(null, MASK);
      })
      .finally(() => {
        if (!cancelled) draw(performance.now());
      });

    return () => {
      cancelled = true;
      pause();
      observer.disconnect();
      resizeObserver.disconnect();
      unsubscribeTheme();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', onScroll);
      section.removeEventListener('pointermove', onPointerMove);
      section.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 block h-full w-full"
    />
  );
}

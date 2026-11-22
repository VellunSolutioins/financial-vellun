'use client';
import { useEffect, useRef } from 'react';
import { subscribeTheme } from '@/lib/public-theme';
import { cn } from '@/lib/utils';
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
 * A mesma moeda da meia-tinta, mas sólida: metal liso com o logo em relevo
 * polido, campo fosco, aro serrilhado, brilho especular e sombra no "chão".
 * É um shader WebGL calculado por pixel (sem biblioteca), com a mesma
 * geometria 3D, giro e luz da versão em pixels (`coin-mask.ts`): a moeda é
 * um cilindro em perspectiva, então o logo, o brilho e a borda giram juntos.
 *
 * Sem WebGL, chama `onUnsupported` para a página voltar à meia-tinta.
 * Pausa fora da tela e com a aba oculta; com movimento reduzido, fica parada.
 */

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
uniform vec2 uRes;        // canvas, px do dispositivo
uniform float uR;         // raio da moeda, px
uniform vec4 uRot;        // cos/sin do giro e da inclinação
uniform float uHalf;      // meia espessura, em raios
uniform float uCam;       // distância da câmera, em raios
uniform vec3 uLight;      // direção da luz (y para baixo)
uniform vec3 uMetal;      // cor base do metal
uniform vec3 uShadow;     // cor da sombra no chão
uniform float uShadowAlpha;
uniform float uRim;
uniform sampler2D uMask;

// Mesma conta de coin-mask.ts (toLocal / toWorld / traceCoin).
vec3 toLocal(vec3 v) {
  float y1 = v.y * uRot.z + v.z * uRot.w;
  float z1 = -v.y * uRot.w + v.z * uRot.z;
  return vec3(v.x * uRot.x - z1 * uRot.y, y1, v.x * uRot.y + z1 * uRot.x);
}

vec3 toWorld(vec3 v) {
  float x1 = v.x * uRot.x + v.z * uRot.y;
  float z1 = -v.x * uRot.y + v.z * uRot.x;
  return vec3(x1, v.y * uRot.z - z1 * uRot.w, v.y * uRot.w + z1 * uRot.z);
}

// 0: nada; 1: face da frente; 2: lateral. q: ponto atingido, no espaço da moeda.
float trace(vec2 p, out vec3 q) {
  vec3 ro = toLocal(vec3(0.0, 0.0, uCam));
  vec3 rd = toLocal(vec3(p, -uCam));
  float best = 1e9;
  float kind = 0.0;
  q = vec3(0.0);
  if (abs(rd.z) > 1e-6) {
    float t = (uHalf - ro.z) / rd.z;
    vec3 h = ro + t * rd;
    if (t > 0.0 && dot(h.xy, h.xy) <= 1.0) { best = t; kind = 1.0; q = h; }
  }
  float a = dot(rd.xy, rd.xy);
  float b = 2.0 * dot(ro.xy, rd.xy);
  float c = dot(ro.xy, ro.xy) - 1.0;
  float disc = b * b - 4.0 * a * c;
  if (a > 0.0 && disc >= 0.0) {
    float t = (-b - sqrt(disc)) / (2.0 * a);
    vec3 h = ro + t * rd;
    if (t > 0.0 && t < best && abs(h.z) <= uHalf) { kind = 2.0; q = h; }
  }
  return kind;
}

float mask(vec2 uv) {
  vec2 t = uv * 0.5 + 0.5;
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return 0.0;
  return texture2D(uMask, t).a;
}

vec3 shade(vec3 n, vec3 base, float polish) {
  vec3 L = normalize(uLight);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, H), 0.0), mix(18.0, 60.0, polish));
  // Reflexo "de ambiente" barato: metal escurece de frente e clareia de lado.
  float fres = pow(1.0 - max(n.z, 0.0), 2.0);
  return base * (0.32 + 0.78 * diff) + vec3(1.0) * spec * mix(0.25, 0.9, polish) + base * fres * 0.25;
}

vec3 surface(float kind, vec3 q) {
  if (kind > 1.5) {
    // Lateral: serrilha como ondulação da normal em volta do cilindro.
    float a = atan(q.y, q.x);
    vec3 radial = vec3(cos(a), sin(a), 0.0);
    vec3 tangent = vec3(-sin(a), cos(a), 0.0);
    vec3 n = normalize(radial + tangent * sin(a * 160.0) * 0.18);
    return shade(normalize(toWorld(n)), uMetal * 0.78, 0.45);
  }
  vec2 uv = q.xy;
  float r = length(uv);
  vec3 n = vec3(uv * 0.45, sqrt(max(0.0, 1.0 - r * r * 0.55)));
  vec3 base;
  float polish;
  if (r > uRim) {
    // Aro: borda arredondada para fora, com serrilha fina.
    float a = atan(uv.y, uv.x);
    float k = smoothstep(uRim, 1.0, r);
    n.xy += vec2(cos(a), sin(a)) * (0.9 * k - 0.35 * (1.0 - k)) + vec2(sin(a * 140.0) * 0.06);
    base = uMetal * 0.95;
    polish = 0.7;
  } else {
    // Relevo do logo, do filete e do perolado: inclinação pela diferença da máscara.
    float e = 3.2 / 512.0;
    vec2 g = vec2(mask(uv + vec2(e, 0.0)) - mask(uv - vec2(e, 0.0)),
                  mask(uv + vec2(0.0, e)) - mask(uv - vec2(0.0, e)));
    n.xy -= g * 2.2;
    float z = mask(uv);
    // Relevo polido; campo fosco com granulado preso à face (gira junto).
    float grain = fract(sin(dot(floor(uv * 260.0), vec2(12.9898, 78.233))) * 43758.5453);
    base = mix(uMetal * (0.8 + grain * 0.05), uMetal * 1.08, z);
    polish = mix(0.12, 0.85, z);
  }
  // A normal é da face; girando a moeda, ela gira junto (luz e brilho acompanham).
  return shade(normalize(toWorld(normalize(n))), base, polish);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 d = frag - uRes * 0.5;
  vec2 p = d / uR;
  vec4 col = vec4(0.0);

  // Sombra elíptica no "chão", logo abaixo da moeda.
  vec2 sd = vec2(d.x / (uR * 0.95), (d.y - uR * 1.14) / (uR * 0.14));
  float sh = exp(-dot(sd, sd) * 1.4) * uShadowAlpha;
  col = vec4(uShadow * sh, sh);

  // Cobertura com 2×2 amostras: contorno sem serrilhado.
  float px = 1.0 / uR;
  vec3 q;
  float kind = 0.0;
  float cover = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(mod(float(i), 2.0) - 0.5, floor(float(i) / 2.0) - 0.5) * 0.5 * px;
    vec3 qi;
    float ki = trace(p + o, qi);
    if (ki > 0.0) {
      cover += 0.25;
      if (kind == 0.0) { kind = ki; q = qi; }
    }
  }
  // O centro decide o material quando ele próprio atinge a moeda.
  vec3 qc;
  float kc = trace(p, qc);
  if (kc > 0.0) { kind = kc; q = qc; }

  if (cover > 0.0) col = mix(col, vec4(surface(kind, q), 1.0), cover);
  gl_FragColor = col;
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** Metal prateado puxado para o azul da marca; um pouco mais claro no tema escuro. */
function readMaterial(el: Element) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const probe = document.createElement('span');
  probe.style.color = `hsl(${getComputedStyle(el).getPropertyValue('--primary').trim() || '221 83% 53%'})`;
  el.appendChild(probe);
  const rgb = getComputedStyle(probe)
    .color.match(/\d+(\.\d+)?/g)
    ?.map(Number) ?? [37, 99, 235];
  probe.remove();
  const silver = dark ? [0.86, 0.89, 0.94] : [0.78, 0.82, 0.89];
  const tint = 0.12;
  const metal = silver.map((s, i) => s * (1 - tint) + (rgb[i] / 255) * tint);
  return {
    metal,
    shadow: dark ? [0, 0, 0] : [0.06, 0.09, 0.16],
    shadowAlpha: dark ? 0.55 : 0.22,
  };
}

export function SolidCoin({
  className,
  onUnsupported,
}: {
  className?: string;
  onUnsupported?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      premultipliedAlpha: true,
      antialias: false,
      alpha: true,
    });
    const vs = gl && compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = gl && compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl?.createProgram();
    if (!gl || !vs || !fs || !program) {
      onUnsupported?.();
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      onUnsupported?.();
      return;
    }
    gl.useProgram(program);

    // Um retângulo cobrindo o canvas; o shader decide cada pixel.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uni = {
      res: u('uRes'),
      r: u('uR'),
      rot: u('uRot'),
      half: u('uHalf'),
      cam: u('uCam'),
      light: u('uLight'),
      metal: u('uMetal'),
      shadow: u('uShadow'),
      shadowAlpha: u('uShadowAlpha'),
      rim: u('uRim'),
      mask: u('uMask'),
    };

    // Textura da máscara: começa vazia (moeda lisa) e recebe o relevo ao carregar.
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.uniform1i(uni.mask, 0);
    gl.uniform1f(uni.rim, RIM_START);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let material = readMaterial(canvas);
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let running = false;
    let visible = false;
    const start = performance.now();
    const light = { x: -0.5, y: -0.6 };
    const target = { x: -0.5, y: -0.6, active: false };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const draw = (now: number) => {
      if (width === 0 || height === 0) return;
      const t = (now - start) / 1000;
      if (!target.active) {
        const idle = idleLight(t);
        target.x = idle.x;
        target.y = idle.y;
      }
      const k = reduced ? 1 : 0.06;
      light.x += (target.x - light.x) * k;
      light.y += (target.y - light.y) * k;

      const R = Math.min(canvas.width, canvas.height) * COIN_RADIUS;
      const phi = coinSpin(t, reduced);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uni.res, canvas.width, canvas.height);
      gl.uniform1f(uni.r, R);
      gl.uniform4f(uni.rot, Math.cos(phi), Math.sin(phi), Math.cos(COIN_TILT), Math.sin(COIN_TILT));
      gl.uniform1f(uni.half, COIN_THICKNESS / 2);
      gl.uniform1f(uni.cam, CAMERA_DISTANCE);
      gl.uniform3f(uni.light, light.x, light.y, 0.9);
      gl.uniform3fv(uni.metal, material.metal);
      gl.uniform3fv(uni.shadow, material.shadow);
      gl.uniform1f(uni.shadowAlpha, material.shadowAlpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
      material = readMaterial(canvas);
      draw(performance.now());
    });
    const onContextLost = (e: Event) => {
      e.preventDefault();
      pause();
      onUnsupported?.();
    };

    resize();
    observer.observe(canvas);
    resizeObserver.observe(canvas);
    const scope = canvas.closest('section') ?? canvas;
    scope.addEventListener('pointermove', onPointerMove as EventListener, { passive: true });
    scope.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('webglcontextlost', onContextLost);

    let cancelled = false;
    drawCoinMask(512)
      .then((maskCanvas) => {
        if (cancelled) return;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
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
      canvas.removeEventListener('webglcontextlost', onContextLost);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [onUnsupported]);

  return <canvas ref={canvasRef} aria-hidden className={cn('block h-full w-full', className)} />;
}

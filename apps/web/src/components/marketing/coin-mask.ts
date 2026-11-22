/**
 * Relevo da face da moeda do Zeloo, desenhado num canvas `size × size` que
 * cobre o círculo unitário: o logo ("Z" + "zeloo") no centro, um filete fino e
 * um anel de contas (perolado). Vale só o alfa: 1 é relevo, 0 é campo.
 * Usado pelas duas versões da moeda (meia-tinta e sólida).
 */
export async function drawCoinMask(size: number): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = '/marca/zeloo-logo.svg';
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
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
  return canvas;
}

/** Raio da moeda em relação ao menor lado do canvas (as duas versões). */
export const COIN_RADIUS = 0.38;
/** Espessura da moeda, em raios (a borda aparece quando ela gira). */
export const COIN_THICKNESS = 0.18;
/** Inclinação fixa para a frente, em radianos: mostra um pouco do aro de cima. */
export const COIN_TILT = 0.12;
/** Distância da câmera, em raios: perspectiva leve, sem distorcer o logo. */
export const CAMERA_DISTANCE = 6;
/** Onde começa o aro (em raios). */
export const RIM_START = 0.88;

/** Giro de vaivém em torno do eixo vertical, em radianos. Parada: ¾ de perfil leve. */
export function coinSpin(t: number, reduced: boolean): number {
  return reduced ? 0.35 : 0.55 * Math.sin(t * 0.32) + 0.1;
}

/*
 * Geometria 3D da moeda: um cilindro de raio 1 e espessura COIN_THICKNESS,
 * girado `phi` em torno do eixo vertical e inclinado COIN_TILT para a frente,
 * visto por uma câmera em perspectiva. Coordenadas da tela em raios, com y para
 * baixo (o mesmo sentido da luz). O shader da moeda sólida repete esta conta.
 */

export interface CoinPose {
  cp: number;
  sp: number;
  ct: number;
  st: number;
}

export function coinPose(phi: number): CoinPose {
  return { cp: Math.cos(phi), sp: Math.sin(phi), ct: Math.cos(COIN_TILT), st: Math.sin(COIN_TILT) };
}

type Vec3 = [number, number, number];

/** Do espaço da cena para o da moeda (inverso de `toWorld`). */
function toLocal([x, y, z]: Vec3, p: CoinPose): Vec3 {
  const y1 = y * p.ct + z * p.st;
  const z1 = -y * p.st + z * p.ct;
  return [x * p.cp - z1 * p.sp, y1, x * p.sp + z1 * p.cp];
}

/** Da moeda para a cena: gira `phi` no eixo vertical e inclina COIN_TILT. */
export function toWorld([x, y, z]: Vec3, p: CoinPose): Vec3 {
  const x1 = x * p.cp + z * p.sp;
  const z1 = -x * p.sp + z * p.cp;
  return [x1, y * p.ct - z1 * p.st, y * p.st + z1 * p.ct];
}

export type CoinHit =
  { kind: 'face'; u: number; v: number } | { kind: 'side'; angle: number; depth: number } | null;

/**
 * O que o raio que passa pelo ponto (px, py) da tela atinge primeiro: a face
 * (com `u, v` no círculo unitário, onde o logo é amostrado), a borda (com o
 * ângulo, para a serrilha) ou nada.
 */
export function traceCoin(px: number, py: number, pose: CoinPose): CoinHit {
  const h = COIN_THICKNESS / 2;
  const ro = toLocal([0, 0, CAMERA_DISTANCE], pose);
  const rd = toLocal([px, py, -CAMERA_DISTANCE], pose);
  let best = Infinity;
  let hit: CoinHit = null;

  // Face da frente (z = +h).
  if (rd[2] !== 0) {
    const t = (h - ro[2]) / rd[2];
    const qx = ro[0] + t * rd[0];
    const qy = ro[1] + t * rd[1];
    if (t > 0 && qx * qx + qy * qy <= 1) {
      best = t;
      hit = { kind: 'face', u: qx, v: qy };
    }
  }

  // Lateral do cilindro.
  const a = rd[0] * rd[0] + rd[1] * rd[1];
  const b = 2 * (ro[0] * rd[0] + ro[1] * rd[1]);
  const c = ro[0] * ro[0] + ro[1] * ro[1] - 1;
  const disc = b * b - 4 * a * c;
  if (a > 0 && disc >= 0) {
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    const qz = ro[2] + t * rd[2];
    if (t > 0 && t < best && Math.abs(qz) <= h) {
      const qx = ro[0] + t * rd[0];
      const qy = ro[1] + t * rd[1];
      hit = { kind: 'side', angle: Math.atan2(qy, qx), depth: qz / h };
    }
  }
  return hit;
}

/** Luz orbitando sozinha (sem ponteiro), em coordenadas da moeda (-1..1). */
export function idleLight(t: number): { x: number; y: number } {
  return { x: Math.cos(t * 0.35) * 0.75, y: -0.45 + Math.sin(t * 0.35) * 0.35 };
}

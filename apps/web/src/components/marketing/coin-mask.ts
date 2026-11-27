/**
 * Relevo da face da moeda do Zeloo, desenhado num canvas `size × size` que
 * cobre o círculo unitário: o logo ("Z" + "zeloo") no centro, um filete fino e
 * um anel de contas (perolado). Vale só o alfa: 1 é relevo, 0 é campo.
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

/** Raio da moeda em relação ao menor lado da área dela no hero. */
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

/** Luz orbitando sozinha, em coordenadas da moeda (-1..1). */
export function idleLight(t: number): { x: number; y: number } {
  return { x: Math.cos(t * 0.35) * 0.75, y: -0.45 + Math.sin(t * 0.35) * 0.35 };
}

/**
 * Roteiro da seção Recursos, guiado pelo scroll. Ritmo medido na referência
 * (página que prende a cena e troca de capítulo com o scroll):
 * - capítulos parados (a câmera segura) e transições curtas entre eles; a
 *   transição dura ~0,27 do tempo parado (1,0 s de câmera para 3,7 s de pausa);
 * - a 1ª transição segue o caminho do cano (a câmera "acompanha" a moeda);
 * - a 2ª é um recuo mais longo (2,25 s na referência, ~1,6× a 1ª), com o pico
 *   de velocidade no fim, não no meio;
 * - o texto de cada capítulo entra ~0,3 s depois de a câmera parar e some
 *   antes de ela voltar a andar.
 *
 * Aqui `p` (0..1) é o avanço do scroll na seção presa.
 */

// Proporções da referência: descida = 0,27 da pausa seguinte; recuo = 1,6× a descida.
export const CHAPTERS = {
  overview: [0, 0.24],
  follow: [0.24, 0.32],
  boxes: [0.32, 0.62],
  pullBack: [0.62, 0.75],
  chart: [0.75, 1],
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const span = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
export const easeIO = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
/**
 * Recuo: o pico de velocidade fica a ~2/3 do trecho (13,25 s em 11,75–14 s na
 * referência). O tempo é entortado antes da curva suave: sem quinas na velocidade.
 */
const easeLate = (x: number) => easeIO(Math.pow(x, 1.65));

export interface FlowPose {
  /** Trecho da câmera: 0 = visão geral, 1 = caixas, 2 = gráfico (fracionário nas transições). */
  shot: number;
  /** Quanto das pilhas de moedas já se formou (0..1). */
  stacks: number;
  /** Rótulos de valor sobre as pilhas (0..1). */
  values: number;
  /** Opacidade de cada bloco de texto. */
  text: [number, number, number];
}

export function flowPose(p: number): FlowPose {
  const [, f1] = CHAPTERS.follow;
  const [b0] = CHAPTERS.follow;
  const t1 = easeIO(span(p, b0, f1));
  const t2 = easeLate(span(p, CHAPTERS.pullBack[0], CHAPTERS.pullBack[1]));
  const shot = p < CHAPTERS.pullBack[0] ? t1 : 1 + t2;

  const fadeIn = (start: number) => span(p, start + 0.008, start + 0.04);
  const fadeOut = (end: number) => 1 - span(p, end - 0.025, end);
  return {
    shot,
    stacks: span(p, 0.3, 0.95),
    values: span(p, 0.76, 0.84),
    text: [
      fadeOut(CHAPTERS.overview[1]),
      fadeIn(CHAPTERS.boxes[0]) * fadeOut(CHAPTERS.boxes[1]),
      fadeIn(CHAPTERS.chart[0]),
    ],
  };
}

/** Momentos para os stills de aprovação. */
export const FLOW_MOMENTS = [
  { p: 0.1, label: 'visão geral' },
  { p: 0.28, label: 'câmera segue a moeda' },
  { p: 0.47, label: 'moedas nas caixas' },
  { p: 0.69, label: 'recuo' },
  { p: 0.95, label: 'gráfico formado' },
] as const;

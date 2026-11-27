/**
 * Roteiro da seção "Como funciona", guiado pelo scroll (`p`, 0..1, na seção
 * presa). Ritmo medido na referência (celular com conversa que vai chegando):
 * - antes de cada resposta, o "digitando…" fica ~0,5 s (~0,3 do intervalo
 *   entre balões); o balão entra em
 *   ~0,25 s, com um pequeno passo para cima;
 * - entre um balão e outro, ~1,5–2 s;
 * - o card que salta da tela leva 0,4 s e segura ~2,3 s (salto ≈ 0,17 da pausa);
 * - a câmera recua uma vez, em 0,5 s, com o pico no meio;
 * - o tempo todo há uma deriva lenta, quase parada.
 */

export type From = 'user' | 'zeloo';
export type Kind = 'text' | 'audio' | 'image';

export interface Message {
  from: From;
  kind: Kind;
  text?: string;
  /** Duração mostrada no áudio. */
  duration?: string;
  /** Hora no balão. */
  time: string;
  /** Quando o balão chega (p). */
  at: number;
  /** Para o Zeloo: quando começa o "digitando…" (p). */
  typing?: number;
}

export const MESSAGES: Message[] = [
  {
    from: 'user',
    kind: 'text',
    text: 'Zeloo, acabei de fazer uma compra de 150 reais no mercado',
    time: '12:40',
    at: 0.07,
  },
  {
    from: 'zeloo',
    kind: 'text',
    text: 'Lançamento criado! Despesa de R$ 150,00 em Mercado 👍',
    time: '12:40',
    at: 0.17,
    typing: 0.14,
  },
  { from: 'user', kind: 'audio', duration: '0:06', time: '18:02', at: 0.3 },
  {
    from: 'zeloo',
    kind: 'text',
    text: 'Entendi: “Zeloo, acabei de gastar 200 reais no posto de gasolina.”\nEm qual categoria devo lançar?',
    time: '18:02',
    at: 0.37,
    typing: 0.35,
  },
  { from: 'user', kind: 'audio', duration: '0:02', time: '18:03', at: 0.43 },
  {
    from: 'zeloo',
    kind: 'text',
    text: 'Entendi: “Transporte.”\nLançamento criado! Despesa de R$ 200,00 em Transporte 👍',
    time: '18:03',
    at: 0.5,
    typing: 0.48,
  },
  { from: 'user', kind: 'image', time: '20:15', at: 0.58 },
  {
    from: 'zeloo',
    kind: 'text',
    text: 'Li o comprovante: despesa, R$ 83,90, categoria Restaurante.\nConfirma o lançamento? (sim/não)',
    time: '20:15',
    at: 0.78,
    typing: 0.77,
  },
  { from: 'user', kind: 'text', text: 'Sim', time: '20:16', at: 0.81 },
  {
    from: 'zeloo',
    kind: 'text',
    text: 'Lançamento criado! Despesa de R$ 83,90 em Restaurante 👍',
    time: '20:16',
    at: 0.845,
    typing: 0.835,
  },
];

/** Duração da entrada de um balão, em p (~0,25 s na referência). */
export const POP = 0.012;

/** O comprovante salta da tela, segura e volta (salto ≈ 0,17 da pausa). */
export const RECEIPT = { out: [0.6, 0.62], back: [0.735, 0.75] } as const;

/** Textos de apoio: intervalo de p em que cada um aparece. */
export const CHAPTER_SPANS: [number, number][] = [
  [0, 0.25],
  [0.27, 0.555],
  [0.565, 0.865],
  [0.88, 1.01],
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const span = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
export const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeIO = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** Opacidade de cada texto de apoio. */
export function chapterOpacity(p: number) {
  return CHAPTER_SPANS.map(([a, b], i) => {
    const inn = i === 0 ? 1 : span(p, a, a + 0.015);
    const out = b > 1 ? 1 : 1 - span(p, b - 0.015, b);
    return inn * out;
  });
}

/** Saída do comprovante da tela: 0 = no balão, 1 = grande, na frente. */
export function receiptLift(p: number) {
  const up = easeBack(span(p, RECEIPT.out[0], RECEIPT.out[1]));
  const down = easeIO(span(p, RECEIPT.back[0], RECEIPT.back[1]));
  return Math.max(0, up * (1 - down));
}

/** Recuo final da câmera (0,5 s na referência, pico no meio). */
export function finale(p: number) {
  return { pull: easeIO(span(p, 0.86, 0.9)) };
}

export const CHAT_MOMENTS = [
  { p: 0.2, label: 'mensagem e lançamento' },
  { p: 0.4, label: 'áudio e pergunta' },
  { p: 0.53, label: 'segundo áudio, categoria' },
  { p: 0.68, label: 'comprovante em destaque' },
  { p: 0.95, label: 'confirmado, celular flutuando' },
] as const;

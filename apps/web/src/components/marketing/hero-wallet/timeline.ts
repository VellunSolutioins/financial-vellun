/**
 * Roteiro da carteira do hero. O ritmo e a câmera vêm da referência (ciclo de
 * 4,5 s com dois picos de movimento); a história é do Zeloo: a carteira abre,
 * as moedas escapam, a carteira sai de cena e uma moeda vem até a tela e fica
 * flutuando no hero. Tudo é função do tempo `t`, sem estado: o mesmo `t` dá o
 * mesmo quadro, o que permite congelar qualquer momento (stills, movimento
 * reduzido).
 *
 * - 0,00–0,30 assenta
 * - 0,30–1,45 repouso: fechada, gira devagar no eixo vertical
 * - 1,45–1,60 antecipação: sobe um pouco e inclina para a frente
 * - 1,60–2,00 abre (1º pico): deita para trás e a aba cai; os cartões sobem
 * - 1,95–3,20 as moedas escapam, uma a cada 0,25 s, e saem por cima do quadro
 * - 2,00–2,90 a câmera aproxima (×1,0 → ×1,7) e depois respira (×1,62)
 * - 3,25 a última moeda salta e para no alto
 * - 3,85–4,50 a carteira cai para fora do quadro (2º pico) e a moeda vem para a tela
 * - 4,50 em diante: a moeda flutua
 */

/** Fim da entrada: daqui em diante, só a moeda flutuando. */
export const END = 4.5;

type Ease = 'linear' | 'in' | 'fall' | 'out' | 'io' | 'back';
type Key = readonly [time: number, value: number, ease?: Ease];

export const EASE: Record<Ease, (x: number) => number> = {
  linear: (x) => x,
  in: (x) => x * x * x,
  /** Queda: acelera como a gravidade. */
  fall: (x) => x * x,
  out: (x) => 1 - Math.pow(1 - x, 3),
  io: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  back: (x) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
};

/** Trilha de chaves: cada trecho usa a curva da chave em que termina. */
function track(keys: Key[]) {
  return (t: number) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, ease = 'io'] = keys[i];
      if (t <= t1) {
        const [t0, v0] = keys[i - 1];
        return v0 + (v1 - v0) * EASE[ease]((t - t0) / (t1 - t0));
      }
    }
    return keys[keys.length - 1][1];
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const deg = Math.PI / 180;

/** Giro no eixo vertical: balanço lento no repouso, 3/4 de perfil aberta. */
const yaw = track([
  [0, -18],
  [0.55, 16],
  [1.1, -14],
  [1.45, 2],
  [1.6, -4],
  [2.05, -4, 'out'],
  [3.85, -2],
  [4.5, -20, 'fall'],
]);

/** Inclinação: negativo deita o topo para trás. Na saída, tomba para a frente. */
const pitch = track([
  [0, 5],
  [0.3, 0],
  [1.3, 0],
  [1.46, 9],
  [1.8, -62, 'io'],
  [2.02, -8, 'out'],
  [2.25, -19],
  [3.7, -21],
  [3.85, -26, 'out'],
  [4.5, 22, 'fall'],
]);

/** Altura, em cm do mundo: pulinho de antecipação, recuo quando a moeda salta e a queda. */
const lift = track([
  [0, 0],
  [1.3, 0],
  [1.46, 0.8, 'out'],
  [1.76, 0, 'in'],
  [3.25, 0],
  [3.33, -0.35, 'out'],
  [3.6, 0.15],
  [3.85, 0.6, 'out'],
  [4.5, -21, 'fall'],
]);

/** Abertura da aba da frente, em graus. Passa do ponto e volta. */
const flap = track([
  [0, 0],
  [1.62, 0],
  [1.76, 22, 'in'],
  [2.0, 74, 'out'],
  [2.15, 61],
  [2.32, 65],
  [3.85, 63],
  [4.5, 45],
]);

/**
 * Aproximação da câmera: ×1,0 parada, ×1,7 no auge. A referência cresce ×1,9 na
 * largura, mas parte disso é a própria carteira abrindo; aqui a aba abre para a
 * câmera e já ganha tamanho pela perspectiva.
 */
const zoom = track([
  [0, 1],
  [1.62, 1],
  [2.0, 1.36],
  [2.9, 1.7, 'out'],
  [3.7, 1.62],
]);

/** Onde o centro da carteira fica no quadro, em fração da altura (positivo = abaixo do meio). */
const frameY = track([
  [0, 0.05],
  [1.62, 0.05],
  [2.0, 0.04],
  [2.9, 0.02, 'out'],
  [3.7, 0.03],
]);

/** Subida dos cartões (0 = guardados, 1 = em leque), um pouco defasada entre eles. */
const cardRise = [0, 0.06, 0.12].map((lag) =>
  track([
    [0, 0],
    [1.78 + lag, 0],
    [2.2 + lag, 1, 'back'],
  ]),
);

/** Moedas que escapam: saem de dentro da carteira e somem por cima do quadro. */
const ESCAPES = [
  { at: 1.95, dx: 4.5, dz: 2.0, turns: 2.0, tilt: 0.5 },
  { at: 2.2, dx: -3.5, dz: 3.0, turns: 2.5, tilt: -0.4 },
  { at: 2.45, dx: 6.5, dz: 1.0, turns: 1.75, tilt: 0.35 },
  { at: 2.7, dx: -1.5, dz: 4.0, turns: 2.25, tilt: -0.3 },
  { at: 2.95, dx: 3.0, dz: 2.5, turns: 2.0, tilt: 0.45 },
] as const;
const ESCAPE_FLIGHT = 0.9;
/** Ponto de saída das moedas, dentro da carteira (espaço da carteira). */
export const COIN_SOURCE = [0.4, 1.5, 1.4] as const;

/** A moeda que fica: salta às 3,25 s, para no alto às 3,55 s e chega à tela às 4,5 s. */
export const HERO_LAUNCH = 3.25;
const HERO_APEX = 3.55;
const HERO_TURNS = 2;

export interface CoinPose {
  visible: boolean;
  x: number;
  y: number;
  z: number;
  /** Giro no próprio eixo (cara ↔ coroa), em rad. */
  spin: number;
  /** Inclinação lateral, em rad. */
  tilt: number;
}

export interface HeroCoinPose {
  visible: boolean;
  /** Subida da carteira até o alto (0..1, já com curva). */
  rise: number;
  /** Do alto até a tela (0..1, com curva; passa um pouco de 1 e volta). */
  approach: number;
  spin: number;
  /** Segundos desde que a moeda chegou; negativo antes disso. */
  floating: number;
}

export interface Pose {
  yaw: number;
  pitch: number;
  lift: number;
  flap: number;
  zoom: number;
  frameY: number;
  /** A carteira ainda está em cena. */
  wallet: boolean;
  cards: number[];
  coins: CoinPose[];
  hero: HeroCoinPose;
}

const hidden: CoinPose = { visible: false, x: 0, y: 0, z: 0, spin: 0, tilt: 0 };

export function pose(time: number): Pose {
  const t = Math.max(0, time);
  const heroSpinP = clamp01((t - HERO_LAUNCH) / (END - HERO_LAUNCH));
  return {
    yaw: yaw(t) * deg,
    pitch: pitch(t) * deg,
    lift: lift(t),
    flap: flap(t) * deg,
    zoom: zoom(t),
    frameY: frameY(t),
    wallet: t < 4.5,
    cards: cardRise.map((rise) => rise(t)),
    coins: ESCAPES.map((coin) => {
      const p = (t - coin.at) / ESCAPE_FLIGHT;
      if (p < 0 || p > 1) return hidden;
      return {
        visible: true,
        x: COIN_SOURCE[0] + coin.dx * p,
        // Saem rápido e ainda estão subindo quando deixam o quadro.
        y: COIN_SOURCE[1] + 22 * p - 4 * p * p,
        z: COIN_SOURCE[2] + coin.dz * p,
        spin: coin.turns * 2 * Math.PI * p,
        tilt: coin.tilt * p,
      };
    }),
    hero: {
      visible: t >= HERO_LAUNCH,
      rise: EASE.out(clamp01((t - HERO_LAUNCH) / (HERO_APEX - HERO_LAUNCH))),
      approach: EASE.back(clamp01((t - HERO_APEX) / (END - HERO_APEX))),
      // Voltas inteiras: chega de cara para a tela, com o Z em pé.
      spin: HERO_TURNS * 2 * Math.PI * EASE.out(heroSpinP),
      floating: t - END,
    },
  };
}

/** Os momentos que valem um still: o que se aprova antes de animar. */
export const MOMENTS = [
  { t: 0.9, label: 'repouso' },
  { t: 1.95, label: 'abre' },
  { t: 2.55, label: 'moedas escapam' },
  { t: 4.02, label: 'carteira sai' },
  { t: 6.4, label: 'moeda flutua' },
] as const;

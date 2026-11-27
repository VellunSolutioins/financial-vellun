import { MESSAGES, POP, easeOut, span, type Message } from './timeline';

/**
 * Tela do celular desenhada em canvas 2D (vira textura no three.js): conversa
 * com o Zeloo, balões que entram conforme o scroll, "digitando…", áudio e o
 * comprovante. Interface genérica de chat, com as cores do Zeloo.
 */

export const SCREEN_W = 760;
export const SCREEN_H = 1580;

const HEADER_H = 190;
const INPUT_H = 130;
const SIDE = 34;
const GAP = 18;
// Letra grande para a escala do celular na página: ~13–15 px na tela.
const FONT_SIZE = 40;
const LINE_H = 53;
const PAD_X = 30;
const PAD_Y = 24;
const MAX_W = SCREEN_W * 0.8;

const COLORS = {
  bg: '#eef2f8',
  header: '#ffffff',
  user: '#2563eb',
  userText: '#ffffff',
  zeloo: '#ffffff',
  zelooText: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Comprovante totalmente fictício (sem banco nem marca reais). */
export function drawReceipt(g: CanvasRenderingContext2D, w: number, h: number, font: string) {
  g.save();
  g.fillStyle = '#ffffff';
  // Papel com a borda de baixo serrilhada.
  g.beginPath();
  g.moveTo(0, 18);
  g.quadraticCurveTo(0, 0, 18, 0);
  g.lineTo(w - 18, 0);
  g.quadraticCurveTo(w, 0, w, 18);
  const teeth = 14;
  g.lineTo(w, h - 14);
  for (let i = 0; i < teeth; i++) {
    const x0 = w - (i * w) / teeth;
    g.lineTo(x0 - w / teeth / 2, h);
    g.lineTo(x0 - w / teeth, h - 14);
  }
  g.closePath();
  g.fill();
  const u = w / 600;
  const text = (
    t: string,
    x: number,
    y: number,
    size: number,
    weight = 500,
    color = '#0f172a',
    align: CanvasTextAlign = 'left',
  ) => {
    g.fillStyle = color;
    g.font = `${weight} ${size * u}px ${font}`;
    g.textAlign = align;
    g.fillText(t, x * u, y * u);
  };
  text('Comprovante de compra', 300, 78, 34, 700, '#0f172a', 'center');
  text('cartão de crédito · final 4821', 300, 118, 22, 500, '#64748b', 'center');
  g.fillStyle = '#e2e8f0';
  g.fillRect(40 * u, 150 * u, 520 * u, 2 * u);
  const rows: [string, string][] = [
    ['Estabelecimento', 'Sabor da Vila Ltda.'],
    ['Data', '27/11/2026 · 20:14'],
    ['Forma', 'Crédito à vista'],
    ['Autorização', '738214'],
  ];
  rows.forEach(([k, v], i) => {
    text(k, 40, 205 + i * 52, 23, 500, '#64748b');
    text(v, 560, 205 + i * 52, 23, 600, '#0f172a', 'right');
  });
  g.fillStyle = '#e2e8f0';
  g.fillRect(40 * u, 420 * u, 520 * u, 2 * u);
  text('Valor', 40, 490, 26, 500, '#64748b');
  text('R$ 83,90', 560, 495, 46, 700, '#0f172a', 'right');
  g.fillStyle = '#ecfdf5';
  g.beginPath();
  g.roundRect(40 * u, 540 * u, 520 * u, 64 * u, 16 * u);
  g.fill();
  text('✓ Pagamento aprovado', 300, 582, 24, 600, '#047857', 'center');
  text('documento ilustrativo · sem valor fiscal', 300, 668, 18, 500, '#94a3b8', 'center');
  g.restore();
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number) {
  const lines: string[] = [];
  text.split('\n').forEach((para) => {
    let line = '';
    para.split(' ').forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > max && line) {
        lines.push(line);
        line = word;
      } else line = test;
    });
    lines.push(line);
  });
  return lines;
}

interface Laid {
  msg: Message | null; // null = "digitando…"
  w: number;
  h: number;
  lines?: string[];
}

export interface ChatCanvas {
  canvas: HTMLCanvasElement;
  /** Desenha o estado em `p`; devolve onde está o balão do comprovante (px). */
  draw(p: number, time: number, hideReceipt: boolean): Rect | null;
}

export function createChatCanvas(zPath: string, fontFamily: string): ChatCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const g = canvas.getContext('2d')!;
  const font = `${fontFamily}, ui-sans-serif, system-ui, sans-serif`;
  const z = new Path2D(zPath);

  const receipt = document.createElement('canvas');
  receipt.width = 600;
  receipt.height = 720;
  drawReceipt(receipt.getContext('2d')!, 600, 720, font);

  // Medidas dos balões: calculadas uma vez (o texto não muda).
  g.font = `500 ${FONT_SIZE}px ${font}`;
  const laid: Laid[] = MESSAGES.map((msg) => {
    if (msg.kind === 'audio') return { msg, w: MAX_W * 0.86, h: 112 };
    if (msg.kind === 'image') return { msg, w: 330, h: 330 * 1.2 + 64 };
    const lines = wrap(g, msg.text ?? '', MAX_W - PAD_X * 2);
    const textW = Math.max(...lines.map((l) => g.measureText(l).width));
    return {
      msg,
      lines,
      w: Math.min(MAX_W, Math.max(textW + PAD_X * 2, 170)),
      h: lines.length * LINE_H + PAD_Y * 2 + 32,
    };
  });
  const typingBox = { msg: null, w: 126, h: 76 };

  function avatar(x: number, y: number, r: number) {
    g.fillStyle = COLORS.user;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.save();
    // O path do logo está num quadro de 512 × 477 (viewBox do SVG).
    const s = (r * 1.15) / 512;
    g.translate(x - 256 * s, y - 238 * s);
    g.scale(s, s);
    g.fillStyle = '#ffffff';
    g.fill(z);
    g.restore();
  }

  function header() {
    g.fillStyle = COLORS.header;
    g.fillRect(0, 0, SCREEN_W, HEADER_H);
    g.fillStyle = COLORS.line;
    g.fillRect(0, HEADER_H - 2, SCREEN_W, 2);
    g.fillStyle = '#0f172a';
    g.font = `600 26px ${font}`;
    g.textAlign = 'left';
    g.fillText('9:41', 52, 52);
    // Ilha da câmera.
    g.fillStyle = '#020617';
    g.beginPath();
    g.roundRect(SCREEN_W / 2 - 92, 20, 184, 50, 25);
    g.fill();
    g.fillStyle = '#0f172a';
    g.font = `600 30px ${font}`;
    g.fillText('‹', 30, 140);
    avatar(102, 130, 34);
    g.font = `700 32px ${font}`;
    g.fillText('Zeloo', 152, 124);
    g.fillStyle = '#10b981';
    g.font = `500 22px ${font}`;
    g.fillText('online', 152, 156);
  }

  function input() {
    const y = SCREEN_H - INPUT_H;
    g.fillStyle = COLORS.header;
    g.fillRect(0, y, SCREEN_W, INPUT_H);
    g.fillStyle = '#f1f5f9';
    g.beginPath();
    g.roundRect(28, y + 24, SCREEN_W - 150, 64, 32);
    g.fill();
    g.fillStyle = '#94a3b8';
    g.font = `500 26px ${font}`;
    g.textAlign = 'left';
    g.fillText('Mensagem', 58, y + 66);
    g.fillStyle = COLORS.user;
    g.beginPath();
    g.arc(SCREEN_W - 72, y + 56, 34, 0, Math.PI * 2);
    g.fill();
    // Microfone.
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.roundRect(SCREEN_W - 80, y + 36, 16, 28, 8);
    g.fill();
    g.fillRect(SCREEN_W - 74, y + 68, 4, 10);
  }

  function bubble(item: Laid, x: number, y: number, a: number, time: number, hideReceipt: boolean) {
    const user = item.msg?.from === 'user';
    g.save();
    g.globalAlpha = a;
    g.translate(0, (1 - a) * 22);
    g.fillStyle = user ? COLORS.user : COLORS.zeloo;
    g.shadowColor = 'rgba(15,23,42,0.08)';
    g.shadowBlur = 12;
    g.shadowOffsetY = 3;
    g.beginPath();
    g.roundRect(x, y, item.w, item.h, [28, 28, user ? 8 : 28, user ? 28 : 8]);
    g.fill();
    g.shadowColor = 'transparent';
    const ink = user ? COLORS.userText : COLORS.zelooText;
    const sub = user ? 'rgba(255,255,255,0.75)' : COLORS.muted;
    g.textAlign = 'left';

    if (!item.msg) {
      // "digitando…": três pontos que sobem em onda.
      for (let i = 0; i < 3; i++) {
        const k = Math.sin(time * 8 - i * 0.9);
        g.fillStyle = `rgba(100,116,139,${0.45 + 0.35 * Math.max(0, k)})`;
        g.beginPath();
        g.arc(x + 36 + i * 27, y + item.h / 2 - Math.max(0, k) * 6, 8, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      return null;
    }

    let receiptRect: Rect | null = null;
    if (item.msg.kind === 'text') {
      g.fillStyle = ink;
      g.font = `500 ${FONT_SIZE}px ${font}`;
      item.lines!.forEach((l, i) => g.fillText(l, x + PAD_X, y + PAD_Y + 32 + i * LINE_H));
    } else if (item.msg.kind === 'audio') {
      // Play, onda e duração.
      g.fillStyle = ink;
      g.beginPath();
      g.moveTo(x + 34, y + 34);
      g.lineTo(x + 34, y + 78);
      g.lineTo(x + 70, y + 56);
      g.closePath();
      g.fill();
      const bars = 26;
      for (let i = 0; i < bars; i++) {
        const h = 10 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)) * 40;
        g.fillStyle = i < 9 ? ink : sub;
        g.beginPath();
        g.roundRect(x + 96 + i * 13, y + 56 - h / 2, 6, h, 3);
        g.fill();
      }
      g.fillStyle = sub;
      g.font = `500 22px ${font}`;
      g.fillText(item.msg.duration ?? '', x + 96, y + 102);
    } else {
      const iw = item.w - 16;
      const ih = iw * 1.2;
      receiptRect = { x: x + 8, y: y + 8 + (1 - a) * 22, w: iw, h: ih };
      if (!hideReceipt) {
        g.fillStyle = '#dbeafe';
        g.beginPath();
        g.roundRect(x + 8, y + 8, iw, ih, 20);
        g.fill();
        g.drawImage(receipt, x + 8 + iw * 0.08, y + 8 + ih * 0.04, iw * 0.84, ih * 0.92);
      }
    }
    // Hora (e os dois "vistos" nas mensagens do usuário).
    g.fillStyle = sub;
    g.font = `500 23px ${font}`;
    g.textAlign = 'right';
    g.fillText(item.msg.time + (user ? '  ✓✓' : ''), x + item.w - 20, y + item.h - 16);
    g.restore();
    return receiptRect;
  }

  function draw(p: number, time: number, hideReceipt: boolean) {
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, SCREEN_W, SCREEN_H);

    // Itens visíveis, com o peso de entrada (empurra os de cima com suavidade).
    const items: { item: Laid; a: number }[] = [];
    MESSAGES.forEach((msg, i) => {
      if (msg.typing !== undefined) {
        const t = span(p, msg.typing, msg.typing + POP) * (1 - span(p, msg.at, msg.at + POP * 0.5));
        if (t > 0) items.push({ item: typingBox, a: easeOut(t) });
      }
      const a = easeOut(span(p, msg.at, msg.at + POP));
      if (a > 0) items.push({ item: laid[i], a });
    });

    let y = SCREEN_H - INPUT_H - 30;
    let receiptRect: Rect | null = null;
    let top = y;
    for (let k = items.length - 1; k >= 0; k--) {
      const { item, a } = items[k];
      y -= item.h * a + GAP * a;
      top = y;
      if (y + item.h < HEADER_H - 40) break;
      const user = item.msg?.from === 'user';
      const x = user ? SCREEN_W - SIDE - item.w : SIDE;
      const r = bubble(item, x, y, a, time, hideReceipt);
      if (r) receiptRect = r;
    }
    // Data da conversa: acima da primeira mensagem, e rola junto com ela.
    const chipY = Math.min(HEADER_H + 24, top - 70);
    if (chipY > HEADER_H - 50) {
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.roundRect(SCREEN_W / 2 - 60, chipY, 120, 44, 22);
      g.fill();
      g.fillStyle = COLORS.muted;
      g.font = `600 22px ${font}`;
      g.textAlign = 'center';
      g.fillText('hoje', SCREEN_W / 2, chipY + 30);
    }
    header();
    input();
    return receiptRect;
  }

  return { canvas, draw };
}

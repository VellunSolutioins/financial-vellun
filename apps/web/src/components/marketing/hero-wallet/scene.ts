import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { COIN_SOURCE, EASE, END, HERO_LAUNCH, pose, type Pose } from './timeline';

/**
 * Cena da carteira: tudo construído em código (geometria, texturas em canvas,
 * luz de estúdio procedural). Unidades em cm, com a carteira em pé, de frente
 * para a câmera, e a dobra embaixo.
 */

/** Carteira bifold fechada: 11 × 8,6 cm, duas metades de 4,2 mm. */
const W = 11;
const H = 8.6;
const T = 0.42;
/** Folga entre as metades, onde ficam os cartões. */
const GAP = 0.4;
const BACK_Z = -T / 2 - 0.05;
const FRONT_Z = 0.35 + T / 2;
const HINGE = new THREE.Vector3(0, -H / 2, 0.15);
/** Canto das placas de couro: arredondado de verdade, não só a quina. */
const CORNER = 1.3;

const CARD_W = 8.56;
const CARD_H = 5.4;
export const COIN_R = 1;
const COIN_T = 0.24;

/** Largura da moeda que fica, em fração da largura do quadro. */
const COIN_SCREEN = 0.54;
/** Quanto a moeda que fica sobe acima do meio do quadro, em fração da altura. */
const COIN_RAISE = 0.03;

/** Inclinação fixa da carteira, para dentro da página (rad). */
const INWARD_YAW = -0.32;
const INWARD_ROLL = 0.05;

const FOV = 24;
const ELEVATION = 9 * (Math.PI / 180);
/** Largura da carteira parada, em fração da largura do quadro (referência: 52%). */
const REST_WIDTH = 0.43;

export interface Palette {
  leather: string;
  leatherInner: string;
  thread: string;
  coin: string;
  coinRelief: string;
}

const PALETTE: Palette = {
  leather: '#141c2b',
  leatherInner: '#1d283c',
  thread: '#10b981',
  coin: '#2563eb',
  coinRelief: '#f8fafc',
};

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

/** Granulado de couro: pontos claros e escuros, usado como relevo e aspereza. */
function grainTexture() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 9000; i++) {
    const v = 90 + Math.floor(rand() * 90);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath();
    g.arc(rand() * 512, rand() * 512, 1 + rand() * 2.6, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // As placas usam UV em cm (Extrude): um ladrilho a cada ~2,2 cm.
  tex.repeat.set(0.45, 0.45);
  return tex;
}

function leather(color: string, grain: THREE.Texture) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.68,
    roughnessMap: grain,
    bumpMap: grain,
    bumpScale: 1.2,
    sheen: 0.15,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color('#5b6b86'),
    clearcoat: 0.12,
    clearcoatRoughness: 0.5,
  });
}

/**
 * Costura: pontos pequenos ao longo de um retângulo arredondado, em um
 * plano z. Devolve as matrizes para um InstancedMesh.
 */
function stitchPath(w: number, h: number, radius: number, z: number, step = 0.3) {
  const shape = new THREE.Shape();
  const x0 = -w / 2;
  const y0 = -h / 2;
  shape.moveTo(x0 + radius, y0);
  shape.lineTo(x0 + w - radius, y0);
  shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + radius);
  shape.lineTo(x0 + w, y0 + h - radius);
  shape.quadraticCurveTo(x0 + w, y0 + h, x0 + w - radius, y0 + h);
  shape.lineTo(x0 + radius, y0 + h);
  shape.quadraticCurveTo(x0, y0 + h, x0, y0 + h - radius);
  shape.lineTo(x0, y0 + radius);
  shape.quadraticCurveTo(x0, y0, x0 + radius, y0);
  const count = Math.floor(shape.getLength() / step);
  const pts = shape.getSpacedPoints(count);
  const out: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    out.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle),
        new THREE.Vector3(1, 1, 1),
      ),
    );
  }
  return out;
}

/** Linha reta de costura (topo dos bolsos). */
function stitchLine(x0: number, x1: number, y: number, z: number, step = 0.3) {
  const out: THREE.Matrix4[] = [];
  for (let x = x0; x < x1; x += step) {
    out.push(new THREE.Matrix4().makeTranslation(x + step / 2, y, z));
  }
  return out;
}

function stitches(matrices: THREE.Matrix4[], material: THREE.Material) {
  const geo = new THREE.BoxGeometry(0.17, 0.045, 0.03);
  const mesh = new THREE.InstancedMesh(geo, material, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  return mesh;
}

/**
 * Placa de couro: retângulo de cantos bem arredondados, com borda chanfrada
 * macia (o couro dobra na borda, não termina em quina). Centrada na origem,
 * com espessura `t` em z.
 */
function leatherPanel(w: number, h: number, t: number, r: number) {
  const b = Math.min(0.14, t * 0.35);
  const bt = Math.min(0.16, t * 0.4);
  const core = Math.max(0.001, t - 2 * bt);
  const geo = new THREE.ExtrudeGeometry(roundedRect(w - 2 * b, h - 2 * b, Math.max(0.01, r - b)), {
    depth: core,
    bevelEnabled: true,
    bevelThickness: bt,
    bevelSize: b,
    bevelSegments: 5,
    curveSegments: 24,
  });
  geo.translate(0, 0, -core / 2);
  return geo;
}

/** Retângulo arredondado como Shape, centrado na origem. */
function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

interface CardStyle {
  from: string;
  to: string;
  ink: string;
  digits: string;
}

/** De trás para a frente: prata (o mais alto), grafite e verde (o da frente). */
const CARDS: CardStyle[] = [
  { from: '#94a3b8', to: '#e2e8f0', ink: 'rgba(15,23,42,0.6)', digits: '1564' },
  { from: '#0b1220', to: '#334155', ink: 'rgba(226,232,240,0.75)', digits: '4821' },
  { from: '#047857', to: '#10b981', ink: 'rgba(236,253,245,0.85)', digits: '0937' },
];

/** Sombra macia: elipse escura que some nas bordas. */
function shadowTexture() {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(15,23,42,0.9)');
  grad.addColorStop(0.5, 'rgba(15,23,42,0.35)');
  grad.addColorStop(1, 'rgba(15,23,42,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Frente de cartão sem marca: degradê, chip, aproximação e final do número. */
function cardTexture(style: CardStyle) {
  const [c, g] = canvas(856, 540);
  const grad = g.createLinearGradient(0, 0, 856, 540);
  grad.addColorStop(0, style.from);
  grad.addColorStop(1, style.to);
  g.fillStyle = grad;
  g.fillRect(0, 0, 856, 540);
  // Ondas finas, discretas.
  g.strokeStyle = style.ink.replace(/[\d.]+\)$/, '0.08)');
  g.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    for (let x = 0; x <= 856; x += 8) {
      const y = 330 + i * 26 + Math.sin(x / 120 + i * 0.6) * 22;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // Chip.
  const chip = g.createLinearGradient(80, 190, 190, 270);
  chip.addColorStop(0, '#e8d9a8');
  chip.addColorStop(1, '#b89a52');
  g.fillStyle = chip;
  g.beginPath();
  g.roundRect(80, 190, 110, 84, 14);
  g.fill();
  g.strokeStyle = 'rgba(80,60,20,0.45)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(80, 232);
  g.lineTo(190, 232);
  g.moveTo(135, 190);
  g.lineTo(135, 274);
  g.stroke();
  // Aproximação.
  g.strokeStyle = style.ink;
  g.lineWidth = 5;
  g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(232, 232, 16 + i * 13, -0.7, 0.7);
    g.stroke();
  }
  g.fillStyle = style.ink;
  g.font = '500 38px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.fillText(`••••  ${style.digits}`, 80, 440);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function cardMesh(style: CardStyle) {
  const geo = new THREE.ExtrudeGeometry(roundedRect(CARD_W, CARD_H, 0.32), {
    depth: 0.05,
    bevelEnabled: false,
    curveSegments: 6,
  });
  geo.translate(0, 0, -0.025);
  // As tampas do Extrude usam x,y como UV: leva para 0..1.
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) / CARD_W + 0.5, uv.getY(i) / CARD_H + 0.5);
  }
  const face = new THREE.MeshPhysicalMaterial({
    map: cardTexture(style),
    roughness: 0.5,
    clearcoat: 0.2,
    clearcoatRoughness: 0.35,
    envMapIntensity: 0.45,
  });
  const edge = new THREE.MeshStandardMaterial({ color: style.from, roughness: 0.5 });
  return new THREE.Mesh(geo, [face, edge]);
}

/** "Z" do logo em relevo, a partir do SVG da marca, com largura `width`. */
export function zRelief(svg: string, width: number, depth: number) {
  const data = new SVGLoader().parse(svg);
  const shapes = data.paths.flatMap((p) => SVGLoader.createShapes(p));
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.3,
    // Chanfro pequeno (em unidades do SVG): maior que isso engorda o desenho do Z.
    bevelSize: 1.2,
    bevelSegments: 2,
    curveSegments: 10,
  });
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const center = box.getCenter(new THREE.Vector3());
  geo.translate(-center.x, -center.y, -box.min.z);
  const s = width / (box.max.x - box.min.x);
  // SVG cresce para baixo: o giro de 180° em X desvira o desenho sem espelhar.
  geo.scale(s, s, 1);
  geo.rotateX(Math.PI);
  return geo;
}

/**
 * Moeda: disco com aro saliente (torno) e o Z em relevo nas duas faces. O eixo
 * da moeda é o Z local, para a face olhar a câmera sem giro.
 */
export function coinMesh(zGeo: THREE.BufferGeometry, body: THREE.Material, relief: THREE.Material) {
  const t = COIN_T / 2;
  const profile = [
    [0, t - 0.03],
    [COIN_R * 0.8, t - 0.03],
    [COIN_R * 0.84, t],
    [COIN_R * 0.96, t],
    [COIN_R, t - 0.04],
    [COIN_R, -t + 0.04],
    [COIN_R * 0.96, -t],
    [COIN_R * 0.84, -t],
    [COIN_R * 0.8, -t + 0.03],
    [0, -t + 0.03],
  ]
    // O torno precisa do perfil de baixo para cima; ao contrário, as faces
    // ficam viradas para dentro e a moeda parece oca (via-se o Z do verso).
    .reverse()
    .map(([x, y]) => new THREE.Vector2(x, y));
  const lathe = new THREE.LatheGeometry(profile, 72);
  lathe.rotateX(Math.PI / 2);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(lathe, body));
  // O relevo sai de dentro do campo e sobe ~0,05.
  const front = new THREE.Mesh(zGeo, relief);
  front.position.z = t - 0.06;
  front.scale.z = -1;
  front.rotation.y = 0;
  const back = new THREE.Mesh(zGeo, relief);
  back.position.z = -t + 0.06;
  back.rotation.y = Math.PI;
  back.scale.z = -1;
  group.add(front, back);
  return group;
}

export interface Pointer {
  /** -1 (esquerda) a 1 (direita). */
  x: number;
  /** -1 (embaixo) a 1 (em cima). */
  y: number;
}

export interface Stage {
  render(time: number, pointer?: Pointer): void;
  /** `fill`: fração do canvas que a cena ocupa (1 = o quadro todo). */
  resize(width: number, height: number, fill?: number): void;
  dispose(): void;
}

/** `svg`: o texto de `/marca/zeloo-simbolo.svg`, de onde sai o Z das moedas. */
export function createStage(canvasEl: HTMLCanvasElement, svg: string): Stage {
  const renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.85;

  const key = new THREE.DirectionalLight('#ffffff', 1.5);
  key.position.set(-6, 10, 12);
  const rim = new THREE.DirectionalLight('#bfe9ff', 1.6);
  rim.position.set(9, 6, -8);
  scene.add(key, rim, new THREE.AmbientLight('#ffffff', 0.25));

  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 400);
  let baseDistance = 60;

  const grain = grainTexture();
  const outer = leather(PALETTE.leather, grain);
  const inner = leather(PALETTE.leatherInner, grain);
  const thread = new THREE.MeshStandardMaterial({ color: PALETTE.thread, roughness: 0.7 });

  // Raiz: giro, inclinação e pulo. O centro da carteira fechada é a origem.
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  scene.add(root);

  // Metade de trás, com o bolso dos cartões na face de dentro.
  const back = new THREE.Group();
  const backShell = new THREE.Mesh(leatherPanel(W, H, T, CORNER), outer);
  backShell.position.z = BACK_Z;
  const pocketH = 4.95;
  const pocket = new THREE.Mesh(leatherPanel(W - 0.5, pocketH, 0.08, 0.6), inner);
  const pocketY = -H / 2 + 0.25 + pocketH / 2;
  pocket.position.set(0, pocketY, 0.3);
  back.add(
    backShell,
    pocket,
    stitches(stitchPath(W - 0.7, H - 0.7, CORNER - 0.35, BACK_Z - T / 2 - 0.005), thread),
    stitches(stitchLine(-W / 2 + 0.6, W / 2 - 0.6, pocketY + pocketH / 2 - 0.25, 0.345), thread),
  );
  // Lombada: arredonda a dobra; as pontas são esféricas para casar com os cantos.
  const spine = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, W - 2 * CORNER, 12, 32), outer);
  spine.rotation.z = Math.PI / 2;
  spine.position.copy(HINGE);
  back.add(spine);
  root.add(back);

  // Cartões, entre o fundo e o bolso.
  const cards = CARDS.map((style, i) => {
    const mesh = cardMesh(style);
    mesh.position.z = 0.03 + i * 0.08;
    back.add(mesh);
    return mesh;
  });
  const CARD_REST_Y = -H / 2 + 0.45 + CARD_H / 2;
  const CARD_FAN = [
    { x: -0.8, rise: 4.7, rot: 7 },
    { x: 0.3, rise: 4.0, rot: -3 },
    { x: 1.1, rise: 3.2, rot: -10 },
  ];

  // Aba da frente: gira na dobra. O grupo fica no eixo da dobra.
  const flap = new THREE.Group();
  flap.position.copy(HINGE);
  const flapShell = new THREE.Mesh(leatherPanel(W, H, T, CORNER), outer);
  flapShell.position.set(0, H / 2, FRONT_Z - HINGE.z);
  flap.add(
    flapShell,
    stitches(stitchPath(W - 0.7, H - 0.7, CORNER - 0.35, 0), thread)
      .translateY(H / 2)
      .translateZ(FRONT_Z - HINGE.z + T / 2 + 0.005),
  );
  root.add(flap);

  // Moedas.
  const zGeo = zRelief(svg, COIN_R * 1.0, 0.05);
  // Moeda nas cores do ícone da marca: disco azul #2563EB e Z branco em relevo.
  const coinBody = new THREE.MeshPhysicalMaterial({
    // Base um tom abaixo e um pouco de emissão: só com luz, o estúdio lava o
    // azul para lilás; assim a face de frente fica no #2563EB do logo.
    color: '#1e40af',
    emissive: PALETTE.coin,
    emissiveIntensity: 0.35,
    metalness: 0.1,
    roughness: 0.4,
    clearcoat: 0.35,
    clearcoatRoughness: 0.3,
    envMapIntensity: 0.25,
  });
  const coinRelief = new THREE.MeshPhysicalMaterial({
    color: PALETTE.coinRelief,
    metalness: 0.05,
    roughness: 0.35,
    clearcoat: 0.6,
    clearcoatRoughness: 0.2,
  });
  const coins = Array.from({ length: 5 }, () => {
    const c = coinMesh(zGeo, coinBody, coinRelief);
    root.add(c);
    return c;
  });

  // A moeda que fica: vive no espaço da cena, não no da carteira, porque a
  // carteira sai e ela continua.
  const heroCoin = coinMesh(zGeo, coinBody, coinRelief);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0,
    }),
  );
  scene.add(heroCoin, shadow);

  const halfTan = Math.tan((FOV / 2) * (Math.PI / 180));
  const target = new THREE.Vector3();
  const v = new THREE.Vector3();
  // Pontos do voo da moeda, recalculados no resize (dependem do quadro).
  const launch = new THREE.Vector3();
  const apex = new THREE.Vector3();
  const rest = new THREE.Vector3();
  const restCam = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  let restVisibleH = 1;

  /** Câmera: aproxima pelo zoom e enquadra o centro da carteira em frameY. */
  function placeCamera(p: Pose) {
    const d = baseDistance / p.zoom;
    target.set(0, p.frameY * 2 * d * halfTan, 0);
    camera.position.set(0, target.y + Math.sin(ELEVATION) * d, Math.cos(ELEVATION) * d);
    camera.lookAt(target);
  }

  function placeWallet(obj: THREE.Object3D, p: Pose) {
    // Leve 3/4 o tempo todo, virada para dentro da página (a carteira fica à
    // direita do texto): sem isso ela surge reta, "chapada".
    obj.rotation.set(p.pitch, p.yaw + INWARD_YAW, INWARD_ROLL);
    obj.position.y = p.lift;
  }

  /** Onde a moeda sai da carteira, para no alto e termina, flutuando. */
  function planFlight() {
    const ghost = new THREE.Object3D();
    ghost.rotation.order = 'YXZ';
    placeWallet(ghost, pose(HERO_LAUNCH));
    ghost.updateMatrixWorld(true);
    launch.set(...COIN_SOURCE).applyMatrix4(ghost.matrixWorld);
    apex.copy(launch).add(v.set(0.8, 5.5, 2.5));

    placeCamera(pose(END));
    camera.updateMatrixWorld(true);
    restCam.copy(camera.position);
    camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    // Distância em que a moeda ocupa COIN_SCREEN da largura do quadro.
    const dist = (2 * COIN_R) / (COIN_SCREEN * fill * 2 * halfTan * camera.aspect);
    restVisibleH = 2 * dist * halfTan;
    const forward = v.subVectors(target, camera.position).normalize();
    rest
      .copy(camera.position)
      .addScaledVector(forward, dist)
      .addScaledVector(camUp, COIN_RAISE * restVisibleH);
  }

  function render(time: number, pointer: Pointer = { x: 0, y: 0 }) {
    const p = pose(time);
    root.visible = p.wallet;
    placeWallet(root, p);
    flap.rotation.x = p.flap;

    cards.forEach((card, i) => {
      const f = CARD_FAN[i];
      const r = p.cards[i];
      card.position.x = f.x * r;
      card.position.y = CARD_REST_Y + f.rise * r;
      card.rotation.z = f.rot * (Math.PI / 180) * r;
    });

    coins.forEach((coin, i) => {
      const c = p.coins[i];
      coin.visible = c.visible;
      if (!c.visible) return;
      coin.position.set(c.x, c.y, c.z);
      coin.rotation.set(c.spin, 0, c.tilt);
    });

    const h = p.hero;
    heroCoin.visible = h.visible;
    if (h.visible) {
      if (h.approach === 0) heroCoin.position.lerpVectors(launch, apex, h.rise);
      else heroCoin.position.lerpVectors(apex, rest, h.approach);

      // Flutuando: sobe e desce, balança e segue o ponteiro (parallax).
      const settled = EASE.io(Math.min(1, Math.max(0, h.floating / 0.9)));
      const f = Math.max(0, h.floating);
      const bob = Math.sin((2 * Math.PI * f) / 3.6) * 0.016 * restVisibleH * settled;
      heroCoin.position
        .addScaledVector(camUp, bob + pointer.y * 0.03 * restVisibleH * settled)
        .addScaledVector(camRight, pointer.x * 0.03 * restVisibleH * settled);

      heroCoin.lookAt(restCam);
      heroCoin.rotateY((Math.sin((2 * Math.PI * f) / 5.2) * 0.16 + pointer.x * 0.45) * settled);
      heroCoin.rotateX((Math.sin((2 * Math.PI * f) / 4.1) * 0.07 - pointer.y * 0.32) * settled);
      heroCoin.rotateX(h.spin);
      heroCoin.rotateZ(0.35 * (1 - Math.min(1, h.approach)));

      // Sombra: aparece no fim, encolhe quando a moeda sobe e anda ao contrário do ponteiro.
      const shade = EASE.io(Math.min(1, Math.max(0, (time - (END - 0.4)) / 0.8)));
      shadow.visible = shade > 0;
      shadow.position
        .copy(rest)
        .addScaledVector(camUp, -COIN_R * 1.5)
        .addScaledVector(camRight, -pointer.x * 0.02 * restVisibleH);
      shadow.lookAt(restCam);
      const lift = bob / (0.016 * restVisibleH || 1);
      shadow.scale.set(COIN_R * 2.1 * (1 - 0.08 * lift), COIN_R * 0.38, 1);
      (shadow.material as THREE.MeshBasicMaterial).opacity = 0.32 * shade * (1 - 0.15 * lift);
    } else {
      shadow.visible = false;
    }

    placeCamera(p);
    renderer.render(scene, camera);
  }

  let fill = 1;
  function resize(width: number, height: number, frameFill = 1) {
    fill = frameFill;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Distância em que a carteira ocupa REST_WIDTH da largura do quadro.
    baseDistance = W / (REST_WIDTH * fill * 2 * halfTan * camera.aspect);
    planFlight();
  }

  function dispose() {
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m: THREE.Material & { map?: THREE.Texture | null }) => {
          m.map?.dispose();
          m.dispose();
        });
      }
    });
    grain.dispose();
    envTex.dispose();
    pmrem.dispose();
    renderer.dispose();
  }

  return { render, resize, dispose };
}

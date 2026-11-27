import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { coinMesh, zRelief } from '../hero-wallet/scene';
import { flowPose } from './timeline';

/**
 * Cena da seção Recursos: as moedas do Zeloo descem por canos de vidro, se
 * dividem num conector e caem nas caixas de cada categoria. Com o scroll, as
 * moedas se empilham sobre as caixas e as pilhas viram o gráfico do mês.
 * Tudo em código: geometria, rótulos em canvas e luz de estúdio procedural.
 *
 * Mundo em "cm": chão em y = 0 (só recebe sombra), câmera alta em 3/4, como
 * na referência, com lente longa (FOV 24) para quase não deformar.
 */

const C = {
  blue: '#2563eb',
  blueDeep: '#1d4ed8',
  blueSoft: '#60a5fa',
  emerald: '#10b981',
};

export const CATEGORIES = [
  // Pilhas proporcionais aos valores (1.850 : 1.120 : 289 ≈ 18 : 11 : 3).
  { label: 'moradia', value: 'R$ 1.850', coins: 18, x: -3.2 },
  { label: 'mercado', value: 'R$ 1.120', coins: 11, x: 0.3 },
  { label: 'assinaturas', value: 'R$ 289', coins: 3, x: 3.8 },
] as const;

const BOX = { w: 2.1, h: 1.7, d: 2.1, z: 1.6 };
const PIPE_R = 0.3;
const FLOW_SCALE = 0.24;
const STACK_SCALE = 0.55;
const COIN_THICK = 0.24 * STACK_SCALE;
const FLOWING = 12;

/** Câmeras de cada capítulo: posição, alvo. */
const SHOTS = {
  overview: { pos: new THREE.Vector3(15.5, 17, 20), tgt: new THREE.Vector3(-1.2, 1.4, -1.4) },
  follow: { pos: new THREE.Vector3(3.5, 8.5, 6.5), tgt: new THREE.Vector3(-2.3, 1.7, -1.9) },
  boxes: { pos: new THREE.Vector3(9.8, 9.2, 19.5), tgt: new THREE.Vector3(0.3, 1.3, 1.0) },
  chart: { pos: new THREE.Vector3(11, 10, 20.5), tgt: new THREE.Vector3(0.3, 2.6, 0.8) },
};

function labelTexture(text: string, { size = 96, color = '#ffffff', w = 512, h = 160 } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.font = `700 ${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Etiqueta de valor sobre a pilha: valor grande e categoria pequena. */
function valueSprite(value: string, label: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 220;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(15,23,42,0.88)';
  g.beginPath();
  g.roundRect(16, 20, 480, 180, 40);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = '700 84px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(value, 256, 118);
  g.fillStyle = 'rgba(203,213,225,0.95)';
  g.font = '500 44px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.fillText(label, 256, 172);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    // Sempre por cima das pilhas: o rótulo não pode ficar atrás de uma moeda.
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
  );
  sprite.renderOrder = 10;
  sprite.scale.set(2.2, 0.95, 1);
  return sprite;
}

export interface FlowStage {
  render(p: number, time: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export function createFlowStage(canvasEl: HTMLCanvasElement, svg: string): FlowStage {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  // VSM: sombra macia de verdade (o PCFSoft ignora o raio e deixa a borda dura).
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.9;

  // Luz quase a pino, um pouco atrás: a sombra cai inteira em volta de cada
  // caixa, à vista da câmera, em vez de sumir atrás dela e parecer "cortada"
  // quando o ângulo muda.
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.position.set(-4, 18, 1.5);
  sun.target.position.set(0, 0, 0.5);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -11;
  sun.shadow.camera.right = 11;
  sun.shadow.camera.top = 11;
  sun.shadow.camera.bottom = -11;
  sun.shadow.camera.near = 2;
  sun.shadow.camera.far = 40;
  sun.shadow.radius = 12;
  sun.shadow.blurSamples = 16;
  sun.shadow.bias = -0.0004;
  scene.add(sun, new THREE.AmbientLight('#ffffff', 0.3));

  // Chão invisível que só recebe a sombra: funciona sobre o fundo claro e o escuro.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.ShadowMaterial({ opacity: 0.16 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const blue = new THREE.MeshStandardMaterial({ color: C.blue, roughness: 0.32, metalness: 0.05 });
  const blueDeep = new THREE.MeshStandardMaterial({ color: C.blueDeep, roughness: 0.3 });
  // Vidro: transparente com reflexo do estúdio (o "transmission" some sobre canvas transparente).
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#e0ecff',
    transparent: true,
    opacity: 0.28,
    roughness: 0.06,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.4,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const cast = <T extends THREE.Object3D>(o: T) => {
    o.traverse((m) => {
      if (m instanceof THREE.Mesh) m.castShadow = true;
    });
    return o;
  };

  // Rede de canos: entrada → conector → uma caixa por categoria.
  const inlet = new THREE.Vector3(-6.2, 4.6, -6.2);
  const hub = new THREE.Vector3(-2.6, 2.2, -2.6);
  const main = new THREE.CatmullRomCurve3([
    inlet,
    new THREE.Vector3(-5.2, 3.6, -5.0),
    new THREE.Vector3(-3.8, 2.6, -3.6),
    hub,
  ]);
  const branches = CATEGORIES.map(({ x }) => {
    const back = BOX.z - BOX.d / 2;
    return new THREE.CatmullRomCurve3([
      hub,
      new THREE.Vector3((hub.x + x) / 2, 2.0, -1.8),
      new THREE.Vector3(x, 1.3, -0.6),
      new THREE.Vector3(x, 0.95, back - 0.1),
      // Termina dentro da caixa: a moeda some atrás da parede.
      new THREE.Vector3(x, 0.95, BOX.z),
    ]);
  });
  const tube = (curve: THREE.Curve<THREE.Vector3>) =>
    new THREE.Mesh(new THREE.TubeGeometry(curve, 96, PIPE_R, 20, false), glass);
  scene.add(tube(main));
  branches.forEach((b) => scene.add(tube(b)));

  // Peças azuis: tampa da entrada, conector em cruz e luvas nas emendas.
  const cap = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.9, 32), blue));
  cap.position.copy(inlet);
  cap.lookAt(main.getPointAt(0.05));
  cap.rotateX(Math.PI / 2);
  scene.add(cap);
  const hubMesh = new THREE.Group();
  [0, 1, 2].forEach((axis) => {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.5, 28), blue);
    if (axis === 0) arm.rotation.z = Math.PI / 2;
    if (axis === 2) arm.rotation.x = Math.PI / 2;
    hubMesh.add(arm);
  });
  hubMesh.position.copy(hub);
  scene.add(cast(hubMesh));
  const collar = (curve: THREE.Curve<THREE.Vector3>, u: number) => {
    const m = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.45, 28), blueDeep));
    const pos = curve.getPointAt(u);
    m.position.copy(pos);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangentAt(u));
    scene.add(m);
  };
  collar(main, 0.5);
  branches.forEach((b) => collar(b, 0.55));

  // Caixas das categorias, com o nome em relevo na frente.
  const stacks: THREE.Group[] = [];
  const sprites: THREE.Sprite[] = [];
  CATEGORIES.forEach((cat) => {
    const box = cast(new THREE.Mesh(new RoundedBoxGeometry(BOX.w, BOX.h, BOX.d, 5, 0.3), blue));
    box.position.set(cat.x, BOX.h / 2, BOX.z);
    box.receiveShadow = true;
    scene.add(box);
    const tex = labelTexture(cat.label, { size: cat.label.length > 9 ? 76 : 96 });
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(BOX.w * 0.92, BOX.w * 0.29),
      new THREE.MeshStandardMaterial({
        map: tex,
        bumpMap: tex,
        bumpScale: 2,
        transparent: true,
        roughness: 0.4,
      }),
    );
    label.position.set(cat.x, BOX.h * 0.55, BOX.z + BOX.d / 2 + 0.005);
    scene.add(label);
    // Boca onde o cano entra, nas costas.
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(PIPE_R + 0.06, 0.07, 12, 32), blueDeep);
    mouth.position.set(cat.x, 0.95, BOX.z - BOX.d / 2);
    scene.add(mouth);

    const stack = new THREE.Group();
    stack.position.set(cat.x, BOX.h, BOX.z);
    scene.add(stack);
    stacks.push(stack);
    const sprite = valueSprite(cat.value, cat.label);
    sprite.position.set(cat.x, BOX.h + cat.coins * COIN_THICK + 0.9, BOX.z);
    sprite.material.opacity = 0;
    scene.add(sprite);
    sprites.push(sprite);
  });

  // Moedas: as que correm nos canos e as das pilhas.
  const zGeo = zRelief(svg, 1, 0.05);
  const coinBody = new THREE.MeshPhysicalMaterial({
    color: '#1e40af',
    emissive: C.blue,
    emissiveIntensity: 0.35,
    metalness: 0.1,
    roughness: 0.4,
    clearcoat: 0.35,
    envMapIntensity: 0.25,
  });
  const coinRelief = new THREE.MeshPhysicalMaterial({
    color: '#f8fafc',
    roughness: 0.35,
    clearcoat: 0.6,
  });
  const makeCoin = (scale: number) => {
    const c = cast(coinMesh(zGeo, coinBody, coinRelief));
    c.scale.setScalar(scale);
    return c;
  };

  const routes = branches.map((b) => {
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.add(main);
    path.add(b);
    return path;
  });
  const routeLen = routes.map((r) => r.getLength());
  const flowing = Array.from({ length: FLOWING }, (_, i) => {
    const coin = makeCoin(FLOW_SCALE);
    scene.add(coin);
    return { coin, route: i % routes.length, offset: i / FLOWING };
  });

  CATEGORIES.forEach((cat, i) => {
    for (let k = 0; k < cat.coins; k++) {
      const coin = makeCoin(STACK_SCALE);
      coin.rotation.x = -Math.PI / 2;
      coin.rotation.z = (k * 0.7) % (Math.PI * 2);
      coin.position.y = COIN_THICK / 2 + k * COIN_THICK;
      coin.visible = false;
      stacks[i].add(coin);
    }
  });

  const camera = new THREE.PerspectiveCamera(24, 16 / 9, 0.5, 200);
  // Em telas estreitas a câmera recua: a rede inteira precisa caber na largura.
  let reach = 1;
  const pos = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function placeCamera(shot: number) {
    if (shot <= 1) {
      // Curva de Bézier quadrática passando perto do cano: a câmera "segue a moeda".
      const t = shot;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      pos
        .copy(SHOTS.overview.pos)
        .multiplyScalar(a)
        .addScaledVector(SHOTS.follow.pos, b)
        .addScaledVector(SHOTS.boxes.pos, c);
      tgt
        .copy(SHOTS.overview.tgt)
        .multiplyScalar(a)
        .addScaledVector(SHOTS.follow.tgt, b)
        .addScaledVector(SHOTS.boxes.tgt, c);
    } else {
      const t = shot - 1;
      pos.lerpVectors(SHOTS.boxes.pos, SHOTS.chart.pos, t);
      tgt.lerpVectors(SHOTS.boxes.tgt, SHOTS.chart.tgt, t);
    }
    camera.position.copy(tgt).addScaledVector(pos.sub(tgt), reach);
    camera.lookAt(tgt);
  }

  function render(p: number, time: number) {
    const pose = flowPose(p);
    placeCamera(pose.shot);

    // Moedas nos canos: rolam (giro = distância ÷ raio) e somem dentro da caixa.
    flowing.forEach((f) => {
      const u = (time * 0.07 + f.offset) % 1;
      const route = routes[f.route];
      route.getPointAt(u, f.coin.position);
      route.getTangentAt(u, tangent);
      side.crossVectors(tangent, up).normalize();
      tmp.copy(f.coin.position).add(side);
      f.coin.lookAt(tmp);
      f.coin.rotateZ(-(u * routeLen[f.route]) / FLOW_SCALE);
      f.coin.position.y += FLOW_SCALE * 0.15;
    });

    // Pilhas: cada moeda nova cai de cima e assenta; o scroll para trás desfaz.
    stacks.forEach((stack, i) => {
      const n = CATEGORIES[i].coins * pose.stacks;
      stack.children.forEach((coin, k) => {
        const f = Math.min(1, Math.max(0, n - k));
        coin.visible = f > 0;
        coin.position.y = COIN_THICK / 2 + k * COIN_THICK + (1 - f * f) * 1.6;
      });
      sprites[i].material.opacity = pose.values;
      sprites[i].position.y =
        BOX.h + CATEGORIES[i].coins * COIN_THICK + 0.9 + (1 - pose.values) * 0.3;
    });

    renderer.render(scene, camera);
  }

  function resize(w: number, h: number) {
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    // Largas: a cena precisa caber no espaço livre à direita do texto; a conta
    // (largura livre × proporção da tela) foi calibrada em 1280×720.
    const textRight = Math.max(0, (w - 1200) / 2) + 32 + 480 + 32;
    const free = Math.max(0.3, (w - textRight) / w);
    // Mesmo corte do CSS (\`lg\`, 1024 px): texto à esquerda daqui para cima.
    const wide = w >= 1024;
    reach = wide ? Math.max(1, 1.06 / (free * aspect)) : Math.max(1, Math.pow(1.6 / aspect, 0.85));
    // Telas largas: a cena se centra no espaço que sobra à direita do texto
    // (container de 1200 px, 32 px de margem, coluna de 30rem e um respiro).
    // Estreitas: a cena desce, e o texto fica em cima.
    if (wide) camera.setViewOffset(w, h, -textRight / 2, 0, w, h);
    else camera.setViewOffset(w, h, 0, -h * 0.17, w, h);
    camera.updateProjectionMatrix();
  }

  function dispose() {
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m: THREE.Material & { map?: THREE.Texture | null }) => {
          m.map?.dispose();
          m.dispose();
        });
      }
    });
    env.dispose();
    renderer.dispose();
  }

  return { render, resize, dispose };
}

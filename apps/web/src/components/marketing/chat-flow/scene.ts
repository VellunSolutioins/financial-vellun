import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SCREEN_H, SCREEN_W, createChatCanvas, drawReceipt } from './chat-canvas';
import { finale, receiptLift } from './timeline';

/**
 * Celular em 3D com a conversa na tela (textura de canvas) e o comprovante que
 * salta da tela para a frente, como o card da referência. No fim, o celular
 * flutua como a moeda do hero. Tudo em código.
 */

const PHONE = { w: 3.0, h: 6.24, d: 0.3, r: 0.5 };
const SCREEN = { w: 2.76, h: 2.76 * (SCREEN_H / SCREEN_W) };

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

/** ShapeGeometry com UV de 0 a 1 (para a textura cobrir a forma inteira). */
function shapePlane(w: number, h: number, r: number) {
  const geo = new THREE.ShapeGeometry(roundedRect(w, h, r), 16);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / w + 0.5, uv.getY(i) / h + 0.5);
  return geo;
}

export interface ChatStage {
  render(p: number, time: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export function createChatStage(
  canvasEl: HTMLCanvasElement,
  svg: string,
  fontFamily: string,
): ChatStage {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight('#ffffff', 1.3);
  key.position.set(-5, 8, 10);
  scene.add(key, new THREE.AmbientLight('#ffffff', 0.25));

  // Celular: corpo azul-marinho com borda metálica e tela com a conversa.
  const phone = new THREE.Group();
  const bodyGeo = new THREE.ExtrudeGeometry(
    roundedRect(PHONE.w - 0.16, PHONE.h - 0.16, PHONE.r - 0.08),
    {
      depth: PHONE.d - 0.16,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.08,
      bevelSegments: 6,
      curveSegments: 24,
    },
  );
  bodyGeo.translate(0, 0, -(PHONE.d - 0.16) / 2);
  const body = new THREE.Mesh(bodyGeo, [
    new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.3, metalness: 0.3 }),
    new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.25, metalness: 0.85 }),
  ]);
  const zPath =
    new DOMParser()
      .parseFromString(svg, 'image/svg+xml')
      .querySelector('path')
      ?.getAttribute('d') ?? '';
  const chat = createChatCanvas(zPath, fontFamily);
  const chatTex = new THREE.CanvasTexture(chat.canvas);
  chatTex.colorSpace = THREE.SRGBColorSpace;
  chatTex.anisotropy = 8;
  const screen = new THREE.Mesh(
    shapePlane(SCREEN.w, SCREEN.h, 0.38),
    // Tela sem luz da cena: as cores da interface ficam fiéis.
    new THREE.MeshBasicMaterial({ map: chatTex, toneMapped: false }),
  );
  screen.position.z = PHONE.d / 2 + 0.002;
  // Vidro: um reflexo leve por cima da tela.
  const glass = new THREE.Mesh(
    shapePlane(SCREEN.w, SCREEN.h, 0.38),
    new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.06,
      roughness: 0.05,
      clearcoat: 1,
      envMapIntensity: 1.5,
    }),
  );
  glass.position.z = PHONE.d / 2 + 0.006;
  const buttons = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.6, 0.12),
    new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.85, roughness: 0.3 }),
  );
  buttons.position.set(PHONE.w / 2 + 0.01, 1.2, 0);
  phone.add(body, screen, glass, buttons);
  scene.add(phone);

  // Comprovante em destaque: sai do balão da imagem e vem para a frente.
  const rc = document.createElement('canvas');
  rc.width = 600;
  rc.height = 720;
  drawReceipt(
    rc.getContext('2d')!,
    600,
    720,
    `${fontFamily}, ui-sans-serif, system-ui, sans-serif`,
  );
  const receiptTex = new THREE.CanvasTexture(rc);
  receiptTex.colorSpace = THREE.SRGBColorSpace;
  receiptTex.anisotropy = 8;
  const RW = 3.3;
  const RH = RW * (720 / 600);
  const receipt = new THREE.Mesh(
    new THREE.PlaneGeometry(RW, RH),
    new THREE.MeshBasicMaterial({ map: receiptTex, transparent: true, toneMapped: false }),
  );
  // Sombra suave atrás do comprovante.
  const shade = new THREE.Mesh(
    new THREE.PlaneGeometry(RW * 1.15, RH * 1.1),
    new THREE.MeshBasicMaterial({
      map: (() => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d')!;
        const grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
        grad.addColorStop(0, 'rgba(15,23,42,0.35)');
        grad.addColorStop(1, 'rgba(15,23,42,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        return new THREE.CanvasTexture(c);
      })(),
      transparent: true,
      depthWrite: false,
    }),
  );
  shade.position.set(0.15, -0.25, -0.05);
  receipt.add(shade);
  scene.add(receipt);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 100);
  let wide = false;
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const qFrom = new THREE.Quaternion();
  const qTo = new THREE.Quaternion();

  function render(p: number, time: number) {
    const fin = finale(p);
    // Flutua o tempo todo, como a moeda do hero. A tela fica virada para
    // dentro da página (para o texto): no desktop o celular está à esquerda.
    const inward = wide ? 0.26 : 0.12;
    phone.rotation.set(
      0.05 + Math.sin(time * 0.6) * 0.025,
      inward + Math.sin(time * 0.45) * 0.07,
      -0.03 + Math.sin(time * 0.5) * 0.015,
    );
    phone.position.y = Math.sin((time * Math.PI * 2) / 3.6) * 0.12;
    phone.updateMatrixWorld(true);

    const lift = receiptLift(p);
    const rect = chat.draw(p, time, lift > 0.02);
    chatTex.needsUpdate = true;

    receipt.visible = lift > 0.02 && rect !== null;
    if (rect) {
      // Ponto de partida: o balão da imagem, na superfície da tela.
      const cx = (rect.x + rect.w / 2) / SCREEN_W - 0.5;
      const cy = 0.5 - (rect.y + rect.h / 2) / SCREEN_H;
      from.set(cx * SCREEN.w, cy * SCREEN.h, PHONE.d / 2 + 0.02).applyMatrix4(phone.matrixWorld);
      qFrom.copy(phone.quaternion);
      const s0 = ((rect.w / SCREEN_W) * SCREEN.w) / RW;
      // Destino: à frente e à direita do celular, virado para a câmera.
      // Fica sobre o celular, um pouco à direita, sem invadir a coluna do texto.
      to.set(wide ? 0.95 : 0.35, 0.2, 3.4);
      qTo.identity();
      receipt.position.lerpVectors(from, to, lift);
      receipt.quaternion.slerpQuaternions(qFrom, qTo, Math.min(1, lift));
      receipt.scale.setScalar(s0 + (0.88 - s0) * lift);
    }

    const dist = 14.5 + fin.pull * 2.2;
    camera.position.set(0, 0.2, dist);
    camera.lookAt(0, 0.1, 0);
    renderer.render(scene, camera);
  }

  function resize(w: number, h: number) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Mesmo corte do CSS (`lg`): no desktop o celular fica à esquerda e o texto
    // à direita; no celular, o texto vai em cima e o aparelho desce.
    wide = w >= 1024;
    if (wide) camera.setViewOffset(w, h, w * 0.2, 0, w, h);
    else camera.setViewOffset(w, h, 0, -h * 0.13, w, h);
    // Telas estreitas: recua para o aparelho caber.
    camera.zoom = wide ? 1 : Math.min(1, (w / h) * 1.3);
    camera.updateProjectionMatrix();
  }

  function dispose() {
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
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

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { CLASS_LIST, CLASSES, type ClassId } from '@orange/shared';
import { buildShip, type ShipModel } from './ships/models';
import { triangleCount } from './ships/builders';
import { ACCENT_HUES } from './ships/materials';

/** Dev tool: orbit each ship, compare silhouettes, overlay colliders and hit spheres, check budgets. */
const canvas = document.querySelector('#view') as HTMLCanvasElement;
const ui = document.querySelector('#ui') as HTMLDivElement;
const sil = document.querySelector('#sil') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202024, 0.8));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(6, 10, 8);
scene.add(key);
const grid = new THREE.GridHelper(40, 40, 0x334455, 0x1a222c);
grid.position.y = -3;
scene.add(grid);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
camera.position.set(9, 5, 12);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

let current: ShipModel | null = null;
let currentId: ClassId = 'dart';
let accent = 0;
let showColliders = false;
let showHits = false;
let wire = false;
const overlay = new THREE.Group();
scene.add(overlay);

const colliderMat = new THREE.MeshBasicMaterial({ color: 0x5affdc, wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
const hitMat = new THREE.MeshBasicMaterial({ color: 0xff3366, wireframe: true, transparent: true, opacity: 0.5, depthTest: false });

function buildOverlay(id: ClassId): void {
  overlay.clear();
  const def = CLASSES[id];
  if (showColliders) {
    for (const c of def.colliders) {
      let m: THREE.Mesh | null = null;
      switch (c.type) {
        case 'capsuleZ': {
          const g = new THREE.CapsuleGeometry(c.radius, c.halfHeight * 2, 6, 12);
          g.rotateX(Math.PI / 2);
          m = new THREE.Mesh(g, colliderMat); m.position.set(c.pos.x, c.pos.y, c.pos.z);
          break;
        }
        case 'cuboid':
          m = new THREE.Mesh(new THREE.BoxGeometry(c.half.x * 2, c.half.y * 2, c.half.z * 2), colliderMat);
          m.position.set(c.pos.x, c.pos.y, c.pos.z);
          if (c.yawDeg) m.rotation.y = c.yawDeg * Math.PI / 180;
          break;
        case 'ball':
          m = new THREE.Mesh(new THREE.SphereGeometry(c.radius, 12, 8), colliderMat); m.position.set(c.pos.x, c.pos.y, c.pos.z);
          break;
        case 'hull': {
          const pts: THREE.Vector3[] = [];
          for (let i = 0; i < c.points.length; i += 3) pts.push(new THREE.Vector3(c.points[i], c.points[i + 1], c.points[i + 2]));
          m = new THREE.Mesh(new ConvexGeometry(pts), colliderMat);
          break;
        }
      }
      if (m) { m.renderOrder = 10; overlay.add(m); }
    }
  }
  if (showHits) {
    for (const h of def.hitSpheres) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(h.r, 10, 6), hitMat);
      m.position.set(h.c.x, h.c.y, h.c.z); m.renderOrder = 11;
      overlay.add(m);
    }
  }
}

function show(id: ClassId): void {
  if (current) { scene.remove(current.group); current.dispose(); }
  currentId = id;
  current = buildShip(id, accent);
  for (const m of current.meshes) {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if ('wireframe' in mat) (mat as THREE.MeshStandardMaterial).wireframe = wire;
  }
  scene.add(current.group);
  buildOverlay(id);
  drawUi();
}

function drawUi(): void {
  ui.innerHTML = '';
  const row = (parent: HTMLElement) => { const d = document.createElement('div'); parent.appendChild(d); return d; };
  const r1 = row(ui);
  for (const c of CLASS_LIST) {
    const b = document.createElement('button');
    b.textContent = c.name; if (c.id === currentId) b.className = 'on';
    b.onclick = () => show(c.id);
    r1.appendChild(b);
  }
  const r2 = row(ui);
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = document.createElement('button');
    b.textContent = label; if (get()) b.className = 'on';
    b.onclick = () => { set(!get()); show(currentId); };
    r2.appendChild(b);
  };
  toggle('Colliders', () => showColliders, (v) => { showColliders = v; });
  toggle('Hit spheres', () => showHits, (v) => { showHits = v; });
  toggle('Wireframe', () => wire, (v) => { wire = v; });
  const acc = document.createElement('button');
  acc.textContent = `Accent ${accent + 1}/${ACCENT_HUES.length}`;
  acc.onclick = () => { accent = (accent + 1) % ACCENT_HUES.length; show(currentId); };
  r2.appendChild(acc);
  const stats = document.createElement('div');
  stats.id = 'stats';
  ui.appendChild(stats);
}

/** Black-on-white silhouettes from top, side and front for the readability check. */
function silhouettes(): void {
  sil.innerHTML = '';
  const r = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  r.setSize(64, 64);
  const s = new THREE.Scene();
  s.background = new THREE.Color(0xffffff);
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const views: [string, THREE.Vector3][] = [['top', new THREE.Vector3(0, 1, 0)], ['side', new THREE.Vector3(1, 0, 0)], ['front', new THREE.Vector3(0, 0, -1)]];
  for (const [, dir] of views) {
    for (const c of CLASS_LIST) {
      const m = buildShip(c.id, 0);
      m.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = black; });
      s.add(m.group);
      const size = Math.max(c.size.x, c.size.y, c.size.z) * 0.62;
      const cam = new THREE.OrthographicCamera(-size, size, size, -size, 0.1, 100);
      cam.position.copy(dir).multiplyScalar(30);
      cam.up.set(0, dir.y !== 0 ? 0 : 1, dir.y !== 0 ? -1 : 0);
      cam.lookAt(0, 0, 0);
      r.render(s, cam);
      const out = document.createElement('canvas');
      out.width = out.height = 64;
      out.getContext('2d')!.drawImage(r.domElement, 0, 0);
      out.title = `${c.name}`;
      sil.appendChild(out);
      s.remove(m.group);
      m.dispose();
    }
  }
  r.dispose();
}

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false);
  canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const t0 = performance.now();
for (const c of CLASS_LIST) buildShip(c.id, 0).dispose();
const genMs = performance.now() - t0;
show('dart');
silhouettes();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  controls.update();
  current?.animate(t);
  renderer.render(scene, camera);
  const el = document.querySelector('#stats');
  if (el && current) {
    const def = CLASSES[currentId];
    el.textContent = `${def.name} (${def.faction})
size ${def.size.x}×${def.size.y}×${def.size.z} m · mass ${def.mass}
triangles ${triangleCount(current.group)} · draw calls ${renderer.info.render.calls}
meshes ${current.meshes.length} · muzzles ${current.muzzles.length} · engines ${current.engines.length}
all 4 ships generated in ${genMs.toFixed(0)} ms (budget 150)`;
  }
});

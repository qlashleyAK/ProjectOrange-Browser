import * as THREE from 'three';
import { ORANGE_HEX } from '@orange/shared';
import type { MissileView, PickupView, ProjView } from '../view';
import type { Effects } from './effects';

const MAX_PROJ = 600;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);

/** Instanced tracers: a stretched additive core along velocity. Length ∝ speed × 0.03 s. */
export class ProjectileRenderer {
  private core: THREE.InstancedMesh;
  private glow: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    const g = new THREE.OctahedronGeometry(1, 0);
    g.scale(1, 1, 1);
    this.core = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), MAX_PROJ);
    this.core.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PROJ * 3), 3);
    this.core.frustumCulled = false;
    this.core.count = 0;
    const gs = new THREE.SphereGeometry(1, 8, 6);
    this.glow = new THREE.InstancedMesh(gs, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.35 }), MAX_PROJ);
    this.glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PROJ * 3), 3);
    this.glow.frustumCulled = false;
    this.glow.count = 0;
    scene.add(this.core, this.glow);
  }

  update(list: ProjView[]): void {
    let n = 0;
    for (const p of list) {
      if (n >= MAX_PROJ) break;
      const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
      _d.set(p.vel.x / speed, p.vel.y / speed, p.vel.z / speed);
      const w = p.weapon;
      let len = Math.max(0.6, speed * 0.03), width = Math.max(0.12, w.radius * 0.9);
      switch (w.visual) {
        case 'pellet': len *= 0.5; width = 0.16; break;
        case 'spine': len *= 1.2; width = 0.14; break;
        case 'flak': len = 1.6; width = 0.7; break;
        case 'slug': len *= 1.1; width = 0.3; break;
        default: break;
      }
      // don't draw the tracer behind the muzzle on its first frame
      const fresh = Math.min(1, Math.max(0.15, p.age / 0.03));
      len *= fresh;
      _p.set(p.pos.x, p.pos.y, p.pos.z).addScaledVector(_d, -len * 0.5);
      _q.setFromUnitVectors(Z, _d);
      _s.set(width, width, len * 0.5);
      _m.compose(_p, _q, _s);
      this.core.setMatrixAt(n, _m);
      this.core.setColorAt(n, _c.set(w.color).multiplyScalar(4));
      _s.set(width * 4, width * 4, Math.max(width * 4, len * 0.6));
      _m.compose(_p, _q, _s);
      this.glow.setMatrixAt(n, _m);
      this.glow.setColorAt(n, _c.set(w.color).multiplyScalar(0.6));
      n++;
    }
    this.core.count = this.glow.count = n;
    this.core.instanceMatrix.needsUpdate = this.glow.instanceMatrix.needsUpdate = true;
    if (this.core.instanceColor) this.core.instanceColor.needsUpdate = true;
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true;
  }
}

const TRAIL_SAMPLES = 32;
const TRAIL_FADE = 1.5;
const WARM = new THREE.Color(0xfff1d6);
const TORPEDO = new THREE.Color(0xff3fd0);

interface Trail {
  mesh: THREE.Mesh;
  hist: Float32Array;
  count: number;
  color: THREE.Color;
  width: number;
  lastSeen: number;
  /** seconds of fade left once the missile is gone; negative while it is still flying */
  fade: number;
  smokeT: number;
}

function ribbonMesh(): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 2 * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 2 * 3), 3));
  const index = new Uint16Array((TRAIL_SAMPLES - 1) * 6);
  for (let i = 0; i < TRAIL_SAMPLES - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    index.set([a, b, d, a, d, c], i * 6);
  }
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  }));
  mesh.frustumCulled = false;
  return mesh;
}

/** Missiles: a bright body, a camera-facing ribbon, and a short smoke wake. The ribbon fades for 1.5 s after impact. */
export class MissileRenderer {
  private bodies: THREE.InstancedMesh;
  private glow: THREE.InstancedMesh;
  private trails = new Map<number, Trail>();
  private pool: Trail[] = [];
  private group = new THREE.Group();
  private frame = 0;
  private side = new THREE.Vector3();

  constructor(scene: THREE.Scene, private effects: Effects) {
    const g = new THREE.CylinderGeometry(0.18, 0.55, 4.2, 8);
    g.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false });
    this.bodies = new THREE.InstancedMesh(g, mat, 128);
    this.bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(128 * 3), 3);
    this.bodies.frustumCulled = false;
    this.bodies.count = 0;
    this.glow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 8, 6), mat, 128);
    this.glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(128 * 3), 3);
    this.glow.frustumCulled = false;
    this.glow.count = 0;
    scene.add(this.bodies, this.glow, this.group);
  }

  private trail(id: number, color: number, width: number): Trail {
    let t = this.trails.get(id);
    if (t) return t;
    t = this.pool.pop();
    if (!t) t = { mesh: ribbonMesh(), hist: new Float32Array(TRAIL_SAMPLES * 3), count: 0, color: new THREE.Color(), width, lastSeen: 0, fade: -1, smokeT: 0 };
    t.count = 0;
    t.fade = -1;
    t.width = width;
    t.color.copy(color === TORPEDO.getHex() ? TORPEDO : WARM);
    this.group.add(t.mesh);
    this.trails.set(id, t);
    return t;
  }

  private layRibbon(t: Trail, camera: THREE.Camera, alpha: number): void {
    const pos = t.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = t.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const c = col.array as Float32Array;
    const n = t.count;
    const cam = camera.position;
    for (let i = 0; i < n; i++) {
      const x = t.hist[i * 3]!, y = t.hist[i * 3 + 1]!, z = t.hist[i * 3 + 2]!;
      const j = i === 0 ? 1 : i - 1;
      const dx = t.hist[j * 3]! - x, dy = t.hist[j * 3 + 1]! - y, dz = t.hist[j * 3 + 2]! - z;
      this.side.set(dy * (cam.z - z) - dz * (cam.y - y), dz * (cam.x - x) - dx * (cam.z - z), dx * (cam.y - y) - dy * (cam.x - x));
      if (this.side.lengthSq() < 1e-6) this.side.set(0, 1, 0);
      else this.side.normalize();
      const w = t.width * Math.pow(1 - i / TRAIL_SAMPLES, 0.7);
      this.side.multiplyScalar(w);
      const o = i * 6;
      p[o] = x + this.side.x; p[o + 1] = y + this.side.y; p[o + 2] = z + this.side.z;
      p[o + 3] = x - this.side.x; p[o + 4] = y - this.side.y; p[o + 5] = z - this.side.z;
      const k = alpha * Math.pow(1 - i / TRAIL_SAMPLES, 1.3) * 2.4;
      c[o] = c[o + 3] = t.color.r * k;
      c[o + 1] = c[o + 4] = t.color.g * k;
      c[o + 2] = c[o + 5] = t.color.b * k;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    t.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
  }

  update(list: MissileView[], dt: number, camera: THREE.Camera): void {
    this.frame++;
    let n = 0;
    for (const m of list) {
      const speed = Math.hypot(m.vel.x, m.vel.y, m.vel.z) || 1;
      _d.set(m.vel.x / speed, m.vel.y / speed, m.vel.z / speed);
      _p.set(m.pos.x, m.pos.y, m.pos.z);
      _q.setFromUnitVectors(Z, _d);
      const big = m.kind === 'torpedo' ? 2.4 : m.kind === 'swarm' ? 0.55 : 1.15;
      _s.set(big, big, big * 1.15);
      _m.compose(_p, _q, _s);
      const glowPos = _p.clone().addScaledVector(_d, -1.3 * big);
      if (n < 128) {
        this.bodies.setMatrixAt(n, _m);
        this.bodies.setColorAt(n, _c.copy(m.color === TORPEDO.getHex() ? TORPEDO : WARM).multiplyScalar(m.kind === 'torpedo' ? 7 : 5));
        _s.setScalar(big * 1.6);
        _m.compose(glowPos, _q, _s);
        this.glow.setMatrixAt(n, _m);
        this.glow.setColorAt(n, _c.multiplyScalar(0.45));
        n++;
      }
      const t = this.trail(m.id, m.color, (m.kind === 'torpedo' ? 1.8 : m.kind === 'swarm' ? 0.45 : 0.9) * 1);
      t.lastSeen = this.frame;
      t.fade = -1;
      if (t.count < TRAIL_SAMPLES) t.count++;
      t.hist.copyWithin(3, 0, (TRAIL_SAMPLES - 1) * 3);
      t.hist[0] = _p.x; t.hist[1] = _p.y; t.hist[2] = _p.z;
      this.layRibbon(t, camera, 1);
      t.smokeT -= dt;
      if (t.smokeT <= 0) {
        t.smokeT = m.kind === 'swarm' ? 0.12 : 0.08;
        this.effects.smokeAt(glowPos, _d.clone().multiplyScalar(-6), 0.7 * big, 0.9, 0x8d939c, 1.3);
      }
    }
    this.bodies.count = this.glow.count = n;
    this.bodies.instanceMatrix.needsUpdate = this.glow.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true;
    for (const [id, t] of this.trails) {
      if (t.lastSeen === this.frame) continue;
      if (t.fade < 0) t.fade = TRAIL_FADE;
      t.fade -= dt;
      if (t.fade <= 0 || t.count < 2) {
        this.group.remove(t.mesh);
        this.trails.delete(id);
        this.pool.push(t);
        continue;
      }
      this.layRibbon(t, camera, t.fade / TRAIL_FADE);
    }
  }
}

/** Oranges: emissive core + halo + gentle bob/spin. Drops blink during their last seconds. */
export class PickupRenderer {
  private cores: THREE.InstancedMesh;
  private halos: THREE.InstancedMesh;
  private leaves: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    const core = new THREE.IcosahedronGeometry(1, 2);
    this.cores = new THREE.InstancedMesh(core, new THREE.MeshStandardMaterial({
      color: ORANGE_HEX, emissive: ORANGE_HEX, emissiveIntensity: 2.2, roughness: 0.45, metalness: 0,
    }), 128);
    this.cores.frustumCulled = false;
    const haloTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,106,16,0.9)'); g.addColorStop(0.4, 'rgba(255,106,16,0.25)'); g.addColorStop(1, 'rgba(255,106,16,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: haloTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, color: new THREE.Color(1.6, 1.6, 1.6),
    }), 128);
    this.halos.frustumCulled = false;
    const leaf = new THREE.ConeGeometry(0.22, 0.5, 5);
    leaf.translate(0, 1.1, 0);
    this.leaves = new THREE.InstancedMesh(leaf, new THREE.MeshStandardMaterial({ color: 0x2e8a3a, roughness: 0.6 }), 128);
    this.leaves.frustumCulled = false;
    this.cores.count = this.halos.count = this.leaves.count = 0;
    scene.add(this.cores, this.halos, this.leaves);
  }

  static radius(units: number): number { return 0.9 + 0.22 * Math.min(6, units); }

  update(list: PickupView[], t: number, camera: THREE.Camera): void {
    let n = 0;
    for (const p of list) {
      if (n >= 128) break;
      const blinking = p.drop && p.expireIn < 5;
      if (blinking && Math.sin(t * Math.PI * 2 * (p.expireIn < 2 ? 6 : 3)) < -0.3) continue;
      const r = PickupRenderer.radius(p.units);
      const bob = Math.sin(t * 2 + p.id) * 0.25;
      _p.set(p.pos.x, p.pos.y + bob, p.pos.z);
      _q.setFromAxisAngle(_d.set(0.2, 1, 0.1).normalize(), t * 1.2 + p.id);
      const pulse = 1 + 0.05 * Math.sin(t * 5 + p.id * 1.7);
      _s.setScalar(r * pulse);
      _m.compose(_p, _q, _s);
      this.cores.setMatrixAt(n, _m);
      this.leaves.setMatrixAt(n, _m);
      _s.setScalar(r * 4.5 * pulse);
      _m.compose(_p, camera.quaternion, _s);
      this.halos.setMatrixAt(n, _m);
      n++;
    }
    this.cores.count = this.halos.count = this.leaves.count = n;
    this.cores.instanceMatrix.needsUpdate = this.halos.instanceMatrix.needsUpdate = this.leaves.instanceMatrix.needsUpdate = true;
  }
}

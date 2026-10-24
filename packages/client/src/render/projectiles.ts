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

interface Trail { line: THREE.Line; pts: Float32Array; colors: Float32Array; count: number; lastSeen: number; smokeT: number; color: THREE.Color }
const TRAIL_POINTS = 40;

/** Missiles: small glowing bodies with ribbon-ish line trails and smoke. */
export class MissileRenderer {
  private bodies: THREE.InstancedMesh;
  private trails = new Map<number, Trail>();
  private pool: Trail[] = [];
  private group = new THREE.Group();
  private frame = 0;

  constructor(scene: THREE.Scene, private effects: Effects) {
    const g = new THREE.CylinderGeometry(0.12, 0.2, 1.4, 6);
    g.rotateX(Math.PI / 2);
    this.bodies = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({}), 128);
    this.bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(128 * 3), 3);
    this.bodies.frustumCulled = false;
    this.bodies.count = 0;
    scene.add(this.bodies, this.group);
  }

  private trail(id: number, color: number): Trail {
    let t = this.trails.get(id);
    if (t) return t;
    t = this.pool.pop();
    if (!t) {
      const pts = new Float32Array(TRAIL_POINTS * 3), colors = new Float32Array(TRAIL_POINTS * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      line.frustumCulled = false;
      t = { line, pts, colors, count: 0, lastSeen: 0, smokeT: 0, color: new THREE.Color() };
    }
    t.count = 0;
    t.color.set(color === 0xff3fd0 ? 0xff3fd0 : 0xfff1d6);
    this.group.add(t.line);
    this.trails.set(id, t);
    return t;
  }

  update(list: MissileView[], dt: number): void {
    this.frame++;
    let n = 0;
    for (const m of list) {
      const speed = Math.hypot(m.vel.x, m.vel.y, m.vel.z) || 1;
      _d.set(m.vel.x / speed, m.vel.y / speed, m.vel.z / speed);
      _p.set(m.pos.x, m.pos.y, m.pos.z);
      _q.setFromUnitVectors(Z, _d);
      const big = m.kind === 'torpedo' ? 2.2 : m.kind === 'swarm' ? 0.7 : 1;
      _s.setScalar(big);
      _m.compose(_p, _q, _s);
      if (n < 128) {
        this.bodies.setMatrixAt(n, _m);
        this.bodies.setColorAt(n, _c.set(m.color).multiplyScalar(m.kind === 'torpedo' ? 6 : 3));
        n++;
      }
      const t = this.trail(m.id, m.color);
      t.lastSeen = this.frame;
      // shift points
      if (t.count < TRAIL_POINTS) t.count++;
      t.pts.copyWithin(3, 0, (TRAIL_POINTS - 1) * 3);
      t.pts[0] = _p.x; t.pts[1] = _p.y; t.pts[2] = _p.z;
      for (let i = 0; i < TRAIL_POINTS; i++) {
        const k = i < t.count ? Math.pow(1 - i / TRAIL_POINTS, 1.6) * 2.2 : 0;
        t.colors[i * 3] = t.color.r * k; t.colors[i * 3 + 1] = t.color.g * k; t.colors[i * 3 + 2] = t.color.b * k;
      }
      if (t.count < TRAIL_POINTS) for (let i = t.count; i < TRAIL_POINTS; i++) { t.pts[i * 3] = _p.x; t.pts[i * 3 + 1] = _p.y; t.pts[i * 3 + 2] = _p.z; }
      const geo = t.line.geometry;
      geo.attributes.position!.needsUpdate = true;
      geo.attributes.color!.needsUpdate = true;
      geo.setDrawRange(0, t.count);
      t.smokeT -= dt;
      if (t.smokeT <= 0) {
        t.smokeT = m.kind === 'swarm' ? 0.06 : 0.035;
        this.effects.smokeAt(_p.clone().addScaledVector(_d, -0.8 * big), _d.clone().multiplyScalar(-3), 0.6 * big, 1.5, 0x9aa0a8, 2.2);
        this.effects.flash(_p.clone().addScaledVector(_d, -0.8 * big), m.color === 0xff3fd0 ? 0xff3fd0 : 0xfff1d6, 0.5 * big, 0.3 * big, 0.06);
      }
    }
    this.bodies.count = n;
    this.bodies.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    for (const [id, t] of this.trails) {
      if (t.lastSeen !== this.frame) {
        this.group.remove(t.line);
        this.trails.delete(id);
        this.pool.push(t);
      }
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

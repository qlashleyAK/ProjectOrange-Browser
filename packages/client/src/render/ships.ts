import * as THREE from 'three';
import { BULWARK_DISTANCE, BULWARK_RADIUS, CLASSES, POWERUP_KINDS, POWERUPS, type PowerupKind } from '@orange/shared';
import { accentColor, cloakMaterial } from '../ships/materials';
import { buildShip, type ShipModel } from '../ships/models';
import type { ShipView } from '../view';
import type { Effects, LightRequest } from './effects';

/** Exhaust plume, unit radius at the nozzle (z 0) swelling slightly then tapering to a point at z 1. */
const plumeGeo = (() => {
  const profile: [number, number][] = [[0, 0.82], [0.08, 1.0], [0.2, 0.97], [0.4, 0.8], [0.6, 0.56], [0.8, 0.3], [1, 0.001]];
  const g = new THREE.LatheGeometry(profile.map(([z, r]) => new THREE.Vector2(r, z)), 14);
  g.rotateX(Math.PI / 2); // lathe axis Y → Z
  return g;
})();

export type PlumeMaterial = THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uOpacity: { value: number }; uTime: { value: number }; uSeed: { value: number } } };

/**
 * Hot exhaust: a white core along the axis near the nozzle, the engine color outside it, flickering shock
 * diamonds, and edges that fade with the view angle so the cone never shows a hard silhouette.
 */
function plumeMaterial(color: THREE.Color, seed: number): PlumeMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: color }, uOpacity: { value: 0.85 }, uTime: { value: 0 }, uSeed: { value: seed } },
    vertexShader: /* glsl */ `
      varying float vAlong; varying vec3 vN; varying vec3 vV;
      void main() {
        vAlong = position.z;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uSeed;
      varying float vAlong; varying vec3 vN; varying vec3 vV;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float core = pow(facing, 3.0);
        float along = clamp(vAlong, 0.0, 1.0);
        float fade = pow(1.0 - along, 1.5) * smoothstep(0.0, 0.06, along + 0.02);
        float diamonds = 0.82 + 0.18 * sin(along * 26.0 - uTime * 38.0 + uSeed);
        float flicker = 0.9 + 0.1 * sin(uTime * 53.0 + uSeed * 3.1);
        vec3 col = mix(uColor, vec3(max(uColor.r, max(uColor.g, uColor.b))), core * (1.0 - along) * 0.85);
        float a = fade * (0.18 + 0.82 * core) * diamonds * flicker * uOpacity;
        gl_FragColor = vec4(col * a, a);
      }`,
  }) as PlumeMaterial;
}

const SPAWN_BUBBLE = new THREE.Color(0.5, 0.8, 1.0);
const SAFE_BUBBLE = new THREE.Color(0.43, 1.0, 0.79);

function bulwarkMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uHealth: { value: 1 }, uRipple: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; vec3 p = position; p.z -= dot(p.xy, p.xy) * 0.035; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uHealth; uniform float uRipple; varying vec2 vP;
      float hexLine(vec2 p) {
        p *= vec2(1.0, 1.1547); p.x += mod(floor(p.y), 2.0) * 0.5;
        vec2 f = abs(fract(p) - 0.5);
        return smoothstep(0.42, 0.5, max(f.x * 1.5 + f.y, f.y * 2.0) * 0.5 + 0.25);
      }
      float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      void main() {
        float r = length(vP) / ${BULWARK_RADIUS.toFixed(2)};
        float edge = smoothstep(1.0, 0.92, r);
        float h = hexLine(vP * 1.4);
        float ripple = uRipple * (0.5 + 0.5 * sin(r * 30.0 - uTime * 25.0));
        float crack = step(uHealth + 0.15, h21(floor(vP * 1.4))) * 0.8;
        float a = edge * (0.12 + h * 0.5 + ripple * 0.5 + smoothstep(0.85, 1.0, r) * 0.7) * (1.0 - crack * 0.85);
        gl_FragColor = vec4(vec3(0.6, 0.45, 1.0) * a * 2.2, a);
      }`,
  });
}

const auraGeo = new THREE.SphereGeometry(1, 40, 24);

/** Powerup shell: fresnel rim plus a per-kind pattern (quad bands, reflect hexes, haste rings, speed streaks). */
function auraMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uKind: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() { vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uKind; uniform float uAlpha;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      float hexLine(vec2 p) {
        p *= vec2(1.0, 1.1547); p.x += mod(floor(p.y), 2.0) * 0.5;
        vec2 f = abs(fract(p) - 0.5);
        return smoothstep(0.4, 0.5, max(f.x * 1.5 + f.y, f.y * 2.0) * 0.5 + 0.25);
      }
      void main() {
        float rim = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.2);
        vec3 p = vP;
        float pat;
        if (uKind < 0.5) pat = pow(0.5 + 0.5 * sin(p.z * 8.0 - uTime * 9.0 + sin(atan(p.y, p.x) * 3.0 + uTime * 2.0) * 1.5), 4.0);
        else if (uKind < 1.5) pat = hexLine(vec2(atan(p.z, p.x) * 2.6, p.y * 3.2 + uTime * 0.3)) * (0.6 + 0.4 * sin(uTime * 5.0 + p.z * 3.0));
        else if (uKind < 2.5) pat = smoothstep(0.86, 1.0, fract(-p.z * 3.0 - uTime * 2.6)) + smoothstep(0.9, 1.0, fract(atan(p.y, p.x) * 0.955 + uTime * 0.8)) * 0.5;
        else pat = pow(0.5 + 0.5 * sin(atan(p.y, p.x) * 9.0), 8.0) * smoothstep(-1.0, 1.0, p.z) * (0.6 + 0.4 * sin(p.z * 10.0 - uTime * 30.0));
        float a = (rim * 0.8 + pat * (0.22 + rim * 0.7)) * uAlpha;
        gl_FragColor = vec4(uColor * a * 1.8, a);
      }`,
  });
}

interface Entry {
  view: ShipView;
  model: ShipModel;
  key: string;
  root: THREE.Group;
  plumes: THREE.Mesh[];
  plumeMat: PlumeMaterial;
  plumeBase: THREE.Color;
  aura: THREE.Mesh;
  auraKind: PowerupKind | null;
  auraT: number;
  moteT: number;
  bulwark: THREE.Mesh;
  bubble: THREE.Mesh;
  cloakMat: ReturnType<typeof cloakMaterial>;
  cloakOn: boolean;
  smokeT: number;
  rcsT: number;
  lastPos: THREE.Vector3;
  wasBulwark: boolean;
}

export class ShipRenderer {
  readonly group = new THREE.Group();
  private entries = new Map<number, Entry>();
  hideLocal = false;
  private tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, private effects: Effects) {
    scene.add(this.group);
  }

  get(id: number): Entry | undefined { return this.entries.get(id); }

  /** World position of a muzzle anchor for an owner (falls back to the ship origin). */
  muzzleWorld(id: number, index: number, out: THREE.Vector3): THREE.Vector3 | null {
    const e = this.entries.get(id);
    if (!e || !e.root.visible) return null;
    const m = e.model.muzzles[index % Math.max(1, e.model.muzzles.length)];
    return m ? m.getWorldPosition(out) : e.root.getWorldPosition(out);
  }

  rootOf(id: number): THREE.Object3D | null { return this.entries.get(id)?.root ?? null; }

  bulwarkRipple(id: number): void {
    const e = this.entries.get(id);
    if (e) (e.bulwark.material as THREE.ShaderMaterial).uniforms.uRipple!.value = 1;
  }

  private create(v: ShipView): Entry {
    const model = buildShip(v.classId, v.accent);
    // ships throw shadows onto the arena; they don't take them, so a soft low-res map never streaks the hull
    for (const m of model.meshes) m.castShadow = true;
    const root = new THREE.Group();
    root.add(model.group);
    const accent = accentColor(v.accent);
    const faction = CLASSES[v.classId].faction;
    const base = new THREE.Color(faction === 'machine' ? 0xc04bff : 0x9fe8ff).lerp(accent, 0.25);
    const plumeMat = plumeMaterial(base.multiplyScalar(2.5), v.id * 1.7);
    const plumes = model.engines.map((a) => {
      const p = new THREE.Mesh(plumeGeo, plumeMat);
      p.position.copy(a.position);
      model.group.add(p);
      return p;
    });
    const bulwark = new THREE.Mesh(new THREE.CircleGeometry(BULWARK_RADIUS, 48), bulwarkMaterial());
    bulwark.position.set(0, 0, -BULWARK_DISTANCE);
    bulwark.visible = false;
    root.add(bulwark);
    const def = CLASSES[v.classId];
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(def.boundingRadius * 0.9, 24, 16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.8, 1.0), transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
    bubble.visible = false;
    root.add(bubble);
    const aura = new THREE.Mesh(auraGeo, auraMaterial());
    aura.scale.set(def.size.x * 0.62, def.size.y * 0.9 + 0.8, def.size.z * 0.6);
    aura.visible = false;
    root.add(aura);
    this.group.add(root);
    return {
      view: v, model, key: `${v.classId}:${v.accent}`, root, plumes, plumeMat, plumeBase: plumeMat.uniforms.uColor.value.clone(), aura, auraKind: null, auraT: 0, moteT: 0,
      bulwark, bubble, cloakMat: cloakMaterial(), cloakOn: false,
      smokeT: 0, rcsT: 0, lastPos: new THREE.Vector3(v.pos.x, v.pos.y, v.pos.z), wasBulwark: false,
    };
  }

  private destroy(e: Entry): void {
    this.group.remove(e.root);
    e.model.dispose();
    e.plumeMat.dispose();
    e.bulwark.geometry.dispose();
    (e.bulwark.material as THREE.Material).dispose();
    e.bubble.geometry.dispose();
    (e.bubble.material as THREE.Material).dispose();
    (e.aura.material as THREE.Material).dispose();
    e.cloakMat.dispose();
  }

  private updateAura(e: Entry, v: ShipView, dt: number, t: number): void {
    const k = v.shimmer ? null : v.powerup;
    if (k !== e.auraKind) {
      e.auraKind = k;
      e.auraT = 0;
      if (k) e.plumeMat.uniforms.uColor.value.copy(e.plumeBase).lerp(new THREE.Color(POWERUPS[k].color).multiplyScalar(2.5), 0.75);
      else e.plumeMat.uniforms.uColor.value.copy(e.plumeBase);
    }
    e.aura.visible = !!k;
    if (!k) return;
    e.auraT += dt;
    const color = POWERUPS[k].color;
    const u = (e.aura.material as THREE.ShaderMaterial).uniforms;
    u.uTime!.value = t;
    u.uKind!.value = POWERUP_KINDS.indexOf(k);
    (u.uColor!.value as THREE.Color).setHex(color);
    u.uAlpha!.value = (v.isLocal ? 0.45 : 1) * Math.min(1, e.auraT * 3) * (0.85 + 0.15 * Math.sin(t * 6 + v.id));
    const pop = 1 + Math.max(0, 0.4 - e.auraT) * 1.5;
    const def = CLASSES[v.classId];
    e.aura.scale.set(def.size.x * 0.62 * pop, (def.size.y * 0.9 + 0.8) * pop, def.size.z * 0.6 * pop);

    e.moteT -= dt;
    if (e.moteT > 0) return;
    e.moteT = v.isLocal ? 0.05 : 0.025;
    const q = e.root.quaternion, sx = def.size.x * 0.55, sy = def.size.y * 0.6, sz = def.size.z * 0.55;
    const drift = new THREE.Vector3(v.vel.x * 0.55, v.vel.y * 0.55, v.vel.z * 0.55);
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.acos(Math.random() * 2 - 1);
      const off = new THREE.Vector3(Math.sin(b) * Math.cos(a) * sx, Math.cos(b) * sy, Math.sin(b) * Math.sin(a) * sz).applyQuaternion(q);
      const p = e.root.position.clone().add(off);
      const out = off.clone().normalize().multiplyScalar(2 + Math.random() * 3);
      if (k === 'speed') this.effects.moteAt(p, drift.clone().multiplyScalar(0.6), color, 0.9 + Math.random() * 0.8, 0.5 + Math.random() * 0.3, 0.5);
      else this.effects.moteAt(p, out.add(drift).add(new THREE.Vector3(0, k === 'reflect' ? 1.5 : 0.5, 0)), color, 0.8 + Math.random() * 0.9, 0.7 + Math.random() * 0.5);
    }
    if (k === 'quad' && Math.random() < 0.2) {
      const p = e.root.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * sx * 2, (Math.random() - 0.5) * sy, (Math.random() - 0.5) * sz * 2).applyQuaternion(q));
      this.effects.sparksAt(p, null, color, 4, 14, 0.25);
    }
    if (k === 'haste') for (const m of e.model.muzzles) if (Math.random() < 0.5) this.effects.moteAt(m.getWorldPosition(new THREE.Vector3()), drift, color, 1.2, 0.3, 3);
    if (k === 'speed' && Math.hypot(v.vel.x, v.vel.y, v.vel.z) > 40) {
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      this.effects.sparksAt(e.root.position.clone().addScaledVector(back, sz), back, color, 2, 30, 0.3);
    }
  }

  /** Lights following powerup holders, merged with effect lights by the light rig. */
  auraLights(out: LightRequest[]): void {
    for (const e of this.entries.values()) {
      if (!e.auraKind || !e.root.visible) continue;
      out.push({ pos: e.root.position.clone(), color: new THREE.Color(POWERUPS[e.auraKind].color), intensity: e.view.isLocal ? 260 : 420, t: 0, dur: 1, range: 34 });
    }
  }

  update(views: ShipView[], dt: number, t: number): void {
    const seen = new Set<number>();
    for (const v of views) {
      seen.add(v.id);
      let e = this.entries.get(v.id);
      const key = `${v.classId}:${v.accent}`;
      if (e && e.key !== key) { this.destroy(e); e = undefined; }
      if (!e) { e = this.create(v); this.entries.set(v.id, e); }
      e.view = v;
      const visible = v.alive && !v.cloaked && !(v.isLocal && this.hideLocal);
      e.root.visible = visible;
      if (!visible) continue;
      e.root.position.set(v.pos.x, v.pos.y, v.pos.z);
      e.root.quaternion.set(v.rot.x, v.rot.y, v.rot.z, v.rot.w);
      e.model.animate(t);

      // cloak shimmer
      if (v.shimmer !== e.cloakOn) {
        e.cloakOn = v.shimmer;
        for (const m of e.model.meshes) {
          if (v.shimmer) { m.userData.mat = m.material; m.material = e.cloakMat; } else if (m.userData.mat) m.material = m.userData.mat as THREE.Material;
        }
        if (e.model.eye) e.model.eye.visible = !v.shimmer;
        // a cloaked ship's shadow on the wall would give away more than its faint shimmer does
        for (const m of e.model.meshes) m.castShadow = !v.shimmer;
      }
      e.cloakMat.uniforms.uTime.value = t;
      e.cloakMat.uniforms.uAlpha.value = v.isLocal ? 0.18 : 0.1;

      // hull shader uniforms
      const dmg = v.hullFrac < 0.5 ? Math.min(1, (0.5 - v.hullFrac) * 2 + 0.2) : 0;
      for (const m of [e.model.mats.hull, e.model.mats.dark]) { m.userData.uniforms.uDamage.value = dmg; m.userData.uniforms.uTime.value = t; }

      // engine plumes: length ∝ forward motion, +60% when boosting, off while cloaked
      const def = CLASSES[v.classId];
      const fwd = this.tmp.set(0, 0, -1).applyQuaternion(e.root.quaternion);
      const fwdSpeed = Math.max(0, fwd.x * v.vel.x + fwd.y * v.vel.y + fwd.z * v.vel.z);
      let thrust = 0.25 + 0.75 * Math.min(1, fwdSpeed / def.maxSpeed.fwd);
      if (v.boosting) thrust *= 1.6;
      if (v.overdrive) thrust *= 1.2;
      const flicker = 0.9 + 0.1 * Math.sin(t * 60 + v.id);
      const size = def.id === 'brute' ? 0.45 : def.id === 'mule' ? 0.26 : def.id === 'scythe' ? 0.2 : 0.32;
      for (const p of e.plumes) {
        p.visible = !v.shimmer;
        p.scale.set(size, size, (0.6 + thrust * 2.6) * flicker * (def.id === 'brute' ? 1.4 : 1));
      }
      e.plumeMat.uniforms.uOpacity.value = v.boosting ? 1 : 0.8;
      e.plumeMat.uniforms.uTime.value = t;
      this.updateAura(e, v, dt, t);

      // Mule RCS puffs when strafing / translating sideways
      if (e.model.rcs.length) {
        e.rcsT -= dt;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(e.root.quaternion);
        const lateral = (v.pos.x - e.lastPos.x) * right.x + (v.pos.y - e.lastPos.y) * right.y + (v.pos.z - e.lastPos.z) * right.z;
        if (dt > 0 && Math.abs(lateral / dt) > 8 && e.rcsT <= 0) {
          e.rcsT = 0.08;
          const side = lateral > 0 ? -1 : 1;
          for (const a of e.model.rcs) {
            if (Math.sign(a.position.x) !== side) continue;
            const wp = a.getWorldPosition(new THREE.Vector3());
            this.effects.smokeAt(wp, right.clone().multiplyScalar(side * 6), 0.5, 0.35, 0xd8e8ff, 2);
          }
        }
      }
      e.lastPos.set(v.pos.x, v.pos.y, v.pos.z);

      // Bulwark disc
      e.bulwark.visible = v.bulwark;
      const bm = e.bulwark.material as THREE.ShaderMaterial;
      bm.uniforms.uTime!.value = t;
      bm.uniforms.uRipple!.value = Math.max(0, bm.uniforms.uRipple!.value - dt * 3);
      e.wasBulwark = v.bulwark;

      // spawn protection bubble; mint while sheltered by a safe zone
      e.bubble.visible = v.spawnProtected || v.safe;
      if (e.bubble.visible) {
        const bm = e.bubble.material as THREE.MeshBasicMaterial;
        bm.opacity = v.safe ? 0.1 + 0.04 * Math.sin(t * 4) : 0.06 + 0.04 * Math.sin(t * 10);
        bm.color.copy(v.safe ? SAFE_BUBBLE : SPAWN_BUBBLE);
      }

      // low hull: sparks + smoke trail
      if (v.hullFrac < 0.25 && !v.shimmer) {
        e.smokeT -= dt;
        if (e.smokeT <= 0) {
          e.smokeT = 0.06;
          const p = e.root.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5), (Math.random() - 0.2) * def.size.z * 0.5).applyQuaternion(e.root.quaternion));
          this.effects.smokeAt(p, new THREE.Vector3(v.vel.x * 0.3, v.vel.y * 0.3 + 1, v.vel.z * 0.3), 1.2, 1.4, 0x3a3c40, 2.5);
          if (Math.random() < 0.35) this.effects.sparksAt(p, null, 0xffffe0, 3, 10, 0.3);
        }
      }
    }
    for (const [id, e] of this.entries) if (!seen.has(id)) { this.destroy(e); this.entries.delete(id); }
  }

  setBulwarkHealth(id: number, frac: number): void {
    const e = this.entries.get(id);
    if (e) (e.bulwark.material as THREE.ShaderMaterial).uniforms.uHealth!.value = frac;
  }
}

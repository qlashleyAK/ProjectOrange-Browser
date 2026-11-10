import * as THREE from 'three';
import type { Blueprint } from '@orange/shared';
import type { ArenaView, RoomLightSpec } from '../arena/arenaMesh';
import type { LightRequest } from './effects';

export const STATIC_LIGHTS = 6;
export const DYNAMIC_LIGHTS = 4;
/** half-width of the moon's shadow box around the camera, in meters */
const MOON_SHADOW_HALF = 90;
/** seconds for a reassigned key light's shadows to fade in */
const SHADOW_FADE = 0.35;
const UP = new THREE.Vector3(0, 1, 0);
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Fixed-size light pools. The number of lights never changes (unused ones get intensity 0),
 * so materials don't recompile when the player moves between rooms.
 *
 * Shadows: one light casts them, so the shader permutation is fixed per map and quality tier. Indoors it is
 * the static light nearest the camera (statics[0]); only ships cast into it, so the walls that receive never
 * shadow themselves (no acne, no bias tuning) and the cost is a handful of ship draws per cube face. Under a
 * moon (outdoor maps) the moon casts instead, with the arena's solid geometry as casters too.
 */
export class LightRig {
  private statics: THREE.PointLight[] = [];
  private dynamics: THREE.PointLight[] = [];
  readonly hemi: THREE.HemisphereLight;
  readonly moon: THREE.DirectionalLight;
  dynamicLimit = DYNAMIC_LIGHTS;
  private lastPlace: string | null | undefined;
  private roomSpecs: RoomLightSpec[] = [];
  /** shadow map size from the quality profile (0 = off) */
  private shadowSize = 0;
  private hasMoon = false;
  private moonDir = new THREE.Vector3(0, 1, 0);
  /** the spec statics[0] held last frame, to fade its shadows in when it changes */
  private keySpec: RoomLightSpec | undefined;
  private keyFade = 1;
  private lastUpdate = 0;

  constructor(scene: THREE.Scene, private arena: ArenaView, private adjacency: Map<string, { room: string; tunnel: string }[]>, private tunnelRooms: Map<string, [string, string]>) {
    this.hemi = new THREE.HemisphereLight(0x9fb4d0, 0x15171c, 0.55);
    scene.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0xa6bcff, 0);
    this.moon.target.position.set(0, 0, 0);
    scene.add(this.moon);
    scene.add(this.moon.target);
    for (let i = 0; i < STATIC_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 100, 2);
      scene.add(l);
      this.statics.push(l);
    }
    const key = this.statics[0]!;
    key.shadow.camera.near = 0.5;
    key.shadow.radius = 4;
    key.shadow.bias = -0.002;
    const sc = this.moon.shadow.camera;
    sc.left = sc.bottom = -MOON_SHADOW_HALF;
    sc.right = sc.top = MOON_SHADOW_HALF;
    sc.near = 1;
    sc.far = 900;
    this.moon.shadow.radius = 2.5;
    this.moon.shadow.bias = -0.0004;
    this.moon.shadow.normalBias = 0.12;
    for (let i = 0; i < DYNAMIC_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 40, 2);
      scene.add(l);
      this.dynamics.push(l);
    }
  }

  /** Point the rig at a different map's room lights. */
  setArena(arena: ArenaView, adjacency: Map<string, { room: string; tunnel: string }[]>, tunnelRooms: Map<string, [string, string]>): void {
    this.arena = arena; this.adjacency = adjacency; this.tunnelRooms = tunnelRooms;
    this.lastPlace = undefined;
    this.roomSpecs = [];
    this.keySpec = undefined;
    this.applyShadows();
  }

  /** Shadow map size from the quality profile; 0 turns shadows off. */
  setShadowQuality(size: number): void {
    if (size === this.shadowSize) return;
    this.shadowSize = size;
    this.applyShadows();
  }

  /** Which light casts, at what resolution, and which arena meshes take part. */
  private applyShadows(): void {
    const on = this.shadowSize > 0;
    const moon = on && this.hasMoon;
    const key = this.statics[0]!;
    key.castShadow = on && !moon;
    this.moon.castShadow = moon;
    const resize = (l: THREE.PointLight | THREE.DirectionalLight, size: number) => {
      if (l.shadow.mapSize.x === size) return;
      l.shadow.mapSize.set(size, size);
      l.shadow.map?.dispose();
      l.shadow.map = null;
    };
    if (on) { resize(key, this.shadowSize); resize(this.moon, this.shadowSize * 2); }
    this.arena.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // shader-built surfaces (sky boxes, safe-zone shells) and unlit glow neither take nor cast shadows
      const lit = m.material instanceof THREE.MeshStandardMaterial;
      m.receiveShadow = lit;
      m.castShadow = lit && moon;
    });
  }

  /** Moon and hemisphere from the blueprint, or the indoor defaults. */
  setAtmosphere(at: Blueprint['atmosphere'] | undefined): void {
    if (at?.moon) {
      const d = at.moon.dir, l = Math.hypot(d.x, d.y, d.z) || 1;
      this.moonDir.set(d.x / l, d.y / l, d.z / l);
      this.moon.position.copy(this.moonDir).multiplyScalar(400);
      this.moon.target.position.set(0, 0, 0);
      this.moon.color.setHex(at.moon.color);
      this.moon.intensity = at.moon.intensity;
    } else this.moon.intensity = 0;
    if (this.hasMoon !== !!at?.moon) {
      this.hasMoon = !!at?.moon;
      this.applyShadows();
    }
    if (at?.hemi) {
      this.hemi.color.setHex(at.hemi.sky);
      this.hemi.groundColor.setHex(at.hemi.ground);
      this.hemi.intensity = at.hemi.intensity;
    } else {
      this.hemi.color.setHex(0x9fb4d0);
      this.hemi.groundColor.setHex(0x15171c);
      this.hemi.intensity = 0.55;
    }
  }

  updateStatic(place: string | null, camPos: THREE.Vector3): void {
    if (place !== this.lastPlace) {
      this.lastPlace = place;
      const rooms: string[] = [];
      if (place) {
        const pair = this.tunnelRooms.get(place);
        if (pair) rooms.push(...pair);
        else {
          rooms.push(place);
          for (const a of this.adjacency.get(place) ?? []) if (!rooms.includes(a.room)) rooms.push(a.room);
        }
      }
      this.roomSpecs = [];
      for (const r of rooms) for (const s of this.arena.lights) if (s.room === r) this.roomSpecs.push(s);
    }
    const specs = this.roomSpecs.slice().sort((a, b) => a.pos.distanceToSquared(camPos) - b.pos.distanceToSquared(camPos));
    for (let i = 0; i < STATIC_LIGHTS; i++) {
      const l = this.statics[i]!, s = specs[i];
      if (s) { l.position.copy(s.pos); l.color.copy(s.color); l.intensity = s.intensity; l.distance = s.distance; l.decay = s.decay; }
      else l.intensity = 0;
    }
    this.updateShadows(specs[0], camPos);
  }

  private updateShadows(keySpec: RoomLightSpec | undefined, camPos: THREE.Vector3): void {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, now - this.lastUpdate));
    this.lastUpdate = now;
    const key = this.statics[0]!;
    if (key.castShadow) {
      // a different lamp took over: its shadows point another way, so bring them in rather than snapping
      if (keySpec !== this.keySpec) { this.keySpec = keySpec; this.keyFade = 0; }
      this.keyFade = Math.min(1, this.keyFade + dt / SHADOW_FADE);
      key.shadow.intensity = this.keyFade * this.keyFade * (3 - 2 * this.keyFade);
      // (three sizes the shadow cube's far plane to the lamp's own range each frame)
    }
    if (this.moon.castShadow) {
      // follow the camera, snapped to whole shadow texels so edges don't crawl as it moves
      const texel = (2 * MOON_SHADOW_HALF) / this.moon.shadow.mapSize.x;
      const d = this.moonDir;
      _r.crossVectors(UP, d);
      if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
      _r.normalize();
      _u.crossVectors(d, _r);
      const x = Math.round(camPos.dot(_r) / texel) * texel;
      const y = Math.round(camPos.dot(_u) / texel) * texel;
      _p.copy(_r).multiplyScalar(x).addScaledVector(_u, y).addScaledVector(d, camPos.dot(d));
      this.moon.target.position.copy(_p);
      this.moon.position.copy(_p).addScaledVector(d, 400);
    }
  }

  updateDynamic(requests: LightRequest[], camPos: THREE.Vector3): void {
    const scored = requests.map((r) => {
      const k = 1 - r.t / r.dur;
      return { r, k, score: (r.intensity * k) / (1 + r.pos.distanceTo(camPos) * 0.05) };
    }).sort((a, b) => b.score - a.score);
    for (let i = 0; i < DYNAMIC_LIGHTS; i++) {
      const l = this.dynamics[i]!, s = i < this.dynamicLimit ? scored[i] : undefined;
      if (s) { l.position.copy(s.r.pos); l.color.copy(s.r.color); l.intensity = s.r.intensity * s.k; l.distance = s.r.range; }
      else l.intensity = 0;
    }
  }
}

import * as THREE from 'three';
import type { Blueprint } from '@orange/shared';
import type { ArenaView, RoomLightSpec } from '../arena/arenaMesh';
import type { LightRequest } from './effects';

export const STATIC_LIGHTS = 6;
export const DYNAMIC_LIGHTS = 4;

/**
 * Fixed-size light pools. The number of lights never changes (unused ones get intensity 0),
 * so materials don't recompile when the player moves between rooms.
 */
export class LightRig {
  private statics: THREE.PointLight[] = [];
  private dynamics: THREE.PointLight[] = [];
  readonly hemi: THREE.HemisphereLight;
  readonly moon: THREE.DirectionalLight;
  dynamicLimit = DYNAMIC_LIGHTS;
  private lastPlace: string | null | undefined;
  private roomSpecs: RoomLightSpec[] = [];

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
  }

  /** Moon and hemisphere from the blueprint, or the indoor defaults. */
  setAtmosphere(at: Blueprint['atmosphere'] | undefined): void {
    if (at?.moon) {
      const d = at.moon.dir, l = Math.hypot(d.x, d.y, d.z) || 1;
      this.moon.position.set(d.x / l, d.y / l, d.z / l).multiplyScalar(400);
      this.moon.color.setHex(at.moon.color);
      this.moon.intensity = at.moon.intensity;
    } else this.moon.intensity = 0;
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

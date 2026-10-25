import * as THREE from 'three';
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
  dynamicLimit = DYNAMIC_LIGHTS;
  private lastPlace: string | null | undefined;

  constructor(scene: THREE.Scene, private arena: ArenaView, private adjacency: Map<string, { room: string; tunnel: string }[]>, private tunnelRooms: Map<string, [string, string]>) {
    this.hemi = new THREE.HemisphereLight(0x9fb4d0, 0x15171c, 0.55);
    scene.add(this.hemi);
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
  }

  updateStatic(place: string | null, camPos: THREE.Vector3): void {
    if (place === this.lastPlace) return;
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
    const specs: RoomLightSpec[] = [];
    for (const r of rooms) for (const s of this.arena.lights) if (s.room === r) specs.push(s);
    specs.sort((a, b) => (rooms.indexOf(a.room) - rooms.indexOf(b.room)) || a.pos.distanceTo(camPos) - b.pos.distanceTo(camPos));
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

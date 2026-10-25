import { v3, type V3 } from '../math.js';
import { Rng } from '../rng.js';

export type Theme = 'refinery' | 'industrial' | 'hangar' | 'reactor' | 'rock' | 'machinery' | 'tunnel' | 'sewer';
export type PropMaterial = 'metal' | 'darkMetal' | 'rock' | 'crystal' | 'emissive' | 'hazard';

export interface Room {
  id: string; name: string; center: V3; size: V3; wall: number; landmark: number; theme: Theme;
}
export interface Tunnel {
  id: string; a: string; b: string; side: number; path: V3[]; theme: Theme; bonus?: boolean; label?: string;
}

interface PropBase { room: string; collides: boolean; material: PropMaterial; emissive?: number }
export type Prop = PropBase & (
  | { kind: 'box'; center: V3; size: V3; rotY?: number; rounded?: number }
  | { kind: 'cylinder'; center: V3; radius: number; height: number; axis: 'x' | 'y' | 'z' }
  | { kind: 'rock'; center: V3; radius: number; seed: number; squash?: number }
  | { kind: 'pillar'; center: V3; radius: number; height: number; seed: number }
  | { kind: 'crystal'; center: V3; dir: V3; length: number; radius: number }
  | { kind: 'ring'; center: V3; radius: number; tube: number; axis: 'x' | 'y' | 'z' }
);

/** Pose is a pure function of the tick (arena/movers.ts), so every simulation agrees on it without networking it. */
export type MoverMotion =
  /** full turn about `origin` every `period` seconds (negative = reverse) */
  | { kind: 'spin'; axis: 'x' | 'y' | 'z'; period: number; phase?: number }
  /** eased out to `origin + offset` and back every `period` seconds */
  | { kind: 'slide'; offset: V3; period: number; phase?: number };

/** A rigid assembly of props on one kinematic body. Parts are in world space at the rest pose. */
export interface Mover { id: string; room: string; origin: V3; parts: Prop[]; motion: MoverMotion }

/** Inside, a ship can't be damaged, locked or shoved, and can't fire, for a limited, recharging time. */
export interface SafeZone { id: string; room: string; center: V3; radius: number }

export interface Blueprint {
  id: string; name: string; rooms: Room[]; tunnels: Tunnel[]; props: Prop[]; seed: number;
  movers?: Mover[];
  /** when present, every spawn point is inside a safe zone */
  safeZones?: SafeZone[];
}

const W = 4;
export const ROOMS: Room[] = [
  { id: 'hub', name: 'The Crucible', center: v3(0, 0, 0), size: v3(140, 90, 140), wall: W, landmark: 0xe8f0ff, theme: 'refinery' },
  { id: 'foundry', name: 'Foundry', center: v3(0, 0, -220), size: v3(110, 60, 90), wall: W, landmark: 0xff3fa0, theme: 'industrial' },
  { id: 'dock', name: 'Docking Bay', center: v3(0, -10, 220), size: v3(150, 50, 80), wall: W, landmark: 0x3f8cff, theme: 'hangar' },
  { id: 'reactor', name: 'Reactor Shaft', center: v3(220, 0, 0), size: v3(70, 220, 70), wall: W, landmark: 0x4cff7a, theme: 'reactor' },
  { id: 'gallery', name: 'Crystal Gallery', center: v3(-220, 10, 0), size: v3(120, 70, 120), wall: W, landmark: 0x9a6bff, theme: 'rock' },
  { id: 'crusher', name: 'Ore Crusher', center: v3(0, 150, 0), size: v3(100, 50, 100), wall: W, landmark: 0x2fe0d0, theme: 'machinery' },
];

const p = (x: number, y: number, z: number) => v3(x, y, z);
export const TUNNELS: Tunnel[] = [
  { id: 'T1', a: 'hub', b: 'foundry', side: 30, theme: 'tunnel', path: [p(0, 0, -70), p(0, 0, -175)] },
  { id: 'T2', a: 'hub', b: 'dock', side: 30, theme: 'tunnel', path: [p(0, -10, 70), p(0, -10, 180)] },
  { id: 'T3', a: 'hub', b: 'reactor', side: 30, theme: 'tunnel', path: [p(70, 0, 0), p(185, 0, 0)] },
  { id: 'T4', a: 'hub', b: 'gallery', side: 30, theme: 'tunnel', path: [p(-70, 10, 0), p(-160, 10, 0)] },
  { id: 'S1', a: 'hub', b: 'crusher', side: 26, theme: 'tunnel', path: [p(35, 45, 0), p(35, 125, 0)] },
  { id: 'S2', a: 'hub', b: 'crusher', side: 26, theme: 'tunnel', path: [p(-35, 45, 0), p(-35, 125, 0)] },
  { id: 'T5', a: 'foundry', b: 'reactor', side: 26, theme: 'tunnel', label: 'upper ring',
    path: [p(55, 15, -220), p(220, 15, -220), p(220, 15, -80), p(220, 60, -80), p(220, 60, -35)] },
  { id: 'T6', a: 'reactor', b: 'dock', side: 26, theme: 'tunnel', label: 'lower ring',
    path: [p(220, -60, 35), p(220, -60, 220), p(220, -15, 220), p(75, -15, 220)] },
  { id: 'T7', a: 'dock', b: 'gallery', side: 26, theme: 'tunnel', path: [p(-75, -10, 220), p(-220, -10, 220), p(-220, -10, 60)] },
  { id: 'T8', a: 'gallery', b: 'foundry', side: 26, theme: 'tunnel', path: [p(-220, 15, -60), p(-220, 15, -220), p(-55, 15, -220)] },
  { id: 'T9', a: 'crusher', b: 'reactor', side: 26, theme: 'tunnel', path: [p(50, 150, 0), p(150, 150, 0), p(150, 90, 0), p(185, 90, 0)] },
  { id: 'T10', a: 'crusher', b: 'gallery', side: 26, theme: 'tunnel', path: [p(-50, 150, 37), p(-120, 150, 37), p(-120, 32, 37), p(-160, 32, 37)] },
  { id: 'T11', a: 'hub', b: 'dock', side: 18, theme: 'sewer', bonus: true, label: 'The Sewer',
    path: [p(-40, -45, -40), p(-40, -90, -40), p(-40, -90, 40), p(30, -90, 40), p(30, -90, 150), p(-40, -90, 150), p(-40, -90, 195), p(-40, -35, 195)] },
];

function roomById(id: string): Room { return ROOMS.find((r) => r.id === id)!; }

/** Doorway lanes in room-relative space, used to keep seeded props clear of approach paths. */
export interface Lane { min: V3; max: V3 }
export function doorLanes(room: Room, depth: number, inflate: number, tunnels: Tunnel[] = TUNNELS): Lane[] {
  const lanes: Lane[] = [];
  const c = room.center, h = v3(room.size.x / 2, room.size.y / 2, room.size.z / 2);
  for (const t of tunnels) {
    for (const [end, rid] of [[t.path[0]!, t.a], [t.path[t.path.length - 1]!, t.b]] as const) {
      if (rid !== room.id) continue;
      const rel = v3(end.x - c.x, end.y - c.y, end.z - c.z);
      const axes = ['x', 'y', 'z'] as const;
      let ax: 'x' | 'y' | 'z' = 'x', best = Infinity;
      for (const a of axes) { const d = Math.abs(Math.abs(rel[a]) - h[a]); if (d < best) { best = d; ax = a; } }
      const s = Math.sign(rel[ax]);
      const min = v3(rel.x - t.side / 2 - inflate, rel.y - t.side / 2 - inflate, rel.z - t.side / 2 - inflate);
      const max = v3(rel.x + t.side / 2 + inflate, rel.y + t.side / 2 + inflate, rel.z + t.side / 2 + inflate);
      if (s > 0) { min[ax] = h[ax] - depth; max[ax] = h[ax]; } else { min[ax] = -h[ax]; max[ax] = -h[ax] + depth; }
      lanes.push({ min, max });
    }
  }
  return lanes;
}
export function sphereHitsLanes(c: V3, r: number, lanes: Lane[]): boolean {
  for (const l of lanes) {
    const dx = Math.max(l.min.x - c.x, 0, c.x - l.max.x);
    const dy = Math.max(l.min.y - c.y, 0, c.y - l.max.y);
    const dz = Math.max(l.min.z - c.z, 0, c.z - l.max.z);
    if (dx * dx + dy * dy + dz * dz < r * r) return true;
  }
  return false;
}
export function segmentHitsLanes(a: V3, b: V3, r: number, lanes: Lane[]): boolean {
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    if (sphereHitsLanes(v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t), r, lanes)) return true;
  }
  return false;
}

function buildProps(seed: number): Prop[] {
  const props: Prop[] = [];
  const rng = new Rng(seed);
  const at = (room: Room, x: number, y: number, z: number) => v3(room.center.x + x, room.center.y + y, room.center.z + z);

  // The Crucible
  {
    const r = roomById('hub');
    const H = r.size.y;
    props.push({ room: r.id, kind: 'cylinder', center: at(r, 0, 0, 0), radius: 9, height: H, axis: 'y', collides: true, material: 'metal' });
    props.push({ room: r.id, kind: 'ring', center: at(r, 0, 0, 0), radius: 9.3, tube: 0.7, axis: 'y', collides: false, material: 'emissive', emissive: 0xe8f0ff });
    for (const [ringY, missing] of [[-15, [1, 5]], [20, [3, 7]]] as const) {
      const apothem = 24 * Math.cos(Math.PI / 8);
      for (let k = 0; k < 8; k++) {
        if ((missing as readonly number[]).includes(k)) continue;
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        props.push({
          room: r.id, kind: 'box', center: at(r, Math.cos(a) * apothem, ringY, Math.sin(a) * apothem),
          size: v3(4, 1.5, 18), rotY: -a, collides: true, material: 'darkMetal',
        });
      }
      const spokes = ringY < 0 ? [0, 2, 4, 6] : [1, 3, 5, 0];
      for (const k of spokes) {
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        const rad = 9 + 7.5;
        props.push({
          room: r.id, kind: 'box', center: at(r, Math.cos(a) * rad, ringY, Math.sin(a) * rad),
          size: v3(15, 1.5, 3), rotY: -a, collides: true, material: 'darkMetal',
        });
      }
    }
    const lanes = doorLanes(r, 45, 6);
    let placed = 0;
    for (let tries = 0; placed < 10 && tries < 400; tries++) {
      const rad = rng.range(4, 8);
      const c = v3(rng.range(-60, 60), rng.range(-34, 34), rng.range(-60, 60));
      const horiz = Math.hypot(c.x, c.z);
      if (horiz < 32) continue;
      if (Math.abs(c.x) > 70 - rad - 4 || Math.abs(c.z) > 70 - rad - 4 || Math.abs(c.y) > 45 - rad - 4) continue;
      if (sphereHitsLanes(c, rad + 2, lanes)) continue;
      if (props.some((q) => q.kind === 'rock' && Math.hypot(q.center.x - c.x, q.center.y - c.y, q.center.z - c.z) < q.radius + rad + 8)) continue;
      props.push({ room: r.id, kind: 'rock', center: at(r, c.x, c.y, c.z), radius: rad, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
      placed++;
    }
  }

  // Foundry
  {
    const r = roomById('foundry');
    const floor = -r.size.y / 2;
    for (const x of [-30, 0, 30]) for (const z of [-20, 15]) {
      props.push({ room: r.id, kind: 'box', center: at(r, x, floor + 12, z), size: v3(14, 24, 14), collides: true, material: 'darkMetal' });
      props.push({ room: r.id, kind: 'box', center: at(r, x, floor + 24.2, z), size: v3(10, 0.4, 10), collides: false, material: 'emissive', emissive: 0xff3fa0 });
    }
    for (const z of [-20, 20]) {
      props.push({ room: r.id, kind: 'box', center: at(r, 0, 24, z), size: v3(110, 3, 3), collides: true, material: 'metal' });
      props.push({ room: r.id, kind: 'cylinder', center: at(r, 0, 16, z), radius: 4, height: 8, axis: 'y', collides: true, material: 'darkMetal' });
      props.push({ room: r.id, kind: 'cylinder', center: at(r, 0, 21.25, z), radius: 0.4, height: 2.5, axis: 'y', collides: false, material: 'metal' });
    }
    for (const x of [-15, 15]) {
      props.push({ room: r.id, kind: 'box', center: at(r, x, floor + 0.06, 0), size: v3(3, 0.1, 84), collides: false, material: 'emissive', emissive: 0xff3fa0 });
    }
  }

  // Docking Bay
  {
    const r = roomById('dock');
    const floor = -r.size.y / 2;
    for (const x of [-45, 0, 45]) {
      props.push({ room: r.id, kind: 'box', center: at(r, x, floor + 6, 15), size: v3(14, 12, 40), rounded: 2.5, collides: true, material: 'metal' });
    }
    props.push({ room: r.id, kind: 'box', center: at(r, 0, 20, -20), size: v3(150, 2, 4), collides: true, material: 'darkMetal' });
    for (let i = -3; i <= 3; i++) {
      props.push({ room: r.id, kind: 'box', center: at(r, i * 20, floor + 0.05, -10), size: v3(0.4, 0.08, 30), collides: false, material: 'emissive', emissive: 0x3f8cff });
    }
    for (let j = -1; j <= 1; j++) {
      props.push({ room: r.id, kind: 'box', center: at(r, 0, floor + 0.05, -10 + j * 14), size: v3(124, 0.08, 0.4), collides: false, material: 'emissive', emissive: 0x3f8cff });
    }
    // sealed bay door + running lights on the far wall
    props.push({ room: r.id, kind: 'box', center: at(r, 0, 0, 39.6), size: v3(90, 40, 0.8), collides: false, material: 'darkMetal' });
    for (let i = -4; i <= 4; i++) {
      props.push({ room: r.id, kind: 'box', center: at(r, i * 10, 21, 39.4), size: v3(1.2, 0.6, 0.4), collides: false, material: 'emissive', emissive: 0x3f8cff });
    }
    for (const y of [-8, 0, 8]) {
      props.push({ room: r.id, kind: 'box', center: at(r, 0, y, 39.1), size: v3(70, 0.8, 0.2), collides: false, material: 'emissive', emissive: 0x0a1430 });
    }
  }

  // Reactor Shaft
  {
    const r = roomById('reactor');
    const H = r.size.y;
    props.push({ room: r.id, kind: 'cylinder', center: at(r, 0, 0, 0), radius: 12, height: H, axis: 'y', collides: true, material: 'metal' });
    for (let y = -90; y <= 90; y += 30) {
      props.push({ room: r.id, kind: 'ring', center: at(r, 0, y, 0), radius: 12.2, tube: 0.8, axis: 'y', collides: false, material: 'emissive', emissive: 0x4cff7a });
    }
    const lanes = doorLanes(r, 20, 1);
    for (let i = 0; i < 8; i++) {
      const y = -90 + (180 * i) / 7;
      const a = (i * Math.PI) / 4 + Math.PI / 8;
      const rad = 20;
      const c = v3(Math.cos(a) * rad, y, Math.sin(a) * rad);
      const reach = v3(Math.cos(a) * (rad + 9), y, Math.sin(a) * (rad + 9));
      if (segmentHitsLanes(c, reach, 6, lanes)) continue;
      props.push({ room: r.id, kind: 'box', center: at(r, c.x, c.y, c.z), size: v3(18, 2, 10), rotY: -a, collides: true, material: 'darkMetal' });
      props.push({ room: r.id, kind: 'box', center: at(r, Math.cos(a) * (rad + 8.9), y + 1.05, Math.sin(a) * (rad + 8.9)), size: v3(0.3, 0.1, 9), rotY: -a, collides: false, material: 'emissive', emissive: 0x4cff7a });
    }
  }

  // Crystal Gallery
  {
    const r = roomById('gallery');
    const H = r.size.y;
    const lanes = doorLanes(r, 26, 4);
    props.push({ room: r.id, kind: 'rock', center: at(r, 0, 0, 0), radius: 10, seed: 4242, collides: true, material: 'rock' });
    const pillarLanes = doorLanes(r, 28, 1);
    let pillars = 0;
    const cands: { c: V3; rad: number }[] = [];
    for (let x = -48; x <= 48; x += 3) for (let z = -48; z <= 48; z += 3) {
      if (Math.hypot(x, z) >= 28) cands.push({ c: v3(x, 0, z), rad: rng.range(8, 12) });
    }
    for (let i = cands.length - 1; i > 0; i--) { const j = rng.int(0, i + 1); [cands[i], cands[j]] = [cands[j]!, cands[i]!]; }
    const tryOrder = [12, 8, 5].flatMap((gap) => cands.map((k) => ({ ...k, gap })));
    for (const { c, rad: r0, gap } of tryOrder) {
      if (pillars >= 6) break;
      let rad = r0;
      if (gap < 12) rad = Math.min(rad, 9);
      if (gap < 8) rad = 8;
      if (Math.abs(c.x) > 60 - rad - 3 || Math.abs(c.z) > 60 - rad - 3) continue;
      if (segmentHitsLanes(v3(c.x, -H / 2, c.z), v3(c.x, H / 2, c.z), rad + 1, pillarLanes)) continue;
      if (props.some((q) => q.kind === 'pillar' && Math.hypot(q.center.x - r.center.x - c.x, q.center.z - r.center.z - c.z) < q.radius + rad + gap)) continue;
      props.push({ room: r.id, kind: 'pillar', center: at(r, c.x, 0, c.z), radius: rad, height: H + 6, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
      pillars++;
    }
    let crystals = 0;
    for (let tries = 0; crystals < 7 && tries < 2000; tries++) {
      const dir = v3(rng.range(-1, 1), rng.range(-0.8, 0.8), rng.range(-1, 1));
      const l = Math.hypot(dir.x, dir.y, dir.z);
      if (l < 0.3) continue;
      dir.x /= l; dir.y /= l; dir.z /= l;
      const len = rng.range(20, 30);
      const base = v3(dir.x * 6, dir.y * 6, dir.z * 6);
      const tip = v3(base.x + dir.x * len, base.y + dir.y * len, base.z + dir.z * len);
      if (Math.abs(tip.y) > H / 2 - 6) continue;
      if (segmentHitsLanes(base, tip, 3, lanes)) continue;
      if (props.some((q) => q.kind === 'crystal' && (q.dir.x * dir.x + q.dir.y * dir.y + q.dir.z * dir.z) > 0.8)) continue;
      const hitsPillar = props.some((q) => {
        if (q.kind !== 'pillar') return false;
        for (let k = 0; k <= 8; k++) {
          const t = 6 + (len * k) / 8;
          if (Math.hypot(dir.x * t - (q.center.x - r.center.x), dir.z * t - (q.center.z - r.center.z)) < q.radius + 9) return true;
        }
        return false;
      });
      if (hitsPillar) continue;
      props.push({ room: r.id, kind: 'crystal', center: at(r, base.x, base.y, base.z), dir, length: len, radius: rng.range(2.2, 3.2), collides: true, material: 'crystal', emissive: 0x9a6bff });
      crystals++;
    }
  }

  // Ore Crusher
  {
    const r = roomById('crusher');
    const floor = -r.size.y / 2;
    for (const z of [-30, 30]) {
      // 58 m rather than 60 m so the end caps stay out of the T10 doorway clearance zone
      props.push({ room: r.id, kind: 'cylinder', center: at(r, 0, -15, z), radius: 10, height: 58, axis: 'x', collides: true, material: 'darkMetal' });
      for (const x of [-20, 0, 20]) {
        props.push({ room: r.id, kind: 'ring', center: at(r, x, -15, z), radius: 10.15, tube: 0.35, axis: 'x', collides: false, material: 'metal' });
      }
    }
    for (const x of [-12, 12]) {
      props.push({ room: r.id, kind: 'box', center: at(r, x, floor + 1, 0), size: v3(8, 2, 40), collides: true, material: 'metal' });
    }
    for (const [x, z] of [[-38, -40], [38, 40], [40, -38], [-40, 40]] as const) {
      props.push({ room: r.id, kind: 'rock', center: at(r, x, floor, z), radius: 7, squash: 0.45, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
    }
    for (const [x, z] of [[-49.4, -20], [-49.4, 20], [49.4, -20], [49.4, 20], [-20, -49.4], [20, 49.4]] as const) {
      props.push({ room: r.id, kind: 'box', center: at(r, x, 18, z), size: v3(1, 1, 1), collides: false, material: 'emissive', emissive: 0x2fe0d0 });
    }
  }
  return props;
}

export const BLUEPRINT_SEED = 0x0a11ce;
export function hollowdeep(): Blueprint {
  return { id: 'hollowdeep', name: 'Hollowdeep Mine', rooms: ROOMS, tunnels: TUNNELS, props: buildProps(BLUEPRINT_SEED), seed: BLUEPRINT_SEED };
}

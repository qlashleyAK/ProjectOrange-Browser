import { q4, qfromAxisAngle, qmul, v3, type Q4, type V3 } from '../math.js';
import { Rng } from '../rng.js';

export type Theme =
  | 'refinery' | 'industrial' | 'hangar' | 'reactor' | 'rock' | 'machinery' | 'tunnel' | 'sewer'
  | 'office' | 'garage' | 'roof' | 'shaft'
  /** Hollowdeep: blasted-rock caverns, shotcrete works halls, a natural cave and timbered drifts */
  | 'mine' | 'works' | 'cave' | 'drift';
/**
 * `sky` is a visual-only window onto the night sky; `color` tints paint and fabric. `ore` is rock shot with
 * veins glowing in `emissive`; `grate` is bar grating, glowing `emissive` through the gaps when given.
 */
export type PropMaterial =
  | 'metal' | 'darkMetal' | 'rock' | 'crystal' | 'emissive' | 'hazard'
  | 'concrete' | 'plaster' | 'fabric' | 'paint' | 'sky' | 'timber' | 'grate' | 'ore';

export interface Room {
  id: string; name: string; center: V3; size: V3; wall: number; landmark: number; theme: Theme;
  /** room light color and intensity scale, when it shouldn't be the landmark color at full strength */
  light?: { color: number; scale: number };
  /** ambient sound bed, when it isn't the theme's */
  ambience?: string;
  /** bot nav nodes on an xz grid of `step` meters at each height offset from the center, linked to near neighbors only */
  navGrid?: { step: number; ys: number[] };
}
export interface Tunnel {
  id: string; a: string; b: string; side: number; path: V3[]; theme: Theme; bonus?: boolean; label?: string;
  /** orange-spawn weight of every segment, packed 8 m apart instead of 25 m */
  oranges?: number;
}

interface PropBase {
  room: string; collides: boolean; material: PropMaterial; emissive?: number; color?: number;
  /** visual-only spin about the world Y axis through `center`, in rad/s */
  spin?: number;
  /** visual-only slow brightness pulse of an emissive prop, in Hz */
  pulse?: number;
}
export type Prop = PropBase & (
  | { kind: 'box'; center: V3; size: V3; rotY?: number; rotX?: number; rotZ?: number; rounded?: number }
  | { kind: 'cylinder'; center: V3; radius: number; height: number; axis: 'x' | 'y' | 'z' }
  | { kind: 'rock'; center: V3; radius: number; seed: number; squash?: number }
  | { kind: 'pillar'; center: V3; radius: number; height: number; seed: number }
  | { kind: 'crystal'; center: V3; dir: V3; length: number; radius: number }
  /** stalactite or stalagmite: an irregular cone from `center` along `dir` */
  | { kind: 'spike'; center: V3; dir: V3; length: number; radius: number; seed: number }
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
  /** hand-placed spawn points (facing the room center), instead of three per room */
  spawns?: { room: string; pos: V3 }[];
  /** world orange target ×scale up to cap; room spawn regions weigh ×roomWeight */
  oranges?: { scale: number; cap: number; roomWeight: number };
}

const _qa = q4(), _qb = q4();
/** Orientation of a box prop: Z tilt, then X tilt, then Y turn. */
export function boxRotation(b: { rotX?: number; rotY?: number; rotZ?: number }, out: Q4): Q4 {
  qfromAxisAngle(out, v3(0, 1, 0), b.rotY ?? 0);
  if (b.rotX) qmul(out, out, qfromAxisAngle(_qa, v3(1, 0, 0), b.rotX));
  if (b.rotZ) qmul(out, out, qfromAxisAngle(_qb, v3(0, 0, 1), b.rotZ));
  return out;
}

const W = 4;
/**
 * Hollowdeep Mine: six cramped chambers cut into the rock, joined by timbered drifts. Room lights are pale
 * work lamps; each room's own color glows in its ore veins, machinery and door frames.
 */
export const ROOMS: Room[] = [
  {
    id: 'hub', name: 'The Crucible', center: v3(0, 0, 0), size: v3(140, 90, 140), wall: W, landmark: 0xe8f0ff, theme: 'mine',
    ambience: 'hub', light: { color: 0xdde8ff, scale: 1 },
  },
  {
    id: 'foundry', name: 'Foundry', center: v3(0, 0, -220), size: v3(110, 60, 90), wall: W, landmark: 0xff3fa0, theme: 'works',
    ambience: 'foundry', light: { color: 0xf2d6e8, scale: 0.95 },
  },
  {
    id: 'dock', name: 'Docking Bay', center: v3(0, -10, 220), size: v3(150, 50, 80), wall: W, landmark: 0x3f8cff, theme: 'works',
    ambience: 'dock', light: { color: 0xd6e2ff, scale: 0.95 },
  },
  {
    id: 'reactor', name: 'Reactor Shaft', center: v3(220, 0, 0), size: v3(70, 220, 70), wall: W, landmark: 0x4cff7a, theme: 'mine',
    ambience: 'reactor', light: { color: 0xcfffdc, scale: 0.9 },
  },
  {
    id: 'gallery', name: 'Crystal Gallery', center: v3(-220, 10, 0), size: v3(120, 70, 120), wall: W, landmark: 0x9a6bff, theme: 'cave',
    ambience: 'gallery', light: { color: 0xdcd0ff, scale: 0.75 },
  },
  {
    id: 'crusher', name: 'Ore Crusher', center: v3(0, 150, 0), size: v3(100, 50, 100), wall: W, landmark: 0x2fe0d0, theme: 'works',
    ambience: 'crusher', light: { color: 0xcffff6, scale: 0.95 },
  },
];

const p = (x: number, y: number, z: number) => v3(x, y, z);
export const TUNNELS: Tunnel[] = [
  { id: 'T1', a: 'hub', b: 'foundry', side: 30, theme: 'drift', path: [p(0, 0, -70), p(0, 0, -175)] },
  { id: 'T2', a: 'hub', b: 'dock', side: 30, theme: 'drift', path: [p(0, -10, 70), p(0, -10, 180)] },
  { id: 'T3', a: 'hub', b: 'reactor', side: 30, theme: 'drift', path: [p(70, 0, 0), p(185, 0, 0)] },
  { id: 'T4', a: 'hub', b: 'gallery', side: 30, theme: 'drift', path: [p(-70, 10, 0), p(-160, 10, 0)] },
  { id: 'S1', a: 'hub', b: 'crusher', side: 26, theme: 'drift', path: [p(35, 45, 0), p(35, 125, 0)] },
  { id: 'S2', a: 'hub', b: 'crusher', side: 26, theme: 'drift', path: [p(-35, 45, 0), p(-35, 125, 0)] },
  { id: 'T5', a: 'foundry', b: 'reactor', side: 26, theme: 'drift', label: 'upper ring',
    path: [p(55, 15, -220), p(220, 15, -220), p(220, 15, -80), p(220, 60, -80), p(220, 60, -35)] },
  { id: 'T6', a: 'reactor', b: 'dock', side: 26, theme: 'drift', label: 'lower ring',
    path: [p(220, -60, 35), p(220, -60, 220), p(220, -15, 220), p(75, -15, 220)] },
  { id: 'T7', a: 'dock', b: 'gallery', side: 26, theme: 'drift', path: [p(-75, -10, 220), p(-220, -10, 220), p(-220, -10, 60)] },
  { id: 'T8', a: 'gallery', b: 'foundry', side: 26, theme: 'drift', path: [p(-220, 15, -60), p(-220, 15, -220), p(-55, 15, -220)] },
  { id: 'T9', a: 'crusher', b: 'reactor', side: 26, theme: 'drift', path: [p(50, 150, 0), p(150, 150, 0), p(150, 90, 0), p(185, 90, 0)] },
  { id: 'T10', a: 'crusher', b: 'gallery', side: 26, theme: 'drift', path: [p(-50, 150, 37), p(-120, 150, 37), p(-120, 32, 37), p(-160, 32, 37)] },
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

const LAMP = 0xe6eeff;
const CAR_COLORS = [0x3e4a57, 0x47504a, 0x55595f];
const CRATE_COLORS = [0x3b4656, 0x4a5547, 0x5a5d63, 0x34404c];

/** Door openings in a room's side walls, room-relative: which wall, the span along it, and the span in height. */
interface WallDoor { axis: 'x' | 'z'; side: number; a0: number; a1: number; y0: number; y1: number }
function wallDoors(room: Room): WallDoor[] {
  const out: WallDoor[] = [];
  const hx = room.size.x / 2, hz = room.size.z / 2;
  for (const t of TUNNELS) {
    for (const [end, rid] of [[t.path[0]!, t.a], [t.path[t.path.length - 1]!, t.b]] as const) {
      if (rid !== room.id) continue;
      const x = end.x - room.center.x, y = end.y - room.center.y, z = end.z - room.center.z, hs = t.side / 2;
      if (Math.abs(Math.abs(x) - hx) < 0.01) out.push({ axis: 'x', side: Math.sign(x), a0: z - hs, a1: z + hs, y0: y - hs, y1: y + hs });
      else if (Math.abs(Math.abs(z) - hz) < 0.01) out.push({ axis: 'z', side: Math.sign(z), a0: x - hs, a1: x + hs, y0: y - hs, y1: y + hs });
    }
  }
  return out;
}
/** Room-relative boxes wall dressing stays out of: every door's clearance zone and, on side walls, its frame and sign. */
function doorKeepOut(room: Room): Lane[] {
  const out = doorLanes(room, 22, 1.5);
  const hx = room.size.x / 2, hz = room.size.z / 2;
  for (const d of wallDoors(room)) {
    const w = d.axis === 'x' ? hx : hz, n0 = d.side > 0 ? w - 5 : -w, n1 = d.side > 0 ? w : -w + 5;
    const y0 = d.y0 - 3, y1 = d.y1 + 8;
    out.push(d.axis === 'x' ? { min: v3(n0, y0, d.a0 - 3), max: v3(n1, y1, d.a1 + 3) } : { min: v3(d.a0 - 3, y0, n0), max: v3(d.a1 + 3, y1, n1) });
  }
  return out;
}
/** Whether room-relative (x, z) is within `m` of a shaft hole in the room's ceiling. */
function nearCeilingHole(room: Room, x: number, z: number, m: number): boolean {
  return TUNNELS.some((t) => ([[t.a, t.path[0]!], [t.b, t.path[t.path.length - 1]!]] as const).some(([rid, e]) =>
    rid === room.id && Math.abs(e.y - room.center.y - room.size.y / 2) < 0.01
    && Math.abs(e.x - room.center.x - x) < t.side / 2 + m && Math.abs(e.z - room.center.z - z) < t.side / 2 + m));
}

function buildProps(seed: number): Prop[] {
  const props: Prop[] = [];
  const rng = new Rng(seed);
  // dressing draws from its own stream, so detailing a room never moves the cover
  const deco = new Rng(seed ^ 0x5eed);
  const at = (room: Room, x: number, y: number, z: number) => v3(room.center.x + x, room.center.y + y, room.center.z + z);

  // all helpers take room-relative coordinates
  type Look = { emissive?: number; color?: number; pulse?: number };
  type BoxLook = Look & { rotX?: number; rotY?: number; rotZ?: number; rounded?: number };
  const box = (r: Room, c: V3, size: V3, material: PropMaterial, collides: boolean, look: BoxLook = {}) =>
    props.push({ room: r.id, kind: 'box', center: at(r, c.x, c.y, c.z), size, material, collides, ...look });
  const cyl = (r: Room, c: V3, radius: number, height: number, axis: 'x' | 'y' | 'z', material: PropMaterial, collides: boolean, look: Look = {}) =>
    props.push({ room: r.id, kind: 'cylinder', center: at(r, c.x, c.y, c.z), radius, height, axis, material, collides, ...look });
  const ring = (r: Room, c: V3, radius: number, tube: number, axis: 'x' | 'y' | 'z', material: PropMaterial, look: Look = {}) =>
    props.push({ room: r.id, kind: 'ring', center: at(r, c.x, c.y, c.z), radius, tube, axis, material, collides: false, ...look });
  const ore = (r: Room, c: V3, radius: number, squash: number, collides: boolean) =>
    props.push({ room: r.id, kind: 'rock', center: at(r, c.x, c.y, c.z), radius, squash, seed: deco.int(1, 1e9), collides, material: 'ore', emissive: r.landmark });
  /** a straight member between two points, square in section */
  const beam = (r: Room, a: V3, b: V3, w: number, material: PropMaterial, collides = false) => {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, h = Math.hypot(dx, dz);
    box(r, p((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), p(Math.hypot(h, dy), w, w), material, collides,
      { rotZ: Math.atan2(dy, h), rotY: Math.atan2(-dz, dx) });
  };
  /** handrail along a deck edge; `a.y` is the deck top */
  const railing = (r: Room, a: V3, b: V3) => {
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 5));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      box(r, p(a.x + (b.x - a.x) * t, a.y + 1.3, a.z + (b.z - a.z) * t), p(0.35, 2.6, 0.35), 'metal', false);
    }
    beam(r, p(a.x, a.y + 2.6, a.z), p(b.x, b.y + 2.6, b.z), 0.32, 'metal');
    beam(r, p(a.x, a.y + 1.4, a.z), p(b.x, b.y + 1.4, b.z), 0.22, 'metal');
  };
  /** high-bay lamp hanging `drop` below the ceiling: rod, shade and a pale lens */
  const lamp = (r: Room, x: number, z: number, drop: number) => {
    const top = r.size.y / 2;
    cyl(r, p(x, top - drop / 2, z), 0.18, drop, 'y', 'darkMetal', false);
    cyl(r, p(x, top - drop - 0.6, z), 1.8, 1.2, 'y', 'darkMetal', false);
    cyl(r, p(x, top - drop - 1.25, z), 1.4, 0.12, 'y', 'emissive', false, { emissive: LAMP });
  };
  /**
   * Steel columns up the side walls (at `cols` along each wall) under a girder ringing the room at `girderY`;
   * doors and the signs above them interrupt both. Every other column carries a floodlight.
   */
  const wallFrame = (r: Room, colsX: number[], colsZ: number[], girderY: number) => {
    const floor = -r.size.y / 2;
    const keepOut = doorKeepOut(r);
    for (const [axis, side] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]] as const) {
      const half = (axis === 'x' ? r.size.z : r.size.x) / 2, wall = (axis === 'x' ? r.size.x : r.size.z) / 2, off = wall - 1.4;
      const pt = (a: number, y: number, inset = 0) => (axis === 'x' ? p(side * (off - inset), y, a) : p(a, y, side * (off - inset)));
      const along = (len: number, h: number, d: number) => (axis === 'x' ? p(d, h, len) : p(len, h, d));
      // anything within `depth` of this wall, spanning [a0, a1] along it and [y0, y1] in height
      const blocked = (a0: number, a1: number, y0: number, y1: number, depth = 4.6) => {
        const n0 = side > 0 ? wall - depth : -wall, n1 = side > 0 ? wall : -wall + depth;
        const min = axis === 'x' ? p(n0, y0, a0) : p(a0, y0, n0), max = axis === 'x' ? p(n1, y1, a1) : p(a1, y1, n1);
        return keepOut.some((b) => min.x < b.max.x && max.x > b.min.x && min.y < b.max.y && max.y > b.min.y && min.z < b.max.z && max.z > b.min.z);
      };
      let start: number | null = null;
      for (let a = -half + 0.2; ; a += 1) {
        const end = a > half - 0.2;
        const free = !end && !blocked(a, a + 1, girderY - 1.2, girderY + 1.2, 2.6);
        if (free && start === null) start = a;
        if (!free && start !== null) {
          const len = Math.min(a, half - 0.2) - start;
          if (len > 3) box(r, pt(start + len / 2, girderY), along(len, 2.4, 2.4), 'darkMetal', true);
          start = null;
        }
        if (end) break;
      }
      const h = girderY - 1.2 - floor;
      let k = 0;
      for (const a of axis === 'x' ? colsZ : colsX) {
        if (blocked(a - 1.4, a + 1.4, floor, girderY)) continue;
        box(r, pt(a, floor + h / 2), along(2.2, h, 2.2), 'darkMetal', true);
        box(r, pt(a, floor + h / 2, 1.25), along(2.8, h, 0.3), 'metal', false);
        if (k++ % 2 === 0) {
          box(r, pt(a, girderY - 3.2, 2.2), along(2.6, 1.6, 1.8), 'darkMetal', false);
          box(r, pt(a, girderY - 3.2, 3.15), along(2.1, 1.1, 0.12), 'emissive', false, { emissive: LAMP });
        }
      }
    }
  };
  /** a short run of mine track: timber sleepers and two rails along z */
  const track = (r: Room, x: number, z0: number, z1: number, gauge: number) => {
    const floor = -r.size.y / 2;
    for (let z = z0 + 1; z <= z1 - 0.6; z += 3.2) box(r, p(x, floor + 0.2, z), p(gauge + 4, 0.4, 1.3), 'timber', false);
    for (const s of [-1, 1]) box(r, p(x + (s * gauge) / 2, floor + 0.65, (z0 + z1) / 2), p(0.6, 0.5, z1 - z0), 'metal', false);
  };

  // ---------------------------------------------------------------- The Crucible: the smelter cavern at the heart of the mine
  {
    const r = roomById('hub');
    const H = r.size.y, floor = -H / 2, ceil = H / 2;
    // the arc-furnace stack: ribbed, banded steel on a concrete plinth, tap holes glowing at its foot
    cyl(r, p(0, 0, 0), 9, H, 'y', 'darkMetal', true);
    ring(r, p(0, 0, 0), 9.3, 0.7, 'y', 'emissive', { emissive: r.landmark });
    for (let y = -40; y <= 40; y += 8) if (y !== 0) ring(r, p(0, y, 0), 9.15, 0.4, 'y', 'metal');
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      box(r, p(Math.cos(a) * 9.1, 0, Math.sin(a) * 9.1), p(0.6, H, 0.9), 'metal', false, { rotY: -a });
    }
    cyl(r, p(0, floor + 2, 0), 14, 4, 'y', 'concrete', true);
    ring(r, p(0, floor + 4, 0), 13.9, 0.3, 'y', 'hazard');
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      box(r, p(Math.cos(a) * 8.9, floor + 6.5, Math.sin(a) * 8.9), p(0.5, 2.4, 3), 'emissive', false,
        { rotY: -a, emissive: r.landmark, pulse: 0.3 + k * 0.07 });
    }
    ring(r, p(0, 36, 0), 12, 0.9, 'y', 'darkMetal');
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      beam(r, p(Math.cos(a) * 8.8, 32, Math.sin(a) * 8.8), p(Math.cos(a) * 12, 36, Math.sin(a) * 12), 0.7, 'metal');
    }

    // two octagonal grating catwalks with gaps, railed, hung from the roof
    const apothem = 24 * Math.cos(Math.PI / 8);
    const upperMissing = [3, 7];
    for (const [ringY, missing] of [[-15, [1, 5]], [20, upperMissing]] as const) {
      const deck = ringY + 0.75;
      for (let k = 0; k < 8; k++) {
        if ((missing as readonly number[]).includes(k)) continue;
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        const u = p(Math.cos(a), 0, Math.sin(a)), t = p(-Math.sin(a), 0, Math.cos(a));
        box(r, p(u.x * apothem, ringY, u.z * apothem), p(4, 1.5, 18), 'grate', true, { rotY: -a });
        const e = apothem + 1.85;
        railing(r, p(u.x * e - t.x * 9, deck, u.z * e - t.z * 9), p(u.x * e + t.x * 9, deck, u.z * e + t.z * 9));
        const top = ringY > 0 ? ceil : upperMissing.includes(k) ? null : 20 - 0.75;
        if (top === null) continue;
        for (const s of [-6.5, 6.5]) {
          const hx = u.x * (apothem + 1.4) + t.x * s, hz = u.z * (apothem + 1.4) + t.z * s;
          if (ringY > 0 && nearCeilingHole(r, hx, hz, 3)) continue;
          cyl(r, p(hx, (deck + top) / 2, hz), 0.2, top - deck, 'y', 'darkMetal', false);
        }
      }
      const spokes = ringY < 0 ? [0, 2, 4, 6] : [1, 3, 5, 0];
      for (const k of spokes) {
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        const rad = 9 + 7.5;
        box(r, p(Math.cos(a) * rad, ringY, Math.sin(a) * rad), p(15, 1.5, 3), 'grate', true, { rotY: -a });
      }
    }

    // ore skips hanging from hoist ropes
    const lanes = doorLanes(r, 45, 6);
    const skips: { c: V3; rad: number; seed: number }[] = [];
    for (let tries = 0; skips.length < 10 && tries < 400; tries++) {
      const rad = rng.range(4, 8);
      const c = v3(rng.range(-60, 60), rng.range(-34, 34), rng.range(-60, 60));
      if (Math.hypot(c.x, c.z) < 32) continue;
      if (Math.abs(c.x) > 70 - rad - 4 || Math.abs(c.z) > 70 - rad - 4 || Math.abs(c.y) > 45 - rad - 4) continue;
      if (sphereHitsLanes(c, rad + 2, lanes)) continue;
      if (skips.some((q) => Math.hypot(q.c.x - c.x, q.c.y - c.y, q.c.z - c.z) < q.rad + rad + 8)) continue;
      skips.push({ c, rad, seed: rng.int(1, 1e9) });
    }
    // a rope can't run up a shaft mouth: slide those skips sideways until theirs clears it
    for (const s of skips) {
      if (!nearCeilingHole(r, s.c.x, s.c.z, 3)) continue;
      const fits = (c: V3) => !nearCeilingHole(r, c.x, c.z, 3) && Math.abs(c.x) <= 70 - s.rad - 4 && Math.abs(c.z) <= 70 - s.rad - 4
        && !sphereHitsLanes(c, s.rad + 2, lanes) && skips.every((q) => q === s || Math.hypot(q.c.x - c.x, q.c.y - c.y, q.c.z - c.z) >= q.rad + s.rad + 8);
      for (let d = 1; d < 40; d++) {
        const c = [p(s.c.x, s.c.y, s.c.z + d), p(s.c.x, s.c.y, s.c.z - d), p(s.c.x + d, s.c.y, s.c.z), p(s.c.x - d, s.c.y, s.c.z)].find(fits);
        if (c) { s.c = c; break; }
      }
    }
    for (const { c, rad, seed: s } of skips) {
      const yaw = deco.range(0, Math.PI);
      const ex = p(Math.cos(yaw), 0, -Math.sin(yaw)), ez = p(Math.sin(yaw), 0, Math.cos(yaw));
      const top = c.y + rad * 0.65;
      box(r, c, p(rad * 2, rad * 1.3, rad * 1.5), 'darkMetal', true, { rotY: yaw });
      for (const sg of [-1, 1]) {
        box(r, p(c.x + ex.x * sg * rad, top, c.z + ex.z * sg * rad), p(0.7, 0.8, rad * 1.5 + 0.7), 'metal', false, { rotY: yaw });
        box(r, p(c.x + ez.x * sg * rad * 0.75, top, c.z + ez.z * sg * rad * 0.75), p(rad * 2 + 0.7, 0.8, 0.7), 'metal', false, { rotY: yaw });
      }
      props.push({ room: r.id, kind: 'rock', center: at(r, c.x, top, c.z), radius: rad * 0.62, squash: 0.45, seed: s, collides: true, material: 'ore', emissive: r.landmark });
      const apex = p(c.x, top + rad * 0.9, c.z);
      for (const sg of [-1, 1]) beam(r, p(c.x + ex.x * sg * rad, top - 0.4, c.z + ex.z * sg * rad), apex, 0.5, 'metal');
      box(r, apex, p(1.6, 2, 1.6), 'darkMetal', false);
      cyl(r, p(apex.x, (apex.y + 1 + ceil) / 2, apex.z), 0.22, ceil - apex.y - 1, 'y', 'darkMetal', false);
    }

    // roof girders either side of the shaft mouths, steel sets up the walls, worklights
    for (const z of [-20, 20]) box(r, p(0, ceil - 1.6, z), p(r.size.x, 2.6, 2.6), 'darkMetal', true);
    wallFrame(r, [-55, -25, 25, 55], [-55, -25, 25, 55], 30);
    for (const [x, z] of [[-45, -45], [45, 45], [-45, 45], [45, -45]] as const) lamp(r, x, z, 3);

    // spoil heaps in two corners, and a cart stood on a short spur of track
    for (const [x, z, rad] of [[50, -50, 11], [-50, 48, 10]] as const) {
      ore(r, p(x, floor, z), rad, 0.5, true);
      for (let i = 0; i < 7; i++) {
        const a = deco.range(0, Math.PI * 2), d = rad * deco.range(1.0, 1.5);
        ore(r, p(x + Math.cos(a) * d, floor + 0.3, z + Math.sin(a) * d), deco.range(1, 2.4), 0.6, false);
      }
    }
    track(r, 30, -46, -14, 6);
    box(r, p(30, floor + 1.5, -45), p(10, 3, 1.4), 'hazard', true);
    box(r, p(30, floor + 5.4, -24), p(8, 5.6, 12), 'paint', true, { color: CAR_COLORS[0], rounded: 0.6 });
    ore(r, p(30, floor + 8.2, -24), 3.6, 0.45, true);
    for (const sx of [-3, 3]) for (const sz of [-4, 4]) cyl(r, p(30 + sx, floor + 1.6, -24 + sz), 1.3, 0.8, 'x', 'darkMetal', false);
  }

  // ---------------------------------------------------------------- Foundry: presses and ladles in a shotcrete hall
  {
    const r = roomById('foundry');
    const floor = -r.size.y / 2, glow = r.landmark;
    // presses: a bed on the floor, four columns, a crown, and the ram over a die glowing in the room's color
    for (const x of [-30, 0, 30]) for (const z of [-20, 15]) {
      box(r, p(x, floor + 3, z), p(14, 6, 14), 'darkMetal', true);
      box(r, p(x, floor + 5.2, z), p(14.3, 1.2, 14.3), 'hazard', false);
      box(r, p(x, floor + 6.15, z), p(10, 0.3, 10), 'emissive', false, { emissive: glow });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(r, p(x + sx * 6, floor + 15, z + sz * 6), p(1.8, 18, 1.8), 'metal', true);
      box(r, p(x, floor + 22, z), p(16, 4, 16), 'darkMetal', true);
      cyl(r, p(x, floor + 17, z), 3, 6, 'y', 'metal', true);
      box(r, p(x, floor + 13, z), p(11, 2, 11), 'darkMetal', true);
      for (const sx of [-1, 1]) cyl(r, p(x + sx * 3.5, floor + 26, z), 1.5, 4, 'y', 'metal', true);
      box(r, p(x + 6.6, floor + 24.6, z + 6.6), p(1, 1.2, 1), 'emissive', false, { emissive: glow, pulse: deco.range(0.5, 0.9) });
    }
    // overhead crane: I-beam runways, a bridge with a hoist, and two ladles of glowing alloy
    for (const z of [-20, 20]) {
      box(r, p(0, 24, z), p(110, 3, 3), 'darkMetal', true);
      for (const y of [22.3, 25.7]) box(r, p(0, y, z), p(110, 0.4, 4.6), 'metal', false);
      cyl(r, p(0, 16, z), 4, 8, 'y', 'darkMetal', true);
      ring(r, p(0, 20, z), 4.05, 0.45, 'y', 'metal');
      cyl(r, p(0, 19.9, z), 3.6, 0.3, 'y', 'emissive', false, { emissive: glow });
      cyl(r, p(0, 21.25, z), 0.4, 2.5, 'y', 'metal', false);
      for (const sx of [-1, 1]) beam(r, p(sx * 4.2, 19.6, z), p(0, 22.3, z), 0.5, 'metal');
    }
    box(r, p(-18, 27.2, 0), p(5, 2.6, 48), 'darkMetal', true);
    box(r, p(-18, 24.6, 4), p(7, 2.5, 7), 'metal', true);
    cyl(r, p(-18, 17.7, 4), 0.18, 11.3, 'y', 'darkMetal', false);
    box(r, p(-18, 10.5, 4), p(2.4, 3, 2.4), 'darkMetal', true);
    ring(r, p(-18, 7.8, 4), 1.2, 0.35, 'z', 'metal');
    // process pipes along the back wall, cabinets beside the door, slab stacks, grated channels in the floor
    for (const [y, rad] of [[6, 1.1], [9.5, 0.8], [13, 1.1]] as const) {
      cyl(r, p(0, y, -43 + (rad - 1.1)), rad, 108, 'x', 'metal', true);
      for (let x = -48; x <= 48; x += 12) ring(r, p(x, y, -43 + (rad - 1.1)), rad + 0.2, 0.3, 'x', 'darkMetal');
    }
    for (let x = -48; x <= 48; x += 24) box(r, p(x, 9.5, -44.2), p(0.8, 11, 1.6), 'darkMetal', false);
    for (const x of [-38, 38]) {
      box(r, p(x, floor + 6, 42.5), p(10, 12, 4), 'metal', true);
      for (const dx of [-2.5, 0, 2.5]) box(r, p(x + dx, floor + 8, 40.45), p(0.4, 5, 0.12), 'emissive', false, { emissive: dx === 0 ? glow : 0x9fffd0 });
    }
    for (const x of [-46, -22, 22, 46]) {
      for (let layer = 0; layer < 3; layer++) {
        const y = floor + 0.6 + layer * 1.2;
        for (const o of [-3, 0, 3]) {
          if (layer % 2 === 0) box(r, p(x + o, y, -37), p(2.6, 1.2, 7), 'metal', true);
          else box(r, p(x, y, -37 + o * 0.85), p(8.6, 1.2, 2), 'metal', true);
        }
      }
    }
    for (const x of [-15, 15]) box(r, p(x, floor + 0.1, 0), p(3.4, 0.2, 80), 'grate', false, { emissive: glow });
    for (const z of [-30, 30]) for (let x = -50; x <= 50; x += 7) box(r, p(x, floor + 0.05, z), p(4, 0.1, 0.6), 'paint', false, { color: 0xc9ced6 });
    for (const [x, z] of [[-40, -34], [0, -34], [40, -34], [-40, 34], [0, 34], [40, 34], [0, 0]] as const) lamp(r, x, z, 2);
    wallFrame(r, [-44, -14, 14, 44], [-30, 30], 18);
  }

  // ---------------------------------------------------------------- Docking Bay: loaded ore cars waiting at the space door
  {
    const r = roomById('dock');
    const floor = -r.size.y / 2, hz = r.size.z / 2;
    for (const [i, x] of [-45, 0, 45].entries()) {
      // the left track stops short of the drain into the sewer
      const z0 = x < 0 ? -12 : -39;
      track(r, x, z0, 39, 9);
      box(r, p(x, floor + 1.75, 37.4), p(11, 3.5, 1.6), 'hazard', true);
      box(r, p(x, floor + 1.75, z0 + 0.8), p(11, 3.5, 1.6), 'hazard', true);
      const color = CAR_COLORS[i]!;
      box(r, p(x, floor + 7.5, 15), p(14, 10, 38), 'paint', true, { color, rounded: 1.2 });
      for (const s of [-1, 1]) {
        box(r, p(x + s * 7, floor + 12.6, 15), p(0.7, 0.9, 38.6), 'darkMetal', false);
        box(r, p(x, floor + 12.6, 15 + s * 19), p(14.6, 0.9, 0.7), 'darkMetal', false);
        for (let z = -3; z <= 33; z += 6) box(r, p(x + s * 7.05, floor + 7.5, z), p(0.4, 9, 0.8), 'darkMetal', false);
        for (const wz of [2, 10, 20, 28]) cyl(r, p(x + s * 5.2, floor + 2.2, wz), 2.2, 1.4, 'x', 'darkMetal', false);
      }
      for (const oz of [-11, 0, 11]) ore(r, p(x, floor + 12.5, 15 + oz), 6.2, 0.42, true);
    }
    // gantry crane over the tracks with a container on the hook
    box(r, p(0, 20, -20), p(150, 2, 4), 'darkMetal', true);
    box(r, p(0, 20, 26), p(150, 2, 4), 'darkMetal', true);
    box(r, p(-22, 22.2, 3), p(5, 2.4, 50), 'darkMetal', true);
    box(r, p(-22, 19.8, 4), p(6, 2.4, 6), 'metal', true);
    for (const sx of [-3, 3]) cyl(r, p(-22 + sx, 13.65, 4), 0.2, 9.9, 'y', 'darkMetal', false);
    box(r, p(-22, 8.3, 4), p(15, 0.8, 2), 'darkMetal', false);
    box(r, p(-22, 4, 4), p(14, 7, 7), 'paint', true, { color: 0x2f4a66 });
    // the bay door: a ribbed blast door in a hazard frame, running lights over it
    box(r, p(0, -2.5, hz - 0.4), p(90, 45, 0.8), 'darkMetal', false);
    box(r, p(0, -2.5, hz - 0.9), p(0.8, 45, 0.3), 'metal', false);
    for (const y of [-18, -12, 12, 18]) box(r, p(0, y, hz - 1.0), p(90, 1.2, 0.5), 'metal', false);
    box(r, p(0, 21.5, hz - 0.8), p(96, 3, 0.9), 'hazard', false);
    for (const sx of [-1, 1]) box(r, p(sx * 46.5, -1, hz - 0.8), p(3, 48, 0.9), 'hazard', false);
    for (let i = -4; i <= 4; i++) box(r, p(i * 10, 23.6, hz - 0.6), p(1.2, 0.6, 0.4), 'emissive', false, { emissive: r.landmark });
    // crate stacks in the corners
    for (const [x, z] of [[-66, 30], [-66, -31], [66, 30], [66, -31]] as const) {
      for (const dz of [-3.7, 3.7]) box(r, p(x, floor + 3.5, z + dz), p(7, 7, 7), 'paint', true, { color: CRATE_COLORS[deco.int(0, 4)]!, rotY: deco.range(-0.06, 0.06) });
      box(r, p(x + deco.range(-0.5, 0.5), floor + 10.5, z + deco.range(-2, 2)), p(7, 7, 7), 'paint', true, { color: CRATE_COLORS[deco.int(0, 4)]!, rotY: deco.range(-0.3, 0.3) });
    }
    // the control booth cantilevered off the back wall, lit
    box(r, p(50, 13, -36.5), p(22, 9, 7), 'metal', true);
    box(r, p(50, 14, -32.95), p(18, 3, 0.2), 'emissive', false, { emissive: 0x4a6a88 });
    for (const x of [42, 58]) beam(r, p(x, 8.6, -33.6), p(x, 0, -39.6), 0.8, 'darkMetal');
    for (const x of [-22.5, 22.5]) for (let z = -36; z <= 34; z += 7) box(r, p(x, floor + 0.05, z), p(0.6, 0.1, 4), 'paint', false, { color: 0xc9ced6 });
    for (const [x, z] of [[-60, 3], [-36, 3], [0, 3], [30, 3], [60, 3], [-50, -31], [-20, -31], [20, -31], [-60, 33], [-20, 33], [20, 33], [60, 33]] as const) lamp(r, x, z, 1.5);
    wallFrame(r, [-58, -30, 30, 58], [-26, 26], 16);
  }

  // ---------------------------------------------------------------- Reactor Shaft: the core stack, railed grating landings, shaft sets
  {
    const r = roomById('reactor');
    const H = r.size.y, floor = -H / 2, ceil = H / 2;
    // the client adds pulsing green bands every 30 m from y = -90; these steel bands sit between them
    cyl(r, p(0, 0, 0), 12, H, 'y', 'darkMetal', true);
    for (let y = -105; y <= 105; y += 30) ring(r, p(0, y, 0), 12.15, 0.45, 'y', 'metal');
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      box(r, p(Math.cos(a) * 12.1, 0, Math.sin(a) * 12.1), p(0.5, H, 0.8), 'metal', false, { rotY: -a });
    }
    const lanes = doorLanes(r, 20, 1);
    for (let i = 0; i < 8; i++) {
      const y = -90 + (180 * i) / 7;
      const a = (i * Math.PI) / 4 + Math.PI / 8;
      const rad = 20;
      const u = p(Math.cos(a), 0, Math.sin(a)), t = p(-Math.sin(a), 0, Math.cos(a));
      const c = v3(u.x * rad, y, u.z * rad);
      const reach = v3(u.x * (rad + 9), y, u.z * (rad + 9));
      if (segmentHitsLanes(c, reach, 6, lanes)) continue;
      box(r, c, p(18, 2, 10), 'grate', true, { rotY: -a });
      box(r, p(u.x * (rad + 8.9), y + 1.05, u.z * (rad + 8.9)), p(0.3, 0.1, 9), 'emissive', false, { rotY: -a, emissive: r.landmark });
      const deck = y + 1, e = rad + 8.7;
      railing(r, p(u.x * e - t.x * 4.7, deck, u.z * e - t.z * 4.7), p(u.x * e + t.x * 4.7, deck, u.z * e + t.z * 4.7));
      for (const s of [-4.7, 4.7]) {
        railing(r, p(u.x * 14 + t.x * s, deck, u.z * 14 + t.z * s), p(u.x * e + t.x * s, deck, u.z * e + t.z * s));
        beam(r, p(u.x * 12.3 + t.x * s * 0.7, y - 9, u.z * 12.3 + t.z * s * 0.7), p(u.x * 25 + t.x * s * 0.7, y - 1, u.z * 25 + t.z * s * 0.7), 0.7, 'metal');
      }
    }
    // shaft sets: a frame of steel round the walls every 20 m, broken by doors; a ladder and a cable tray
    const doors = wallDoors(r);
    for (let y = -100; y <= 100; y += 20) {
      for (const [axis, side] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]] as const) {
        const off = 35 - 1.2;
        const gap = doors.find((d) => d.axis === axis && d.side === side && y > d.y0 - 3 && y < d.y1 + 8);
        const runs: [number, number][] = gap ? [[-35, gap.a0 - 3], [gap.a1 + 3, 35]] : [[-35, 35]];
        for (const [a0, a1] of runs) {
          if (a1 - a0 < 3) continue;
          const m = (a0 + a1) / 2, len = a1 - a0;
          if (axis === 'x') box(r, p(side * off, y, m), p(1.8, 1.6, len), 'darkMetal', true);
          else box(r, p(m, y, side * off), p(len, 1.6, 1.8), 'darkMetal', true);
        }
        if (axis === 'z' && side === 1) {
          box(r, p(-24, y + 2.4, 33.2), p(2.4, 1.6, 1.4), 'darkMetal', false);
          box(r, p(-24, y + 2.4, 32.45), p(1.9, 1.1, 0.12), 'emissive', false, { emissive: LAMP });
        }
      }
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(r, p(sx * 33.8, 0, sz * 33.8), p(1.6, H, 1.6), 'darkMetal', true);
    for (const x of [27.5, 31.5]) box(r, p(x, 0, 34.3), p(0.4, H, 0.4), 'metal', false);
    for (let y = floor + 2; y < ceil - 1; y += 2.5) box(r, p(29.5, y, 34.3), p(4, 0.35, 0.35), 'metal', false);
    box(r, p(34.4, 0, -20), p(0.6, H, 2.6), 'darkMetal', false);
    for (const dz of [-0.7, 0, 0.7]) box(r, p(34.0, 0, -20 + dz), p(0.3, H, 0.3), 'darkMetal', false);
    box(r, p(0, floor + 0.2, 0), p(66, 0.4, 66), 'grate', false, { emissive: r.landmark });
    ring(r, p(0, ceil - 4, 0), 20, 1.2, 'y', 'darkMetal');
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8;
      beam(r, p(Math.cos(a) * 11.8, ceil - 4, Math.sin(a) * 11.8), p(Math.cos(a) * 20, ceil - 4, Math.sin(a) * 20), 1.2, 'darkMetal');
    }
  }

  // ---------------------------------------------------------------- Crystal Gallery: a natural cave, crystals, a miners' scaffold
  {
    const r = roomById('gallery');
    const H = r.size.y, floor = -H / 2, ceil = H / 2;
    const lanes = doorLanes(r, 26, 4);
    props.push({ room: r.id, kind: 'rock', center: at(r, 0, 0, 0), radius: 10, seed: 4242, collides: true, material: 'ore', emissive: r.landmark });
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
      props.push({ room: r.id, kind: 'pillar', center: at(r, c.x, 0, c.z), radius: rad, height: H + 6, seed: rng.int(1, 1e9), collides: true, material: 'ore', emissive: r.landmark });
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

    // what's already standing, room-relative, so the dressing below keeps clear of it
    const cols = props.filter((q) => q.room === r.id && q.kind === 'pillar').map((q) => ({ x: q.center.x - r.center.x, z: q.center.z - r.center.z, rad: (q as { radius: number }).radius }));
    const shards = props.filter((q) => q.room === r.id && q.kind === 'crystal').map((q) => {
      const k = q as Extract<Prop, { kind: 'crystal' }>;
      return { a: p(k.center.x - r.center.x, k.center.y - r.center.y, k.center.z - r.center.z), d: k.dir, len: k.length, rad: k.radius };
    });
    // a timber scaffold goes against whichever stretch of the back wall the pillars leave free
    const zc = [0, -20, 20, -34, 34].find((z) => cols.every((q) => q.x - q.rad > -46 || Math.abs(q.z - z) > 17 + q.rad));
    const clear = (c: V3, rad: number) =>
      (zc === undefined || c.x - rad > -47 || Math.abs(c.z - zc) > 17 + rad)
      && cols.every((q) => Math.hypot(q.x - c.x, q.z - c.z) > q.rad + rad + 2)
      && Math.hypot(c.x, c.y, c.z) > 10 + rad + 3
      && shards.every((s) => {
        const t = Math.max(0, Math.min(s.len, (c.x - s.a.x) * s.d.x + (c.y - s.a.y) * s.d.y + (c.z - s.a.z) * s.d.z));
        return Math.hypot(s.a.x + s.d.x * t - c.x, s.a.y + s.d.y * t - c.y, s.a.z + s.d.z * t - c.z) > s.rad + rad + 2;
      });
    const spikes: { x: number; z: number; rad: number; up: boolean }[] = [];
    for (const [up, want] of [[false, 18], [true, 10]] as const) {
      let placed = 0;
      for (let tries = 0; placed < want && tries < 800; tries++) {
        const x = deco.range(-54, 54), z = deco.range(-54, 54);
        const len = up ? deco.range(5, 11) : deco.range(7, 16), rad = up ? deco.range(2, 3.4) : deco.range(1.8, 3.2);
        const tx = deco.range(-0.15, 0.15), tz = deco.range(-0.15, 0.15), l = Math.hypot(tx, 1, tz);
        const dir = p(tx / l, (up ? 1 : -1) / l, tz / l);
        const base = p(x, up ? floor + 0.6 : ceil - 0.6, z);
        const tip = p(base.x + dir.x * len, base.y + dir.y * len, base.z + dir.z * len);
        if (segmentHitsLanes(base, tip, rad + 2, lanes)) continue;
        if (![0, 0.5, 1].every((t) => clear(p(base.x + dir.x * len * t, base.y + dir.y * len * t, base.z + dir.z * len * t), rad * (1 - 0.7 * t)))) continue;
        if (spikes.some((s) => s.up === up && Math.hypot(s.x - x, s.z - z) < s.rad + rad + 4)) continue;
        spikes.push({ x, z, rad, up });
        props.push({ room: r.id, kind: 'spike', center: at(r, base.x, base.y, base.z), dir, length: len, radius: rad, seed: deco.int(1, 1e9), collides: true, material: 'ore', emissive: r.landmark });
        placed++;
      }
    }
    // rubble on the floor
    for (let i = 0, n = 0; n < 26 && i < 400; i++) {
      const c = p(deco.range(-56, 56), floor + 0.2, deco.range(-56, 56));
      const rad = deco.range(0.8, 2.2);
      if (!clear(c, rad)) continue;
      ore(r, c, rad, 0.55, false);
      n++;
    }
    // lantern strings slung between neighboring pillars
    const bulb = 0xe2d8ff;
    const pairs: [number, number][] = [];
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
      const d = Math.hypot(cols[i]!.x - cols[j]!.x, cols[i]!.z - cols[j]!.z);
      if (d < 62) pairs.push([i, j]);
    }
    let strings = 0;
    for (const [i, j] of pairs) {
      if (strings >= 4) break;
      const A = cols[i]!, B = cols[j]!, d = Math.hypot(A.x - B.x, A.z - B.z);
      const ux = (B.x - A.x) / d, uz = (B.z - A.z) / d, y = 8 + strings * 3;
      const a = p(A.x + ux * A.rad * 0.6, y, A.z + uz * A.rad * 0.6), b = p(B.x - ux * B.rad * 0.6, y, B.z - uz * B.rad * 0.6);
      const span = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(3, Math.round(span / 5)), sag = span * 0.08;
      const pts: V3[] = [];
      for (let k = 0; k <= n; k++) { const t = k / n; pts.push(p(a.x + (b.x - a.x) * t, y - sag * 4 * t * (1 - t), a.z + (b.z - a.z) * t)); }
      if (!pts.slice(1, -1).every((q) => clear(q, 0.5))) continue;
      for (let k = 1; k <= n; k++) {
        beam(r, pts[k - 1]!, pts[k]!, 0.15, 'darkMetal');
        if (k < n) box(r, p(pts[k]!.x, pts[k]!.y - 0.7, pts[k]!.z), p(0.6, 0.9, 0.6), 'emissive', false, { emissive: bulb });
      }
      strings++;
    }
    if (zc !== undefined) {
      const xs = [-58.5, -50.5], zs = [-15, -5, 5, 15].map((d) => zc + d), levels = [floor + 14, floor + 28, floor + 42];
      for (const x of xs) for (const z of zs) box(r, p(x, (floor + levels[2]! + 3) / 2, z), p(0.9, levels[2]! + 3 - floor, 0.9), 'timber', true);
      for (const y of levels) {
        box(r, p(-54.5, y, zc), p(9.6, 0.7, 31.5), 'timber', true);
        railing(r, p(-49.9, y + 0.35, zc - 15), p(-49.9, y + 0.35, zc + 15));
        box(r, p(-51, y - 1.2, zc + 9), p(0.6, 0.9, 0.6), 'emissive', false, { emissive: bulb });
      }
      for (let k = 0; k < 3; k++) {
        const z0 = zs[k]!, z1 = zs[k + 1]!;
        beam(r, p(-50.5, floor + 0.5, z0), p(-50.5, levels[0]!, z1), 0.5, 'timber');
        beam(r, p(-50.5, levels[0]!, z0), p(-50.5, levels[1]!, z1), 0.5, 'timber');
      }
      for (const [dz, y] of [[-9, levels[0]!], [4, levels[1]!], [-2, levels[2]!]] as const) {
        box(r, p(-55, y + 1.85, zc + dz), p(3, 3, 3), 'timber', false, { rotY: deco.range(-0.4, 0.4) });
      }
    }
  }

  // ---------------------------------------------------------------- Ore Crusher: toothed rolls under a hopper, conveyors, ore heaps
  {
    const r = roomById('crusher');
    const floor = -r.size.y / 2, ceil = r.size.y / 2;
    for (const z of [-30, 30]) {
      // 58 m rather than 60 m so the end caps stay out of the T10 doorway clearance zone
      cyl(r, p(0, -15, z), 10, 58, 'x', 'darkMetal', true);
      for (const x of [-28.6, 28.6]) ring(r, p(x, -15, z), 10.2, 0.6, 'x', 'metal');
      for (let k = 0; k < 14; k++) {
        const th = (k / 14) * Math.PI * 2;
        const ty = -15 + Math.sin(th) * 10.1;
        if (ty < floor + 1.5) continue;
        box(r, p(0, ty, z + Math.cos(th) * 10.1), p(56, 0.9, 1.6), 'metal', false, { rotX: Math.PI / 2 - th });
      }
      for (const sx of [-1, 1]) {
        box(r, p(sx * 31.5, -20.5, z), p(5, 9, 9), 'metal', true);
        cyl(r, p(sx * 31.5, -15, z), 2, 6.4, 'x', 'darkMetal', false);
      }
    }
    // the feed hopper hung from the roof, and the inclined belt that fills it
    box(r, p(0, 21.5, 0), p(34, 7, 26), 'darkMetal', true);
    box(r, p(0, 18.9, 0), p(34.3, 1.2, 26.3), 'hazard', false);
    box(r, p(0, 15, 0), p(24, 6, 16), 'darkMetal', true);
    box(r, p(0, 10, 0), p(10, 4, 7), 'darkMetal', true);
    for (let x = -14; x <= 14; x += 4) for (const s of [-1, 1]) box(r, p(x, 21.5, s * 13.1), p(0.5, 7, 0.4), 'metal', false);
    {
      const a = p(0, 4, -49), b = p(0, 20, -13.5);
      const dy = b.y - a.y, dz = b.z - a.z, len = Math.hypot(dy, dz), tilt = -Math.atan2(dy, dz);
      const mid = p(0, (a.y + b.y) / 2, (a.z + b.z) / 2);
      // unit normal of the belt's top face
      const ny = dz / len, nz = -dy / len;
      box(r, mid, p(6, 1.2, len), 'darkMetal', true, { rotX: tilt });
      for (const sx of [-3.2, 3.2]) box(r, p(sx, mid.y + ny * 0.7, mid.z + nz * 0.7), p(0.4, 2, len), 'metal', false, { rotX: tilt });
      for (let t = 0.08; t < 0.95; t += 0.09) {
        ore(r, p(deco.range(-1.5, 1.5), a.y + dy * t + ny * 1.1, a.z + dz * t + nz * 1.1), deco.range(0.7, 1.1), 0.7, false);
      }
      for (const t of [0.3, 0.68]) {
        const y = a.y + dy * t + 1.2;
        for (const sx of [-3.2, 3.2]) cyl(r, p(sx, (y + ceil) / 2, a.z + dz * t), 0.2, ceil - y, 'y', 'darkMetal', false);
      }
    }
    // discharge belts between the rolls
    for (const x of [-12, 12]) {
      box(r, p(x, floor + 1, 0), p(8, 2, 40), 'darkMetal', true);
      for (const s of [-1, 1]) box(r, p(x + s * 4.2, floor + 2.6, 0), p(0.4, 1.6, 40), 'metal', false);
      for (let z = -17; z <= 17; z += 4.5) ore(r, p(x + deco.range(-2, 2), floor + 2.4, z), deco.range(0.7, 1.2), 0.7, false);
    }
    for (const [x, z] of [[-38, -40], [38, 40], [40, -38], [-40, 40]] as const) {
      props.push({ room: r.id, kind: 'rock', center: at(r, x, floor, z), radius: 7, squash: 0.45, seed: rng.int(1, 1e9), collides: true, material: 'ore', emissive: r.landmark });
      for (let i = 0; i < 5; i++) {
        const a = deco.range(0, Math.PI * 2), d = deco.range(7, 10);
        ore(r, p(x + Math.cos(a) * d, floor + 0.3, z + Math.sin(a) * d), deco.range(0.9, 2), 0.6, false);
      }
    }
    for (const [x, z] of [[-49.4, -20], [-49.4, 20], [49.4, -20], [49.4, 20], [-20, -49.4], [20, 49.4]] as const) {
      box(r, p(x, 18, z), p(1, 1, 1), 'emissive', false, { emissive: r.landmark, pulse: 0.9 });
    }
    for (const [x, z] of [[-32, -32], [32, -32], [-32, 32], [32, 32]] as const) lamp(r, x, z, 1.5);
    wallFrame(r, [-40, -14, 14, 40], [-40, -14, 14, 40], 20);
  }
  return props;
}

export const BLUEPRINT_SEED = 0x0a11ce;
export function hollowdeep(): Blueprint {
  return { id: 'hollowdeep', name: 'Hollowdeep Mine', rooms: ROOMS, tunnels: TUNNELS, props: buildProps(BLUEPRINT_SEED), seed: BLUEPRINT_SEED };
}

import { v3, type V3 } from '../math.js';
import type { Blueprint, Mover, Prop, Room, SafeZone, Theme, Tunnel } from './blueprint.js';
import { moverClearance, moverSweeps, type Sweep } from './movers.js';

export type Axis = 0 | 1 | 2;
export const getA = (v: V3, a: Axis) => (a === 0 ? v.x : a === 1 ? v.y : v.z);
export const setA = (v: V3, a: Axis, n: number) => { if (a === 0) v.x = n; else if (a === 1) v.y = n; else v.z = n; };

/** The visible interior-facing rectangle of a slab. u = (axis+1)%3, v = (axis+2)%3. */
export interface Face { axis: Axis; normalSign: 1 | -1; plane: number; uMin: number; uMax: number; vMin: number; vMax: number }
export interface Slab { owner: string; theme: Theme; center: V3; half: V3; face: Face }
export interface Box { min: V3; max: V3 }
export interface Doorway {
  id: string; tunnel: Tunnel; room: Room; end: 'a' | 'b'; axis: Axis; side: 1 | -1;
  center: V3; size: number; /** unit normal pointing into the room */ inward: V3;
}
export interface Segment { tunnel: Tunnel; index: number; a: V3; b: V3; axis: Axis; box: Box }
export interface Elbow { tunnel: Tunnel; index: number; center: V3; box: Box; openings: { axis: Axis; sign: 1 | -1 }[] }
/** `spacing` is the minimum gap to other pickups (default 25 m). */
export interface OrangeRegion { id: string; box: Box; weight: number; bonus: boolean; spacing?: number }
export interface SpawnPoint { pos: V3; facing: V3; room: string }

export interface ArenaData {
  blueprint: Blueprint;
  slabs: Slab[];
  doorways: Doorway[];
  segments: Segment[];
  elbows: Elbow[];
  regions: OrangeRegion[];
  spawns: SpawnPoint[];
  roomBoxes: Map<string, Box>;
  /** room id -> adjacent rooms via tunnels */
  adjacency: Map<string, { room: string; tunnel: string }[]>;
  bounds: Box;
  movers: Mover[];
  /** every volume a mover can pass through, for keeping nav links, spawns and pickups out of the way */
  sweeps: Sweep[];
  safeZones: SafeZone[];
}

export function roomBox(r: Room): Box {
  return {
    min: v3(r.center.x - r.size.x / 2, r.center.y - r.size.y / 2, r.center.z - r.size.z / 2),
    max: v3(r.center.x + r.size.x / 2, r.center.y + r.size.y / 2, r.center.z + r.size.z / 2),
  };
}

export function boxOverlap(a: Box, b: Box, eps = 0.01): boolean {
  return a.min.x < b.max.x - eps && a.max.x > b.min.x + eps
    && a.min.y < b.max.y - eps && a.max.y > b.min.y + eps
    && a.min.z < b.max.z - eps && a.max.z > b.min.z + eps;
}
export function boxContains(b: Box, p: V3, margin = 0): boolean {
  return p.x >= b.min.x - margin && p.x <= b.max.x + margin && p.y >= b.min.y - margin && p.y <= b.max.y + margin
    && p.z >= b.min.z - margin && p.z <= b.max.z + margin;
}
function slabBox(s: Slab): Box {
  return {
    min: v3(s.center.x - s.half.x, s.center.y - s.half.y, s.center.z - s.half.z),
    max: v3(s.center.x + s.half.x, s.center.y + s.half.y, s.center.z + s.half.z),
  };
}

function makeSlab(owner: string, theme: Theme, axis: Axis, plane: number, sign: 1 | -1, thick: number,
  u: [number, number], v: [number, number], face: Face): Slab {
  const lo = v3(), hi = v3();
  const ua = ((axis + 1) % 3) as Axis, va = ((axis + 2) % 3) as Axis;
  setA(lo, axis, Math.min(plane, plane + sign * thick)); setA(hi, axis, Math.max(plane, plane + sign * thick));
  setA(lo, ua, u[0]); setA(hi, ua, u[1]);
  setA(lo, va, v[0]); setA(hi, va, v[1]);
  return {
    owner, theme,
    center: v3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2),
    half: v3((hi.x - lo.x) / 2, (hi.y - lo.y) / 2, (hi.z - lo.z) / 2),
    face,
  };
}

function axisOfSegment(a: V3, b: V3): Axis {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), dz = Math.abs(b.z - a.z);
  const n = (dx > 0.001 ? 1 : 0) + (dy > 0.001 ? 1 : 0) + (dz > 0.001 ? 1 : 0);
  if (n !== 1) throw new Error(`Tunnel segment not axis-aligned: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return dx > 0.001 ? 0 : dy > 0.001 ? 1 : 2;
}

/** Find the room face a tunnel endpoint lies on. */
function findFace(room: Room, p: V3): { axis: Axis; side: 1 | -1 } | null {
  for (const axis of [0, 1, 2] as Axis[]) {
    const c = getA(room.center, axis), h = getA(room.size, axis) / 2;
    for (const side of [1, -1] as const) {
      if (Math.abs(getA(p, axis) - (c + side * h)) < 0.01) return { axis, side };
    }
  }
  return null;
}

/** Subtract holes from a rectangle and greedily merge remaining cells into maximal rectangles. */
export function rectMinusHoles(
  u: [number, number], v: [number, number], holes: { u: [number, number]; v: [number, number] }[],
): { u: [number, number]; v: [number, number] }[] {
  const us = new Set<number>([u[0], u[1]]), vs = new Set<number>([v[0], v[1]]);
  for (const h of holes) {
    for (const x of h.u) if (x > u[0] && x < u[1]) us.add(x);
    for (const y of h.v) if (y > v[0] && y < v[1]) vs.add(y);
  }
  const U = [...us].sort((a, b) => a - b), V = [...vs].sort((a, b) => a - b);
  const nu = U.length - 1, nv = V.length - 1;
  const solid: boolean[][] = [];
  for (let i = 0; i < nu; i++) {
    solid.push([]);
    for (let j = 0; j < nv; j++) {
      const cu = (U[i]! + U[i + 1]!) / 2, cv = (V[j]! + V[j + 1]!) / 2;
      solid[i]!.push(!holes.some((h) => cu > h.u[0] && cu < h.u[1] && cv > h.v[0] && cv < h.v[1]));
    }
  }
  const used = solid.map((row) => row.map(() => false));
  const out: { u: [number, number]; v: [number, number] }[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      if (!solid[i]![j] || used[i]![j]) continue;
      let i2 = i;
      while (i2 + 1 < nu && solid[i2 + 1]![j] && !used[i2 + 1]![j]) i2++;
      let j2 = j;
      outer: while (j2 + 1 < nv) {
        for (let k = i; k <= i2; k++) if (!solid[k]![j2 + 1] || used[k]![j2 + 1]) break outer;
        j2++;
      }
      for (let k = i; k <= i2; k++) for (let m = j; m <= j2; m++) used[k]![m] = true;
      out.push({ u: [U[i]!, U[i2 + 1]!], v: [V[j]!, V[j2 + 1]!] });
    }
  }
  return out;
}

export function generateArena(bp: Blueprint): ArenaData {
  const slabs: Slab[] = [];
  const doorways: Doorway[] = [];
  const segments: Segment[] = [];
  const elbows: Elbow[] = [];
  const roomBoxes = new Map<string, Box>();
  for (const r of bp.rooms) roomBoxes.set(r.id, roomBox(r));

  // 1. Doorways
  for (const t of bp.tunnels) {
    for (const end of ['a', 'b'] as const) {
      const p = end === 'a' ? t.path[0]! : t.path[t.path.length - 1]!;
      const room = bp.rooms.find((r) => r.id === (end === 'a' ? t.a : t.b));
      if (!room) throw new Error(`Tunnel ${t.id} references missing room`);
      const f = findFace(room, p);
      if (!f) throw new Error(`Tunnel ${t.id} endpoint ${end} not on a face of ${room.id}`);
      const inward = v3(); setA(inward, f.axis, -f.side);
      doorways.push({ id: `${t.id}:${end}`, tunnel: t, room, end, axis: f.axis, side: f.side, center: { ...p }, size: t.side, inward });
    }
  }

  // 2. Room walls
  for (const r of bp.rooms) {
    for (const axis of [0, 1, 2] as Axis[]) {
      const ua = ((axis + 1) % 3) as Axis, va = ((axis + 2) % 3) as Axis;
      const cu = getA(r.center, ua), hu = getA(r.size, ua) / 2;
      const cv = getA(r.center, va), hv = getA(r.size, va) / 2;
      for (const side of [1, -1] as const) {
        const plane = getA(r.center, axis) + side * getA(r.size, axis) / 2;
        const holes = doorways.filter((d) => d.room === r && d.axis === axis && d.side === side).map((d) => ({
          u: [getA(d.center, ua) - d.size / 2, getA(d.center, ua) + d.size / 2] as [number, number],
          v: [getA(d.center, va) - d.size / 2, getA(d.center, va) + d.size / 2] as [number, number],
        }));
        const U: [number, number] = [cu - hu, cu + hu], V: [number, number] = [cv - hv, cv + hv];
        for (const rect of rectMinusHoles(U, V, holes)) {
          const ext = (range: [number, number], full: [number, number]): [number, number] => [
            range[0] <= full[0] + 1e-6 ? range[0] - r.wall : range[0],
            range[1] >= full[1] - 1e-6 ? range[1] + r.wall : range[1],
          ];
          const face: Face = { axis, normalSign: (-side) as 1 | -1, plane, uMin: rect.u[0], uMax: rect.u[1], vMin: rect.v[0], vMax: rect.v[1] };
          slabs.push(makeSlab(r.id, r.theme, axis, plane, side, r.wall, ext(rect.u, U), ext(rect.v, V), face));
        }
      }
    }
  }

  // 3–5. Tunnel segments and elbows
  for (const t of bp.tunnels) {
    const W = 4, hs = t.side / 2;
    const n = t.path.length;
    for (let i = 0; i < n - 1; i++) {
      const a = t.path[i]!, b = t.path[i + 1]!;
      const axis = axisOfSegment(a, b);
      let lo = Math.min(getA(a, axis), getA(b, axis)), hi = Math.max(getA(a, axis), getA(b, axis));
      const aIsElbow = i > 0, bIsElbow = i + 1 < n - 1;
      const aLow = getA(a, axis) < getA(b, axis);
      if (aIsElbow) { if (aLow) lo += hs; else hi -= hs; }
      if (bIsElbow) { if (aLow) hi -= hs; else lo += hs; }
      const box: Box = { min: v3(a.x - hs, a.y - hs, a.z - hs), max: v3(a.x + hs, a.y + hs, a.z + hs) };
      setA(box.min, axis, lo); setA(box.max, axis, hi);
      segments.push({ tunnel: t, index: i, a, b, axis, box });
      for (const pa of [0, 1, 2] as Axis[]) {
        if (pa === axis) continue;
        const other = (3 - axis - pa) as Axis;
        for (const sgn of [1, -1] as const) {
          const plane = getA(a, pa) + sgn * hs;
          const ua = ((pa + 1) % 3) as Axis;
          const oc = getA(a, other);
          const alongA: [number, number] = [lo, hi];
          const alongO: [number, number] = [oc - hs - W, oc + hs + W];
          const faceO: [number, number] = [oc - hs, oc + hs];
          const [uR, vR] = ua === axis ? [alongA, alongO] : [alongO, alongA];
          const [fu, fv] = ua === axis ? [alongA, faceO] : [faceO, alongA];
          const face: Face = { axis: pa, normalSign: (-sgn) as 1 | -1, plane, uMin: fu[0], uMax: fu[1], vMin: fv[0], vMax: fv[1] };
          slabs.push(makeSlab(t.id, t.theme, pa, plane, sgn, W, uR, vR, face));
        }
      }
    }
    for (let i = 1; i < n - 1; i++) {
      const e = t.path[i]!, prev = t.path[i - 1]!, next = t.path[i + 1]!;
      const openings: { axis: Axis; sign: 1 | -1 }[] = [];
      for (const q of [prev, next]) {
        const ax = axisOfSegment(e, q);
        openings.push({ axis: ax, sign: getA(q, ax) > getA(e, ax) ? 1 : -1 });
      }
      const box: Box = { min: v3(e.x - hs, e.y - hs, e.z - hs), max: v3(e.x + hs, e.y + hs, e.z + hs) };
      elbows.push({ tunnel: t, index: i, center: e, box, openings });
      for (const axis of [0, 1, 2] as Axis[]) {
        for (const sgn of [1, -1] as const) {
          if (openings.some((o) => o.axis === axis && o.sign === sgn)) continue;
          const plane = getA(e, axis) + sgn * hs;
          const ua = ((axis + 1) % 3) as Axis, va = ((axis + 2) % 3) as Axis;
          const cu = getA(e, ua), cv = getA(e, va);
          const face: Face = { axis, normalSign: (-sgn) as 1 | -1, plane, uMin: cu - hs, uMax: cu + hs, vMin: cv - hs, vMax: cv + hs };
          slabs.push(makeSlab(t.id, t.theme, axis, plane, sgn, W, [cu - hs - W, cu + hs + W], [cv - hs - W, cv + hs + W], face));
        }
      }
    }
  }

  // Orange regions (Section 15.6)
  const regions: OrangeRegion[] = [];
  const roomWeight = bp.oranges?.roomWeight ?? 1;
  for (const r of bp.rooms) {
    const b = roomBox(r);
    const box: Box = { min: v3(b.min.x + 12, b.min.y + 12, b.min.z + 12), max: v3(b.max.x - 12, b.max.y - 12, b.max.z - 12) };
    const vol = (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
    regions.push({ id: r.id, box, weight: (Math.sqrt(vol) / 100) * roomWeight, bonus: false });
  }
  for (const s of segments) {
    const len = getA(s.box.max, s.axis) - getA(s.box.min, s.axis);
    const stuffed = s.tunnel.oranges !== undefined;
    if (len <= (stuffed ? 20 : 60)) continue;
    const box: Box = { min: v3(s.box.min.x + 4, s.box.min.y + 4, s.box.min.z + 4), max: v3(s.box.max.x - 4, s.box.max.y - 4, s.box.max.z - 4) };
    regions.push({
      id: `${s.tunnel.id}#${s.index}`, box, weight: s.tunnel.oranges ?? 1.0, bonus: !!s.tunnel.bonus,
      ...(stuffed ? { spacing: 8 } : {}),
    });
  }

  // Spawn candidates (validated against physics in physicsWorld)
  const spawns: SpawnPoint[] = [];
  const safeZones = bp.safeZones ?? [];
  for (const sp of safeZones.length ? [] : bp.spawns ?? []) {
    const r = bp.rooms.find((x) => x.id === sp.room);
    if (!r) throw new Error(`Spawn references missing room ${sp.room}`);
    spawns.push({ pos: { ...sp.pos }, facing: v3(r.center.x - sp.pos.x, 0, r.center.z - sp.pos.z), room: r.id });
  }
  for (const z of safeZones) {
    const r = bp.rooms.find((x) => x.id === z.room);
    if (!r) continue;
    for (const deg of [90, 210, 330]) {
      const a = (deg * Math.PI) / 180, off = z.radius * 0.4;
      const pos = v3(z.center.x + Math.cos(a) * off, z.center.y, z.center.z + Math.sin(a) * off);
      spawns.push({ pos, facing: v3(r.center.x - pos.x, 0, r.center.z - pos.z), room: r.id });
    }
  }
  for (const r of safeZones.length || bp.spawns ? [] : bp.rooms) {
    const dirs: V3[] = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1), v3(1, 0, 1), v3(-1, 0, -1), v3(1, 0, -1), v3(-1, 0, 1)];
    const doorFaces = doorways.filter((d) => d.room === r && d.axis !== 1).map((d) => ({ axis: d.axis, side: d.side }));
    const scored = dirs.map((d, i) => {
      const blocked = doorFaces.some((f) => (f.axis === 0 ? d.x : d.z) === f.side && (d.x === 0 || d.z === 0));
      return { d, score: (blocked ? 100 : 0) + (d.x !== 0 && d.z !== 0 ? 1 : 0) + i * 0.01 };
    }).sort((a, b) => a.score - b.score);
    for (const { d } of scored.slice(0, 3)) {
      const pos = v3(r.center.x + d.x * r.size.x * 0.35, r.center.y, r.center.z + d.z * r.size.z * 0.35);
      const facing = v3(r.center.x - pos.x, 0, r.center.z - pos.z);
      spawns.push({ pos, facing, room: r.id });
    }
  }

  const adjacency = new Map<string, { room: string; tunnel: string }[]>();
  for (const r of bp.rooms) adjacency.set(r.id, []);
  for (const t of bp.tunnels) {
    adjacency.get(t.a)!.push({ room: t.b, tunnel: t.id });
    adjacency.get(t.b)!.push({ room: t.a, tunnel: t.id });
  }

  const bounds: Box = { min: v3(Infinity, Infinity, Infinity), max: v3(-Infinity, -Infinity, -Infinity) };
  for (const s of slabs) {
    const b = slabBox(s);
    bounds.min.x = Math.min(bounds.min.x, b.min.x); bounds.min.y = Math.min(bounds.min.y, b.min.y); bounds.min.z = Math.min(bounds.min.z, b.min.z);
    bounds.max.x = Math.max(bounds.max.x, b.max.x); bounds.max.y = Math.max(bounds.max.y, b.max.y); bounds.max.z = Math.max(bounds.max.z, b.max.z);
  }

  const movers = bp.movers ?? [];
  const sweeps = movers.flatMap(moverSweeps);
  return { blueprint: bp, slabs, doorways, segments, elbows, regions, spawns, roomBoxes, adjacency, bounds, movers, sweeps, safeZones };
}

/** Distance from a point to the nearest point of a box (0 inside). */
export function boxDistance(b: Box, p: V3): number {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

/** The safe zone containing `p`, if any. */
export function safeZoneAt(a: ArenaData, p: V3): SafeZone | null {
  for (const z of a.safeZones) {
    const dx = p.x - z.center.x, dy = p.y - z.center.y, dz = p.z - z.center.z;
    if (dx * dx + dy * dy + dz * dz <= z.radius * z.radius) return z;
  }
  return null;
}

/** Interior boxes for every tunnel piece. */
export function tunnelPieces(a: ArenaData): { tunnel: string; box: Box; key: string; order: number }[] {
  const out: { tunnel: string; box: Box; key: string; order: number }[] = [];
  for (const s of a.segments) out.push({ tunnel: s.tunnel.id, box: s.box, key: `${s.tunnel.id}/s${s.index}`, order: s.index * 2 });
  for (const e of a.elbows) out.push({ tunnel: e.tunnel.id, box: e.box, key: `${e.tunnel.id}/e${e.index}`, order: e.index * 2 - 1 });
  return out;
}

/** Pure geometric validations (Section 15.2 step 8). Physics-based checks live in physicsWorld. */
export function validateArenaGeometry(a: ArenaData): string[] {
  const errors: string[] = [];
  const pieces = tunnelPieces(a);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const p = pieces[i]!, q = pieces[j]!;
      if (p.tunnel === q.tunnel && Math.abs(p.order - q.order) <= 1) continue;
      if (boxOverlap(p.box, q.box)) errors.push(`tunnel overlap ${p.key} x ${q.key}`);
    }
    for (const [rid, rb] of a.roomBoxes) {
      if (boxOverlap(pieces[i]!.box, rb)) errors.push(`tunnel ${pieces[i]!.key} overlaps room ${rid}`);
    }
  }
  const interiors: { key: string; box: Box }[] = [
    ...[...a.roomBoxes].map(([k, box]) => ({ key: `room:${k}`, box })),
    ...pieces.map((p) => ({ key: p.key, box: p.box })),
  ];
  for (const s of a.slabs) {
    const sb = slabBox(s);
    for (const it of interiors) if (boxOverlap(sb, it.box, 0.05)) errors.push(`slab of ${s.owner} intrudes into ${it.key}`);
  }
  for (const d of a.doorways) {
    const ua = ((d.axis + 1) % 3) as Axis, va = ((d.axis + 2) % 3) as Axis;
    const rb = a.roomBoxes.get(d.room.id)!;
    for (const ax of [ua, va]) {
      const c = getA(d.center, ax);
      if (c - d.size / 2 < getA(rb.min, ax) - 1e-6 || c + d.size / 2 > getA(rb.max, ax) + 1e-6) {
        errors.push(`doorway ${d.id} not inside face of ${d.room.id}`);
      }
    }
  }
  // connectivity
  const rooms = a.blueprint.rooms.map((r) => r.id);
  const seen = new Set<string>([rooms[0]!]);
  const stack = [rooms[0]!];
  while (stack.length) {
    const r = stack.pop()!;
    for (const n of a.adjacency.get(r)!) if (!seen.has(n.room)) { seen.add(n.room); stack.push(n.room); }
  }
  for (const r of rooms) if (!seen.has(r)) errors.push(`room ${r} unreachable`);
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    const n = countRoutes(a, rooms[i]!, rooms[j]!);
    if (n < 3) errors.push(`only ${n} routes between ${rooms[i]} and ${rooms[j]}`);
  }
  // props must sit inside their room and outside doorway clearance zones (checked precisely with physics)
  for (const p of a.blueprint.props) {
    const rb = a.roomBoxes.get(p.room);
    if (!rb) { errors.push(`prop in unknown room ${p.room}`); continue; }
    if (!boxContains(rb, p.center, 0.5)) errors.push(`prop ${p.kind} outside room ${p.room}`);
    if (p.spin && p.collides) errors.push(`spinning ${p.kind} in ${p.room} must not collide`);
  }
  for (const s of a.spawns) if (!boxContains(a.roomBoxes.get(s.room)!, s.pos)) errors.push(`spawn outside room ${s.room}`);
  // movers: sweeping against walls, doors and each other is checked with physics (validateMovers)
  for (const m of a.movers) {
    const rb = a.roomBoxes.get(m.room);
    if (!rb) errors.push(`mover ${m.id} in unknown room ${m.room}`);
    else if (!boxContains(rb, m.origin)) errors.push(`mover ${m.id} origin outside room ${m.room}`);
  }
  for (const z of a.safeZones) {
    const rb = a.roomBoxes.get(z.room);
    if (!rb) { errors.push(`safe zone ${z.id} in unknown room ${z.room}`); continue; }
    const inner: Box = { min: v3(rb.min.x + z.radius + 2, rb.min.y + z.radius + 2, rb.min.z + z.radius + 2), max: v3(rb.max.x - z.radius - 2, rb.max.y - z.radius - 2, rb.max.z - z.radius - 2) };
    if (!boxContains(inner, z.center)) errors.push(`safe zone ${z.id} does not fit inside ${z.room}`);
    for (const d of a.doorways) if (boxDistance(doorClearanceBox(d), z.center) < z.radius) errors.push(`safe zone ${z.id} blocks doorway ${d.id}`);
    if (moverClearance(a.sweeps, z.center) < z.radius + 6) errors.push(`safe zone ${z.id} is in a mover's path`);
  }
  for (const s of a.spawns) if (moverClearance(a.sweeps, s.pos) < 20) errors.push(`spawn in ${s.room} is within 20 m of a mover's path`);
  return errors;
}

/** Number of simple room-paths (tunnel sequences, no repeated room) between two rooms. */
export function countRoutes(a: ArenaData, from: string, to: string): number {
  let count = 0;
  const visited = new Set<string>([from]);
  const dfs = (r: string) => {
    for (const n of a.adjacency.get(r)!) {
      if (n.room === to) { count++; continue; }
      if (visited.has(n.room)) continue;
      visited.add(n.room); dfs(n.room); visited.delete(n.room);
    }
  };
  dfs(from);
  return count;
}

/** Door clearance zone: door rect extruded `depth` meters into the room, shrunk by `shrink`. */
export function doorClearanceBox(d: Doorway, depth = 20, shrink = 0.5): Box {
  const hs = d.size / 2 - shrink;
  const min = v3(d.center.x - hs, d.center.y - hs, d.center.z - hs);
  const max = v3(d.center.x + hs, d.center.y + hs, d.center.z + hs);
  const plane = getA(d.center, d.axis);
  const inner = plane - d.side * depth, outer = plane - d.side * shrink;
  setA(min, d.axis, Math.min(inner, outer)); setA(max, d.axis, Math.max(inner, outer));
  return { min, max };
}

export type Place = { kind: 'room'; id: string; name: string } | { kind: 'tunnel'; id: string; name: string };
/** Which room or tunnel contains the point (for HUD location and light/PVS selection). */
export function placeAt(a: ArenaData, p: V3): Place | null {
  for (const r of a.blueprint.rooms) if (boxContains(a.roomBoxes.get(r.id)!, p, 0.5)) return { kind: 'room', id: r.id, name: r.name };
  for (const s of a.segments) if (boxContains(s.box, p, 2)) return { kind: 'tunnel', id: s.tunnel.id, name: tunnelName(a, s.tunnel) };
  for (const e of a.elbows) if (boxContains(e.box, p, 2)) return { kind: 'tunnel', id: e.tunnel.id, name: tunnelName(a, e.tunnel) };
  return null;
}
export function tunnelName(a: ArenaData, t: Tunnel): string {
  if (t.label === 'The Sewer') return 'The Sewer';
  const an = a.blueprint.rooms.find((r) => r.id === t.a)!.name, bn = a.blueprint.rooms.find((r) => r.id === t.b)!.name;
  return `${t.id} · ${an} ↔ ${bn}`;
}

export type { Prop };

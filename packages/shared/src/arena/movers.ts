import { DT } from '../constants.js';
import { q4, qfromAxisAngle, qrot, segmentPointDistSq, v3, type Q4, type V3 } from '../math.js';
import { boxRotation, type Mover, type Prop } from './blueprint.js';

const AXIS: Record<'x' | 'y' | 'z', V3> = { x: v3(1, 0, 0), y: v3(0, 1, 0), z: v3(0, 0, 1) };

/** Body pose of a mover at a (possibly fractional) tick. Parts sit at `part.center - origin` in body space. */
export function moverPose(m: Mover, tick: number, pos: V3, rot: Q4): void {
  const mo = m.motion;
  const u = (tick * DT) / mo.period + (mo.phase ?? 0);
  const f = u - Math.floor(u);
  if (mo.kind === 'spin') {
    pos.x = m.origin.x; pos.y = m.origin.y; pos.z = m.origin.z;
    qfromAxisAngle(rot, AXIS[mo.axis], f * Math.PI * 2);
  } else {
    const s = 0.5 - 0.5 * Math.cos(f * Math.PI * 2);
    pos.x = m.origin.x + mo.offset.x * s; pos.y = m.origin.y + mo.offset.y * s; pos.z = m.origin.z + mo.offset.z * s;
    rot.x = 0; rot.y = 0; rot.z = 0; rot.w = 1;
  }
}

export interface Sphere { c: V3; r: number }

/** Conservative bounding spheres of a box, split along its long dimensions so slabs and arms stay tight. */
function boxSpheres(center: V3, size: V3, rot: Q4 = IDENT): Sphere[] {
  const dims = [size.x, size.y, size.z];
  const cell = Math.max(Math.min(...dims), Math.max(...dims) / 6);
  const n = dims.map((d) => Math.max(1, Math.ceil(d / cell - 1e-6)));
  const sub = dims.map((d, i) => d / n[i]!);
  const r = Math.hypot(sub[0]! / 2, sub[1]! / 2, sub[2]! / 2);
  const out: Sphere[] = [];
  const local = v3();
  for (let i = 0; i < n[0]!; i++) for (let j = 0; j < n[1]!; j++) for (let k = 0; k < n[2]!; k++) {
    local.x = -size.x / 2 + (i + 0.5) * sub[0]!; local.y = -size.y / 2 + (j + 0.5) * sub[1]!; local.z = -size.z / 2 + (k + 0.5) * sub[2]!;
    const w = qrot(v3(), rot, local);
    out.push({ c: v3(center.x + w.x, center.y + w.y, center.z + w.z), r });
  }
  return out;
}
const IDENT = q4();

/** World-space bounding spheres of a prop at its blueprint pose. */
export function partSpheres(p: Prop): Sphere[] {
  switch (p.kind) {
    case 'box': return boxSpheres(p.center, p.size, boxRotation(p, q4()));
    case 'cylinder': {
      const d = p.radius * 2;
      return boxSpheres(p.center, p.axis === 'x' ? v3(p.height, d, d) : p.axis === 'y' ? v3(d, p.height, d) : v3(d, d, p.height));
    }
    case 'pillar': return boxSpheres(p.center, v3(p.radius * 2, p.height, p.radius * 2));
    case 'rock': return [{ c: p.center, r: p.radius * 1.15 * Math.max(1, p.squash ?? 1) }];
    case 'spike': {
      const m = p.length * 0.325;
      return [{ c: v3(p.center.x + p.dir.x * m, p.center.y + p.dir.y * m, p.center.z + p.dir.z * m), r: p.length * 0.675 + p.radius * 1.3 }];
    }
    case 'crystal': {
      const h = p.length / 2;
      return [{ c: v3(p.center.x + p.dir.x * h, p.center.y + p.dir.y * h, p.center.z + p.dir.z * h), r: h + p.radius }];
    }
    case 'ring': return [{ c: p.center, r: p.radius + p.tube }];
  }
}

/** Bounding spheres of every part, posed at `tick`. */
export function posedSpheres(m: Mover, tick: number): Sphere[] {
  const pos = v3(), rot = q4(), local = v3(), out: Sphere[] = [];
  moverPose(m, tick, pos, rot);
  for (const p of m.parts) {
    for (const s of partSpheres(p)) {
      local.x = s.c.x - m.origin.x; local.y = s.c.y - m.origin.y; local.z = s.c.z - m.origin.z;
      const w = qrot(v3(), rot, local);
      out.push({ c: v3(w.x + pos.x, w.y + pos.y, w.z + pos.z), r: s.r });
    }
  }
  return out;
}

/** The volume a mover can ever occupy (tori for spinners, capsules for sliders), with a bounding sphere for culling. */
export type Sweep = { mover: string; r: number; bound: Sphere } & (
  | { kind: 'torus'; pivot: V3; axis: V3; major: number; along: number }
  | { kind: 'capsule'; a: V3; b: V3 }
);

export function moverSweeps(m: Mover): Sweep[] {
  const out: Sweep[] = [];
  const mo = m.motion;
  for (const p of m.parts) {
    for (const s of partSpheres(p)) {
      if (mo.kind === 'spin') {
        const ax = AXIS[mo.axis];
        const qx = s.c.x - m.origin.x, qy = s.c.y - m.origin.y, qz = s.c.z - m.origin.z;
        const along = qx * ax.x + qy * ax.y + qz * ax.z;
        const major = Math.hypot(qx - ax.x * along, qy - ax.y * along, qz - ax.z * along);
        const bound = { c: v3(m.origin.x + ax.x * along, m.origin.y + ax.y * along, m.origin.z + ax.z * along), r: major + s.r };
        out.push({ kind: 'torus', mover: m.id, pivot: m.origin, axis: ax, major, along, r: s.r, bound });
      } else {
        const b = v3(s.c.x + mo.offset.x, s.c.y + mo.offset.y, s.c.z + mo.offset.z);
        const bound = { c: v3((s.c.x + b.x) / 2, (s.c.y + b.y) / 2, (s.c.z + b.z) / 2), r: Math.hypot(mo.offset.x, mo.offset.y, mo.offset.z) / 2 + s.r };
        out.push({ kind: 'capsule', mover: m.id, a: s.c, b, r: s.r, bound });
      }
    }
  }
  return out;
}

/** Signed distance from `p` to the swept volume (negative inside). */
export function sweepDistance(s: Sweep, p: V3): number {
  if (s.kind === 'capsule') return Math.sqrt(segmentPointDistSq(s.a, s.b, p)) - s.r;
  const qx = p.x - s.pivot.x, qy = p.y - s.pivot.y, qz = p.z - s.pivot.z;
  const along = qx * s.axis.x + qy * s.axis.y + qz * s.axis.z;
  const radial = Math.hypot(qx - s.axis.x * along, qy - s.axis.y * along, qz - s.axis.z * along);
  return Math.hypot(radial - s.major, along - s.along) - s.r;
}

/** Distance from `p` to the nearest space any mover can sweep through (Infinity when there are none). */
export function moverClearance(sweeps: Sweep[], p: V3): number {
  let best = Infinity;
  for (const s of sweeps) {
    const d = sweepDistance(s, p);
    if (d < best) best = d;
  }
  return best;
}

/** True when a sphere of radius `r` moving from `a` to `b` never enters any mover's swept volume. */
export function segmentClearOfMovers(sweeps: Sweep[], a: V3, b: V3, r: number): boolean {
  const near = sweeps.filter((s) => Math.sqrt(segmentPointDistSq(a, b, s.bound.c)) < s.bound.r + r);
  if (!near.length) return true;
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / 3));
  const p = v3();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    p.x = a.x + (b.x - a.x) * t; p.y = a.y + (b.y - a.y) * t; p.z = a.z + (b.z - a.z) * t;
    if (moverClearance(near, p) < r) return false;
  }
  return true;
}

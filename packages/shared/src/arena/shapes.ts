import { Rng } from '../rng.js';

/** Icosphere vertices (subdivided once, 42 verts), unit radius. */
function icosphere(): number[][] {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(normalize);
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const cache = new Map<string, number>();
  const mid = (a: number, b: number) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const va = verts[a]!, vb = verts[b]!;
    verts.push(normalize([(va[0]! + vb[0]!) / 2, (va[1]! + vb[1]!) / 2, (va[2]! + vb[2]!) / 2]));
    cache.set(k, verts.length - 1);
    return verts.length - 1;
  };
  for (const [a, b, c] of faces) { mid(a!, b!); mid(b!, c!); mid(c!, a!); }
  return verts;
}
function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}
const ICO = icosphere();

/** Jittered rock hull points (local, centered at origin). */
export function rockPoints(radius: number, seed: number, squash = 1): number[] {
  const rng = new Rng(seed);
  const out: number[] = [];
  const sx = rng.range(0.85, 1.15), sz = rng.range(0.85, 1.15);
  for (const v of ICO) {
    const r = radius * rng.range(0.72, 1.0);
    out.push(v[0]! * r * sx, v[1]! * r * squash, v[2]! * r * sz);
  }
  return out;
}

/** Pillar hull points running along Y, centered at origin. */
export function pillarPoints(radius: number, height: number, seed: number): number[] {
  const rng = new Rng(seed);
  const out: number[] = [];
  const rings = 7, seg = 9;
  for (let i = 0; i < rings; i++) {
    const y = -height / 2 + (height * i) / (rings - 1);
    const waist = 1 - 0.25 * Math.sin((i / (rings - 1)) * Math.PI);
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2 + rng.range(-0.15, 0.15);
      const r = radius * waist * rng.range(0.8, 1.0);
      out.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  return out;
}

/**
 * Irregular cone along +Y with its tip at y=length. The root reaches 0.35 length behind y=0 and flares,
 * so a stalactite based just inside a room stays buried in the displaced rock face.
 */
export function spikePoints(length: number, radius: number, seed: number): number[] {
  const rng = new Rng(seed);
  const out: number[] = [];
  const seg = 7;
  for (const [t, k] of [[-0.35, 1.3], [0, 1], [0.35, 0.6], [0.7, 0.28]] as const) {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = radius * k * rng.range(0.75, 1.0);
      out.push(Math.cos(a) * r, length * t, Math.sin(a) * r);
    }
  }
  out.push(rng.range(-0.15, 0.15) * radius, length, rng.range(-0.15, 0.15) * radius);
  return out;
}

/** Elongated octahedron along +Y from y=0 to y=length. */
export function crystalPoints(length: number, radius: number): number[] {
  const mid = length * 0.3;
  return [
    0, 0, 0, 0, length, 0,
    radius, mid, 0, -radius, mid, 0, 0, mid, radius, 0, mid, -radius,
  ];
}

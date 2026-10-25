import { DEG, v3, type V3 } from '../math.js';
import { Rng } from '../rng.js';
import type { Blueprint, Prop, Room, SafeZone } from './blueprint.js';

/**
 * Gloamwood: one vast night forest. A spire of black vein-lit stone stands at the center, a chamber in its
 * foot holding the safe zone and every spawn, the powerup floating over its tip. Giant gnarled trees crowd
 * outward from the glade around it, thickest in the outskirts where the oranges grow; five avenues run
 * clear from the chamber's arches into the woods.
 */
const W = 4;
const p = (x: number, y: number, z: number) => v3(x, y, z);
const TAU = Math.PI * 2;
export const FOREST_FLOOR = -140;
const G = FOREST_FLOOR, HALF = 360, TOP = 140;
/** directions of the chamber's arches and the avenues beyond them */
export const FOREST_EXITS = [0, 1, 2, 3, 4].map((k) => (18 + k * 72) * DEG);
const AVENUE_HALF = 24, AVENUE_LEN = 230, AVENUE_TOP = G + 60;
const GLADE = 100;

/** shaft rings above the chamber cap: height over the floor, radius, and a drift that twists the spire */
const SHAFT = [[58, 34], [80, 26], [102, 21], [124, 17], [146, 13], [168, 10], [188, 7], [204, 4.6], [214, 2.8]] as const;
const shaftCenter = (i: number) => p(7 * Math.sin(i * 0.8), 0, 4.2 * (1 - Math.cos(i * 0.8)));
const tipCenter = shaftCenter(SHAFT.length - 1);
export const FOREST_TIP = p(tipCenter.x, G + 228, tipCenter.z);
export const FOREST_POWERUP = p(tipCenter.x, G + 240, tipCenter.z);

export const FOREST_ROOMS: Room[] = [
  {
    id: 'wood', name: 'Gloamwood', center: p(0, 0, 0), size: p(HALF * 2, TOP - G, HALF * 2), wall: W, landmark: 0x7fe9ff, theme: 'forest',
    ambience: 'forest', navGrid: { step: 60, ys: [-118, -78, -30, 30, 95], reach: 1.5 },
  },
];

export const FOREST_SAFE_ZONES: SafeZone[] = [{ id: 'chamber', room: 'wood', center: p(0, G + 27, 0), radius: 24 }];

/** two tiers of spawns facing out of each arch */
export const FOREST_SPAWNS: { room: string; pos: V3; facing: V3 }[] = FOREST_EXITS.flatMap((a) => [G + 15, G + 33].map((y) => ({
  room: 'wood', pos: p(Math.cos(a) * 14, y, Math.sin(a) * 14), facing: p(Math.cos(a), 0, Math.sin(a)),
})));

/** Spire clearance radius at a height: the chamber and its legs below the cap, the twisting shaft above. */
export function spireRadius(y: number): number {
  const h = y - G;
  if (h < 66) return 56;
  for (let i = 0; i + 1 < SHAFT.length; i++) {
    const [h0, r0] = SHAFT[i]!, [h1, r1] = SHAFT[i + 1]!;
    if (h <= h1) return r0 + (r1 - r0) * ((h - h0) / (h1 - h0)) + 7;
  }
  return h < 236 ? 10 : 0;
}

function inAvenue(q: V3, r: number): boolean {
  if (q.y - r > AVENUE_TOP) return false;
  for (const a of FOREST_EXITS) {
    const along = q.x * Math.cos(a) + q.z * Math.sin(a), perp = Math.abs(-q.x * Math.sin(a) + q.z * Math.cos(a));
    if (along > 0 && along < AVENUE_LEN && perp < AVENUE_HALF + r) return true;
  }
  return false;
}

const inBounds = (q: V3, r: number) => Math.abs(q.x) <= HALF - r - 4 && Math.abs(q.z) <= HALF - r - 4 && q.y <= TOP - r - 4;

/** Where wood may grow: inside the room, off the spire and the powerup, out of the avenues near the ground. */
function open(q: V3, r: number): boolean {
  if (!inBounds(q, r)) return false;
  if (Math.hypot(q.x, q.z) < spireRadius(q.y) + r + 12) return false;
  if (Math.hypot(q.x - FOREST_POWERUP.x, q.y - FOREST_POWERUP.y, q.z - FOREST_POWERUP.z) < 36 + r) return false;
  return !inAvenue(q, r);
}

const norm = (d: V3) => { const l = Math.hypot(d.x, d.y, d.z) || 1; d.x /= l; d.y /= l; d.z /= l; return d; };
const lerp3 = (a: V3, b: V3, t: number) => p(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

function buildProps(rng: Rng): Prop[] {
  const props: Prop[] = [];
  const room = 'wood';
  const limb = (points: V3[], radii: number[], role: 'trunk' | 'root' | 'branch', collides = true) => {
    if (points.length < 2) return;
    const center = points.find((q) => q.y > G + 1) ?? points[points.length - 1]!;
    props.push({ room, kind: 'limb', center, points, radii, seed: rng.int(1, 1e9), role, collides, material: 'bark' });
  };
  const hull = (center: V3, pts: V3[], material: Prop['material'], extra: Partial<Prop> = {}) =>
    props.push({ room, kind: 'hull', center, points: pts.flatMap((q) => [q.x - center.x, q.y - center.y, q.z - center.z]), collides: true, material, ...extra } as Prop);
  const ring = (c: V3, r: number, n: number, rot: number, jitter: number) => Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * TAU + rng.range(-0.12, 0.12), rr = r * rng.range(1 - jitter, 1);
    return p(c.x + Math.cos(a) * rr, c.y, c.z + Math.sin(a) * rr);
  });

  // ---- the spire: five leaning legs round the chamber, a cap, then a twisting shaft to a crystal tip
  const VEIN = 0x7fe9ff;
  for (let k = 0; k < 5; k++) {
    const mid = FOREST_EXITS[k]! + 36 * DEG;
    const pts: V3[] = [];
    for (const [y, r0, r1, half] of [[G - 2, 37, 55, 13], [G + 26, 34, 51, 14], [G + 54, 30, 47, 18]] as const) {
      for (const f of [-1, -0.35, 0.35, 1]) {
        const a = mid + f * half * DEG;
        for (const r of [r0, r1]) pts.push(p(Math.cos(a) * r * rng.range(0.97, 1.03), y + rng.range(-1, 1), Math.sin(a) * r * rng.range(0.97, 1.03)));
      }
    }
    hull(p(Math.cos(mid) * 44, G + 26, Math.sin(mid) * 44), pts, 'ore', { emissive: VEIN });
  }
  hull(p(0, G + 58, 0), [...ring(p(0, G + 50, 0), 56, 12, 0, 0.04), ...ring(p(0, G + 60, 0), 52, 12, 0.2, 0.05), ...ring(p(0, G + 66, 0), 38, 10, 0.4, 0.05)], 'ore', { emissive: VEIN });
  for (let i = 0; i + 1 < SHAFT.length; i++) {
    const [h0, r0] = SHAFT[i]!, [h1, r1] = SHAFT[i + 1]!;
    const c0 = shaftCenter(i), c1 = shaftCenter(i + 1);
    const lo = ring(p(c0.x, G + h0 - 1.5, c0.z), r0, 9, i * 0.35, 0.12), hi = ring(p(c1.x, G + h1 + 1.5, c1.z), r1, 9, (i + 1) * 0.35, 0.12);
    hull(p((c0.x + c1.x) / 2, G + (h0 + h1) / 2, (c0.z + c1.z) / 2), [...lo, ...hi], 'ore', { emissive: VEIN });
  }
  props.push({ room, kind: 'crystal', center: p(tipCenter.x, G + 208, tipCenter.z), dir: p(0, 1, 0), length: 20, radius: 3, collides: true, material: 'emissive', emissive: VEIN, pulse: 0.3 });
  // in the chamber: a glowing pool on the floor and root tendrils hanging from the cap
  props.push({ room, kind: 'cylinder', center: p(0, G + 0.3, 0), radius: 13, height: 0.5, axis: 'y', collides: false, material: 'emissive', emissive: 0x5cffc8, pulse: 0.12 });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + rng.range(-0.2, 0.2), r = rng.range(8, 26), len = rng.range(5, 10);
    const top = p(Math.cos(a) * r, G + 50.5, Math.sin(a) * r);
    const pts = [top, p(top.x + rng.range(-1.5, 1.5), top.y - len * 0.5, top.z + rng.range(-1.5, 1.5)), p(top.x + rng.range(-2, 2), top.y - len, top.z + rng.range(-2, 2))];
    limb(pts, [1.3, 0.8, 0.35], 'root', false);
    props.push({ room, kind: 'crystal', center: pts[2]!, dir: p(0, -1, 0), length: 1.6, radius: 0.5, collides: false, material: 'emissive', emissive: 0x5cffc8, pulse: 0.5 });
  }

  // ---- trees
  type Style = 'gnarl' | 'coil' | 'fork' | 'lean';
  const bases: { x: number; z: number; r: number }[] = [];
  const reserve = (x: number, z: number, r: number) => bases.push({ x, z, r });
  const free = (x: number, z: number, r: number) => bases.every((b) => Math.hypot(b.x - x, b.z - z) > b.r + r);

  /** A bough from `origin` heading `dir`, curling by `curl` per step; it stops where wood may not grow. */
  const bough = (origin: V3, dir: V3, length: number, r0: number, r1: number, curl: number, segs: number, role: 'branch' | 'root' = 'branch') => {
    const pts = [origin], radii = [r0], d = norm({ ...dir });
    let q = origin;
    for (let i = 1; i <= segs; i++) {
      d.x += rng.range(-0.22, 0.22); d.z += rng.range(-0.22, 0.22); d.y += curl + rng.range(-0.08, 0.08);
      norm(d);
      q = p(q.x + d.x * (length / segs), q.y + d.y * (length / segs), q.z + d.z * (length / segs));
      const r = r0 + (r1 - r0) * (i / segs);
      if (!open(q, r)) break;
      pts.push(q); radii.push(r);
    }
    if (pts.length >= 3) limb(pts, radii, role);
    return pts;
  };

  const tree = (x: number, z: number, height: number, R: number, style: Style): boolean => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const n = Math.ceil(height / 9);
      const ph = [rng.range(0, TAU), rng.range(0, TAU)], amp = rng.range(3, 8) * (style === 'gnarl' ? 1.4 : 1), fq = rng.range(1.2, 2.6);
      const la = rng.range(0, TAU), lean = style === 'lean' ? rng.range(0.25, 0.42) : rng.range(0, 0.16);
      const coilR = style === 'coil' ? rng.range(10, 14) : 0, coilTurns = rng.range(1.1, 1.6), coilPh = rng.range(0, TAU);
      const pts: V3[] = [], radii: number[] = [];
      let ok = true;
      for (let i = 0; i <= n; i++) {
        const t = Math.pow(i / n, 1.25);
        const y = G - 6 + (height + 6) * t;
        // lean bends the trunk over in its lower half and lets it climb again above
        const bend = height * lean * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5);
        const ca = coilPh + t * coilTurns * TAU, cr = coilR * Math.min(1, t * 4);
        const q = p(
          x + Math.cos(la) * bend + amp * t * Math.sin(t * fq * Math.PI + ph[0]!) + Math.cos(ca) * cr,
          y,
          z + Math.sin(la) * bend + amp * t * Math.cos(t * fq * 1.3 * Math.PI + ph[1]!) + Math.sin(ca) * cr,
        );
        const r = R * Math.pow(1 - 0.72 * t, 1.15) + 0.8 + R * 0.4 * Math.exp(-t * 14);
        if (y > G ? !open(q, r) : !inBounds(q, r)) { ok = false; break; }
        pts.push(q); radii.push(r);
      }
      if (!ok) continue;
      const end = style === 'fork' ? Math.ceil(n * 0.55) : n;
      limb(pts.slice(0, end + 1), radii.slice(0, end + 1), 'trunk');
      const along = (t: number) => {
        const f = Math.min(end, t * end), i = Math.min(end - 1, Math.floor(f));
        return { pos: lerp3(pts[i]!, pts[i + 1]!, f - i), r: radii[i]! + (radii[i + 1]! - radii[i]!) * (f - i) };
      };
      // buttress roots, some arching high enough to fly under
      const nRoots = rng.int(4, 7), r0a = rng.range(0, TAU);
      for (let k = 0; k < nRoots; k++) {
        const a = r0a + (k / nRoots) * TAU + rng.range(-0.3, 0.3);
        const h0 = rng.range(4, 12), L = rng.range(20, 34) + R * 1.5, arch = rng.chance(0.3) ? rng.range(8, 16) : rng.range(0, 4);
        const rp: V3[] = [], rr: number[] = [];
        for (let s = 0; s <= 6; s++) {
          const u = s / 6, dist = L * u;
          const q = p(x + Math.cos(a) * dist, G + h0 * Math.pow(1 - u, 1.6) + arch * Math.sin(Math.PI * u) * (1 - u * 0.4) - 3 * u * u, z + Math.sin(a) * dist);
          const r = R * 0.55 * (1 - u) + 1.1;
          if (s > 0 && (q.y > G - 1 ? !open(q, r) : !inBounds(q, r))) break;
          rp.push(q); rr.push(r);
        }
        if (rp.length >= 3) limb(rp, rr, 'root');
      }
      // main boughs, then a few twigs off each
      const nb = rng.int(4, 7), ba = rng.range(0, TAU);
      for (let k = 0; k < nb; k++) {
        const t0 = rng.range(0.42, 0.9), at = along(style === 'fork' ? t0 * 0.9 : t0);
        const a = ba + (k / nb) * TAU + rng.range(-0.4, 0.4), el = rng.range(0.12, 0.75);
        const dir = p(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
        const droop = rng.chance(0.3);
        const bp = bough(at.pos, dir, height * rng.range(0.28, 0.5), at.r * rng.range(0.45, 0.6), 0.6, droop ? -0.09 : 0.07, 6);
        const twigs = bp.length > 3 ? rng.int(0, 3) : 0;
        for (let j = 0; j < twigs; j++) {
          const from = bp[rng.int(2, bp.length - 1)]!;
          const ta = rng.range(0, TAU);
          bough(from, p(Math.cos(ta), rng.range(-0.2, 0.6), Math.sin(ta)), height * rng.range(0.12, 0.22), 1.4, 0.45, 0.05, 4);
        }
      }
      if (style === 'fork') {
        const at = along(1), sa = rng.range(0, TAU);
        for (const s of [0, Math.PI]) {
          const a = sa + s;
          bough(at.pos, p(Math.cos(a) * 0.45, 1, Math.sin(a) * 0.45), height * 0.5, at.r * 0.85, 1, 0.04, 6);
        }
      } else {
        const top = along(1);
        for (let j = 0; j < 2; j++) bough(top.pos, p(rng.range(-0.6, 0.6), 1, rng.range(-0.6, 0.6)), height * 0.18, top.r, 0.5, 0.02, 4);
      }
      return true;
    }
    return false;
  };

  // landmarks first, so the woods fill in around them
  const polar = (deg: number, r: number) => p(Math.cos(deg * DEG) * r, 0, Math.sin(deg * DEG) * r);
  // the Coil: a corkscrew trunk wide enough to fly up through
  { const c = polar(54, 170); tree(c.x, c.z, 150, 6.5, 'coil'); reserve(c.x, c.z, 50); }
  // the Arch: a trunk that rises, rolls over and roots again 80 m on
  {
    const c = polar(126, 255), a = 126 * DEG + Math.PI / 2;
    const a0 = p(c.x - Math.cos(a) * 42, 0, c.z - Math.sin(a) * 42), a1 = p(c.x + Math.cos(a) * 42, 0, c.z + Math.sin(a) * 42);
    const pts: V3[] = [], radii: number[] = [];
    for (let i = 0; i <= 18; i++) {
      const u = i / 18, q = lerp3(a0, a1, u);
      q.y = G - 5 + 78 * Math.sin(Math.PI * u) + 6 * Math.sin(u * TAU * 2);
      q.x += Math.sin(u * TAU) * 5; q.z += Math.cos(u * TAU * 1.5) * 4;
      pts.push(q); radii.push(8.5 - 4.5 * Math.sin(Math.PI * u) + 1.5 * Math.exp(-Math.min(u, 1 - u) * 20));
    }
    limb(pts, radii, 'trunk');
    for (const u of [0.35, 0.5, 0.65]) {
      const q = pts[Math.round(u * 18)]!, ta = rng.range(0, TAU);
      bough(q, p(Math.cos(ta) * 0.6, 1, Math.sin(ta) * 0.6), 45, 3, 0.6, 0.06, 5);
    }
    reserve(c.x, c.z, 60);
  }
  // the Twins: two trunks wound round each other
  {
    const c = polar(270, 205), ph = rng.range(0, TAU);
    for (const s of [0, Math.PI]) {
      const pts: V3[] = [], radii: number[] = [];
      for (let i = 0; i <= 20; i++) {
        const t = i / 20, a = ph + s + t * TAU * 1.4, rr = 9 * Math.min(1, t * 5);
        pts.push(p(c.x + Math.cos(a) * rr, G - 5 + 160 * t, c.z + Math.sin(a) * rr));
        radii.push(6.5 * (1 - 0.7 * t) + 0.8 + 2.5 * Math.exp(-t * 14));
      }
      limb(pts, radii, 'trunk');
      for (const t of [0.6, 0.8]) {
        const q = pts[Math.round(t * 20)]!, ta = rng.range(0, TAU);
        bough(q, p(Math.cos(ta), 0.5, Math.sin(ta)), 55, 2.8, 0.6, 0.06, 6);
      }
    }
    reserve(c.x, c.z, 45);
  }
  // the Hollow: a fallen giant you can fly the length of
  {
    const c = polar(198, 290), a = 198 * DEG + Math.PI / 2 + 0.25;
    const dir = p(Math.cos(a), 0, Math.sin(a));
    props.push({ room, kind: 'log', center: p(c.x, G + 15, c.z), dir, length: 110, outer: 17, inner: 10.5, seed: rng.int(1, 1e9), collides: true, material: 'bark' });
    reserve(c.x, c.z, 62);
  }
  // giant mushrooms in the outskirts, gills glowing under their caps
  const GILLS = [0x4fd8ff, 0x8f7dff, 0x46ffd2];
  for (let i = 0, placed = 0; i < 300 && placed < 8; i++) {
    const a = rng.range(0, TAU), r = rng.range(250, 330), x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) > 330 || Math.abs(z) > 330 || !free(x, z, 30)) continue;
    const h = rng.range(18, 38), Rc = rng.range(12, 21);
    const top = p(x + rng.range(-4, 4), G + h, z + rng.range(-4, 4));
    if (!open(top, Rc) || !open(p(x, G + 8, z), 6)) continue;
    limb([p(x, G - 3, z), lerp3(p(x, G - 3, z), top, 0.5), top], [5.2, 3.6, 3], 'trunk');
    const capC = p(top.x, top.y + Rc * 0.15, top.z);
    hull(capC, [...ring(p(top.x, top.y - Rc * 0.12, top.z), Rc, 14, 0, 0.06), ...ring(p(top.x, top.y + Rc * 0.28, top.z), Rc * 0.72, 12, 0.3, 0.05),
      p(top.x, top.y + Rc * 0.45, top.z), ...ring(p(top.x, top.y - Rc * 0.05, top.z), Rc * 0.35, 8, 0, 0.05)], 'moss');
    props.push({ room, kind: 'cylinder', center: p(top.x, top.y - Rc * 0.1, top.z), radius: Rc * 0.86, height: 0.6, axis: 'y', collides: false, material: 'emissive', emissive: GILLS[placed % 3]!, pulse: 0.1 + 0.05 * placed });
    reserve(x, z, Rc + 14);
    placed++;
  }
  // the woods: sparse near the glade, crowding in toward the walls
  for (let i = 0; i < 6000; i++) {
    const x = rng.range(-HALF + 25, HALF - 25), z = rng.range(-HALF + 25, HALF - 25), r = Math.hypot(x, z);
    if (r < GLADE) continue;
    const f = Math.min(1, (r - GLADE) / 240), R = rng.range(5, 8) + f * 1.5;
    const gap = 84 - 30 * f;
    if (inAvenue(p(x, G + 5, z), R * 1.4 + 6) || !free(x, z, gap / 2)) continue;
    const roll = rng.next();
    const style: Style = roll < 0.55 ? 'gnarl' : roll < 0.72 ? 'lean' : roll < 0.9 ? 'fork' : 'coil';
    if (tree(x, z, 105 + 55 * f + rng.range(-15, 15), R, style)) reserve(x, z, gap / 2);
  }

  // ---- ground: rolling mossy mounds, boulders and fallen limbs to hide behind
  for (let i = 0, placed = 0; i < 400 && placed < 16; i++) {
    const x = rng.range(-320, 320), z = rng.range(-320, 320), r = rng.range(22, 38);
    if (Math.hypot(x, z) < GLADE - 10 || inAvenue(p(x, G, z), r)) continue;
    props.push({ room, kind: 'rock', center: p(x, G + 0.5, z), radius: r, seed: rng.int(1, 1e9), squash: 0.24, collides: true, material: 'moss' });
    placed++;
  }
  for (let i = 0, placed = 0; i < 600 && placed < 34; i++) {
    const x = rng.range(-330, 330), z = rng.range(-330, 330), r = rng.range(5, 15);
    const c = p(x, G + r * 0.3, z);
    if (Math.hypot(x, z) < 75 || !open(c, r)) continue;
    props.push({ room, kind: 'rock', center: c, radius: r, seed: rng.int(1, 1e9), squash: rng.range(0.6, 0.9), collides: true, material: 'moss' });
    placed++;
  }
  for (let i = 0, placed = 0; i < 600 && placed < 24; i++) {
    const x = rng.range(-320, 320), z = rng.range(-320, 320), a = rng.range(0, TAU), len = rng.range(26, 52), r = rng.range(2.2, 3.8);
    const a0 = p(x - Math.cos(a) * len / 2, G + r - 0.6, z - Math.sin(a) * len / 2), a1 = p(x + Math.cos(a) * len / 2, G + r - 0.6 + rng.range(0, 6), z + Math.sin(a) * len / 2);
    const m = lerp3(a0, a1, 0.5); m.x += rng.range(-3, 3); m.z += rng.range(-3, 3); m.y += rng.range(0, 2);
    if (Math.hypot(x, z) < 80 || ![a0, m, a1].every((q) => open(q, r))) continue;
    limb([a0, m, a1], [r, r * 0.9, r * 0.7], 'branch');
    placed++;
  }
  return props;
}

/** Fungus-glow lights in the understory, plus the chamber and the spire tip. */
function buildLights(rng: Rng, props: Prop[]): NonNullable<Room['lights']> {
  const COLORS = [0x46c8ff, 0x8a6bff, 0x3fffd2];
  const lights: NonNullable<Room['lights']> = [
    { pos: p(0, G + 30, 0), color: 0xb8ffe6, intensity: 4200, distance: 110 },
    { pos: p(tipCenter.x, G + 196, tipCenter.z), color: 0x7fe9ff, intensity: 5200, distance: 140 },
  ];
  const trunks = props.filter((q): q is Extract<Prop, { kind: 'limb' }> => q.kind === 'limb' && q.role === 'trunk');
  for (let i = 0; i < 400 && lights.length < 20; i++) {
    const t = trunks[rng.int(0, trunks.length)]!, b = t.points[0]!;
    const a = rng.range(0, TAU), q = p(b.x + Math.cos(a) * 24, G + rng.range(8, 16), b.z + Math.sin(a) * 24);
    if (lights.some((l) => Math.hypot(l.pos.x - q.x, l.pos.z - q.z) < 150) || Math.abs(q.x) > 340 || Math.abs(q.z) > 340) continue;
    lights.push({ pos: q, color: COLORS[lights.length % 3]!, intensity: 4800, distance: 140 });
  }
  return lights;
}

const OUT = 240, EDGE = HALF - 15;
export const FOREST_SEED = 0x6100d;
export function forest(): Blueprint {
  const rng = new Rng(FOREST_SEED);
  const props = buildProps(rng);
  const rooms = FOREST_ROOMS.map((r) => ({ ...r, lights: buildLights(rng, props) }));
  return {
    id: 'forest', name: 'Gloamwood', rooms, tunnels: [], props, seed: FOREST_SEED,
    safeZones: FOREST_SAFE_ZONES, spawns: FOREST_SPAWNS, powerups: [FOREST_POWERUP],
    oranges: {
      scale: 3, cap: 80, roomWeight: 0.01, zones: [
        { id: 'north woods', min: p(-EDGE, G + 8, OUT), max: p(EDGE, G + 110, EDGE), weight: 4.5, spacing: 14 },
        { id: 'south woods', min: p(-EDGE, G + 8, -EDGE), max: p(EDGE, G + 110, -OUT), weight: 4.5, spacing: 14 },
        { id: 'east woods', min: p(OUT, G + 8, -OUT), max: p(EDGE, G + 110, OUT), weight: 3.2, spacing: 14 },
        { id: 'west woods', min: p(-EDGE, G + 8, -OUT), max: p(-OUT, G + 110, OUT), weight: 3.2, spacing: 14 },
      ],
    },
    atmosphere: {
      fog: { color: 0x0e1828, density: 0.00135 },
      moon: { dir: p(-0.45, 0.52, -0.72), color: 0xc4d4ff, intensity: 2.4 },
      hemi: { sky: 0x6a82b0, ground: 0x141c16, intensity: 0.85 },
      backdrop: { target: p(0, -20, 0), radius: 170, height: 55 },
    },
  };
}

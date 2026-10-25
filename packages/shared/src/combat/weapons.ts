import type * as RAPIER from '@dimforge/rapier3d-deterministic-compat';
import type { PrimaryDef, ShipClassDef } from '../classes/types.js';
import { CONVERGE_DISTANCE, DT, PROJECTILE_CAP_PER_SHIP } from '../constants.js';
import type { Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { DEG, qrot, v3, vdot, vlen, vnorm, type Q4, type V3 } from '../math.js';
import { lineOfSight } from '../physicsWorld.js';
import type { TierEffect } from '../power.js';
import { hash32 } from '../rng.js';

export const OVERDRIVE_CADENCE = 1.35;

export function activePrimary(def: ShipClassDef, tier: TierEffect): PrimaryDef {
  return tier.altPrimary ? def.altPrimary : def.primary;
}

export function cadenceTicks(w: PrimaryDef, cadenceMult: number): number {
  return Math.max(1, Math.round(1 / w.rate / cadenceMult / DT));
}

export function projectileCount(w: PrimaryDef, def: ShipClassDef, tier: TierEffect): number {
  return w.count + (w.id === def.primary.id && w.pattern === 'cone' ? tier.extraPellets : 0);
}

/** Local-space angular offsets (yaw, pitch) in radians for each projectile of a volley. */
export function spreadOffsets(w: PrimaryDef, count: number, seed: number): [number, number][] {
  const s = w.spreadDeg * DEG;
  switch (w.pattern) {
    case 'single': return [[0, 0]];
    case 'grid2x2': return [[-s / 2, -s / 2], [s / 2, -s / 2], [-s / 2, s / 2], [s / 2, s / 2]].slice(0, count) as [number, number][];
    case 'fan': {
      if (count === 1) return [[0, 0]];
      return Array.from({ length: count }, (_, i) => [-s / 2 + (s * i) / (count - 1), 0] as [number, number]);
    }
    case 'cone': {
      const out: [number, number][] = [[0, 0]];
      const ring = count - 1;
      const phase = ((seed & 0xffff) / 0xffff) * Math.PI * 2;
      for (let i = 0; i < ring; i++) {
        const a = phase + (i / ring) * Math.PI * 2;
        out.push([Math.cos(a) * s, Math.sin(a) * s]);
      }
      return out;
    }
  }
}

/** Apply a (yaw, pitch) offset to a forward direction in the ship's local frame. */
export function offsetDir(out: V3, rot: Q4, baseLocal: V3, yaw: number, pitch: number): V3 {
  // +yaw turns -Z toward +X, +pitch turns -Z toward +Y
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x = baseLocal.x * cy - baseLocal.z * sy;
  const z = baseLocal.x * sy + baseLocal.z * cy;
  const y = baseLocal.y;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const local = v3(x, y * cp - z * sp, y * sp + z * cp);
  return vnorm(out, qrot(out, rot, local));
}

export interface MuzzleShot { origin: V3; dir: V3 }

/** Muzzle origins and converged directions for one volley (shared by sim and client prediction). */
export function volleyShots(
  def: ShipClassDef, w: PrimaryDef, count: number, pos: V3, rot: Q4, muzzleIndex: number, seed: number,
): MuzzleShot[] {
  const offs = spreadOffsets(w, count, seed);
  const muzzles = def.muzzles;
  const shots: MuzzleShot[] = [];
  const conv = v3(0, 0, -CONVERGE_DISTANCE);
  for (let i = 0; i < offs.length; i++) {
    let m: V3;
    if (w.muzzle === 'alternate') m = muzzles[muzzleIndex % muzzles.length]!;
    else if (w.muzzle === 'all') m = muzzles[i % muzzles.length]!;
    else {
      const c = v3();
      for (const q of muzzles) { c.x += q.x / muzzles.length; c.y += q.y / muzzles.length; c.z += q.z / muzzles.length; }
      m = c;
    }
    const baseLocal = vnorm(v3(), v3(conv.x - m.x, conv.y - m.y, conv.z - m.z));
    const dir = offsetDir(v3(), rot, baseLocal, offs[i]![0], offs[i]![1]);
    const o = qrot(v3(), rot, m);
    shots.push({ origin: v3(pos.x + o.x, pos.y + o.y, pos.z + o.z), dir });
  }
  return shots;
}

/** Slerp-style angle-limited turn from unit vector `from` toward unit vector `to`. */
function bendTowards(out: V3, from: V3, to: V3, maxAngle: number): V3 {
  const cos = Math.max(-1, Math.min(1, vdot(from, to)));
  const ang = Math.acos(cos);
  if (ang <= maxAngle || ang < 1e-6) { out.x = to.x; out.y = to.y; out.z = to.z; return out; }
  const s = Math.sin(ang), t = maxAngle / ang;
  const k0 = Math.sin((1 - t) * ang) / s, k1 = Math.sin(t * ang) / s;
  return vnorm(out, v3(from.x * k0 + to.x * k1, from.y * k0 + to.y * k1, from.z * k0 + to.z * k1));
}

/**
 * Limited homing for primaries like the Mule's Arc Slug: a one-time snap at the moment of
 * firing, never mid-flight, so straight-line extrapolation on remote clients stays correct.
 * Mutates each shot's `dir` in place toward the best in-cone, in-range, line-of-sight target.
 */
export function applyPrimarySeek(world: RAPIER.World, w: PrimaryDef, shots: MuzzleShot[], candidates: V3[]): void {
  if (!w.seekConeDeg || !w.seekBendDeg || candidates.length === 0) return;
  const coneCos = Math.cos(w.seekConeDeg * DEG);
  const maxBend = w.seekBendDeg * DEG;
  const range = w.seekRange ?? w.speed * w.life;
  const toTarget = v3();
  for (const sh of shots) {
    let bestCos = coneCos;
    let best: V3 | null = null;
    for (const p of candidates) {
      toTarget.x = p.x - sh.origin.x; toTarget.y = p.y - sh.origin.y; toTarget.z = p.z - sh.origin.z;
      const d = vlen(toTarget);
      if (d < 1 || d > range) continue;
      const ux = toTarget.x / d, uy = toTarget.y / d, uz = toTarget.z / d;
      const cos = sh.dir.x * ux + sh.dir.y * uy + sh.dir.z * uz;
      if (cos <= bestCos) continue;
      if (!lineOfSight(world, sh.origin, p)) continue;
      bestCos = cos; best = v3(ux, uy, uz);
    }
    if (best) bendTowards(sh.dir, sh.dir, best, maxBend);
  }
}

export function shotIdFor(shipId: number, seq: number, slot: number): number {
  return hash32(shipId, seq, slot) & 0x7fffffff;
}

export function canFirePrimary(sim: GameSim, s: Ship, w: PrimaryDef): boolean {
  const cad = s.tier.cadence * (s.def.ability.id === 'overdrive' && s.abilityActive > 0 ? OVERDRIVE_CADENCE : 1);
  return sim.tick - s.primaryLastFire >= cadenceTicks(w, cad) && s.energy >= w.energy;
}

export function firePrimary(sim: GameSim, s: Ship): boolean {
  const w = activePrimary(s.def, s.tier);
  if (!canFirePrimary(sim, s, w)) return false;
  const count = projectileCount(w, s.def, s.tier);
  if (sim.liveProjectilesOf(s.id) + count > PROJECTILE_CAP_PER_SHIP) return false;
  s.energy -= w.energy;
  s.primaryLastFire = sim.tick;
  const shotId = shotIdFor(s.id, s.input.seq, 0);
  const shots = volleyShots(s.def, w, count, s.pos, s.rot, s.muzzleIndex, shotId);
  if (w.seekConeDeg) {
    const candidates = sim.shipList.filter((o) => o.alive && o.id !== s.id && sim.canSee(s, o)).map((o) => o.pos);
    applyPrimarySeek(sim.world, w, shots, candidates);
  }
  if (w.muzzle === 'alternate') s.muzzleIndex++;
  let mult = s.tier.damage;
  if (s.ambushReady) { mult *= 1.5; s.ambushReady = false; }
  if (s.cloaked) sim.breakCloak(s);
  s.lastFireTick = sim.tick;
  sim.endSpawnProtection(s);
  s.stats.shotsFired++;
  sim.emit({ t: 'shot', ownerId: s.id, weapon: w.id, shotId, pos: shots[0]!.origin, dir: shots[0]!.dir });
  shots.forEach((sh, i) => {
    const vel = v3(sh.dir.x * w.speed, sh.dir.y * w.speed, sh.dir.z * w.speed);
    sim.spawnProjectile(s, w, sh.origin, vel, w.damage * mult, shotId, i);
  });
  return true;
}

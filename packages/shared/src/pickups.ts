import { safeZoneAt, type OrangeRegion } from './arena/generate.js';
import { moverClearance } from './arena/movers.js';
import {
  DROP_CAP, DROP_LIFETIME_S, DROP_RING_RADIUS, DT, MAGNET_RADIUS, MAGNET_SPEED, MAX_POWER, PICKUP_RADIUS,
} from './constants.js';
import type { Pickup, Ship } from './entities.js';
import type { GameSim } from './game.js';
import { v3, vcross, vdist, vdistSq, vlen, vnorm, type V3 } from './math.js';
import { castStatic, sphereFree } from './physicsWorld.js';
import { dropUnits, grantUnits, splitDrop, worldOrangeTarget } from './power.js';

export function spawnPickup(sim: GameSim, pos: V3, units: number, drop: boolean, killerId = -1): Pickup {
  const p: Pickup = {
    id: sim.nextPickupId(), pos: { ...pos }, vel: v3(), units, drop, spawnTick: sim.tick,
    expireTick: drop ? sim.tick + Math.round(DROP_LIFETIME_S / DT) : -1, killerId,
  };
  sim.pickups.push(p);
  sim.emit({ t: 'pickupSpawn', id: p.id, pos: { ...p.pos }, units, drop, expireTick: p.expireTick, killerId });
  if (drop) {
    const drops = sim.pickups.filter((q) => q.drop);
    while (drops.length > DROP_CAP) {
      const old = drops.shift()!;
      removePickup(sim, old);
      sim.emit({ t: 'pickupExpire', id: old.id });
    }
  }
  return p;
}

function removePickup(sim: GameSim, p: Pickup): void {
  const i = sim.pickups.indexOf(p);
  if (i >= 0) sim.pickups.splice(i, 1);
}

/** Drop half the victim's power as up to 4 pickups on a ring perpendicular to its last velocity. */
export function dropOnDeath(sim: GameSim, victim: Ship, killerId: number): number {
  const total = dropUnits(victim.power);
  const parts = splitDrop(total);
  if (!parts.length) return 0;
  const vel = victim.vel;
  const axis = vlen(vel) > 1 ? vnorm(v3(), vel) : v3(0, 1, 0);
  const a = vcross(v3(), axis, Math.abs(axis.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0));
  vnorm(a, a);
  const b = vnorm(v3(), vcross(v3(), axis, a));
  const phase = sim.rng.range(0, Math.PI * 2);
  parts.forEach((u, i) => {
    const ang = phase + (i / parts.length) * Math.PI * 2;
    const dir = vnorm(v3(), v3(a.x * Math.cos(ang) + b.x * Math.sin(ang), a.y * Math.cos(ang) + b.y * Math.sin(ang), a.z * Math.cos(ang) + b.z * Math.sin(ang)));
    let dist = DROP_RING_RADIUS;
    const hit = castStatic(sim.world, victim.pos, dir, DROP_RING_RADIUS + 1.5);
    if (hit >= 0) dist = Math.max(0, hit - 1.5);
    spawnPickup(sim, v3(victim.pos.x + dir.x * dist, victim.pos.y + dir.y * dist, victim.pos.z + dir.z * dist), u, true, killerId);
  });
  return total;
}

function pickRegion(sim: GameSim): OrangeRegion {
  const regions = sim.arena.regions.filter((r) => r.id !== sim.lastOrangeRegion);
  const total = regions.reduce((s, r) => s + r.weight, 0);
  let x = sim.rng.next() * total;
  for (const r of regions) { x -= r.weight; if (x <= 0) return r; }
  return regions[regions.length - 1]!;
}

/** World population: every 1 s spawn up to 2 toward the target (Section 6.6). */
export function populate(sim: GameSim): void {
  if (sim.match.phase !== 'inProgress' || sim.tick % 60 !== 0) return;
  const active = sim.shipList.length;
  const target = worldOrangeTarget(active);
  let live = sim.pickups.filter((p) => !p.drop).length;
  for (let n = 0; n < 2 && live < target; n++) {
    const region = pickRegion(sim);
    sim.lastOrangeRegion = region.id;
    for (let tries = 0; tries < 12; tries++) {
      const b = region.box;
      const p = v3(sim.rng.range(b.min.x, b.max.x), sim.rng.range(b.min.y, b.max.y), sim.rng.range(b.min.z, b.max.z));
      if (!sphereFree(sim.world, p, 1.5)) continue;
      if (safeZoneAt(sim.arena, p) || moverClearance(sim.arena.sweeps, p) < 4) continue;
      if (sim.shipList.some((s) => s.alive && vdistSq(s.pos, p) < 60 * 60)) continue;
      if (sim.pickups.some((q) => vdistSq(q.pos, p) < 25 * 25)) continue;
      if (sim.arena.spawns.some((sp) => vdistSq(sp.pos, p) < 40 * 40)) continue;
      if (sim.combatLog.some((c) => sim.tick - c.tick < 8 * 60 && vdistSq(c.pos, p) < 50 * 50)) continue;
      spawnPickup(sim, p, region.bonus ? 2 : 1, false);
      live++;
      break;
    }
  }
}

function eligible(s: Ship): boolean { return s.alive && s.power < MAX_POWER; }

export function updatePickups(sim: GameSim): void {
  // expiry
  for (let i = sim.pickups.length - 1; i >= 0; i--) {
    const p = sim.pickups[i]!;
    if (p.expireTick >= 0 && sim.tick >= p.expireTick) {
      sim.pickups.splice(i, 1);
      sim.emit({ t: 'pickupExpire', id: p.id });
    }
  }
  // magnet + collection, in spawn order, nearest eligible ship wins
  const taken: Pickup[] = [];
  for (const p of sim.pickups) {
    let best: Ship | null = null, bestD = Infinity;
    for (const s of sim.shipList) {
      if (!eligible(s)) continue;
      const d = vdist(s.pos, p.pos);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best) { p.vel.x = p.vel.y = p.vel.z = 0; continue; }
    if (bestD <= PICKUP_RADIUS + best.def.boundingRadius) {
      const got = grantUnits(best.power, p.units);
      if (got > 0) {
        taken.push(p);
        sim.grantPower(best, got);
        best.stats.orangesCollected += got;
        sim.endSpawnProtection(best);
        sim.emit({ t: 'pickupTake', id: p.id, shipId: best.id, units: got, pos: { ...p.pos } });
      }
      continue;
    }
    if (bestD <= MAGNET_RADIUS + best.def.boundingRadius) {
      const dx = best.pos.x - p.pos.x, dy = best.pos.y - p.pos.y, dz = best.pos.z - p.pos.z;
      const step = Math.min(MAGNET_SPEED * DT, bestD);
      p.vel.x = (dx / bestD) * MAGNET_SPEED; p.vel.y = (dy / bestD) * MAGNET_SPEED; p.vel.z = (dz / bestD) * MAGNET_SPEED;
      p.pos.x += (dx / bestD) * step; p.pos.y += (dy / bestD) * step; p.pos.z += (dz / bestD) * step;
    } else { p.vel.x = p.vel.y = p.vel.z = 0; }
  }
  for (const p of taken) removePickup(sim, p);
}

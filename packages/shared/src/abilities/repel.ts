import { REPEL_COOLDOWN_S, REPEL_DV, REPEL_MAX_TARGETS, REPEL_RADIUS } from '../constants.js';
import type { Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { vdist } from '../math.js';
import { endMissile } from '../combat/missiles.js';
import { endProjectile } from '../combat/projectiles.js';

export function repelShove(d: number, taken: number): number {
  if (d >= REPEL_RADIUS) return 0;
  const k = 1 - d / REPEL_RADIUS;
  return REPEL_DV * k * k * taken;
}

/** Server-authoritative shockwave: shove ships, destroy enemy projectiles/missiles, break cloaks. */
export function activateRepel(sim: GameSim, s: Ship): boolean {
  if (!s.tier.repel || s.repelCooldown > 0 || !s.alive) return false;
  s.repelCooldown = REPEL_COOLDOWN_S;
  sim.endSpawnProtection(s);
  sim.emit({ t: 'repel', shipId: s.id, pos: { ...s.pos }, radius: REPEL_RADIUS });

  type Cand = { d: number; apply: () => void };
  const cands: Cand[] = [];
  for (const o of sim.shipList) {
    if (o.id === s.id || !o.alive || sim.tick < o.spawnProtectedUntil || o.safe || !o.body) continue;
    const d = vdist(o.pos, s.pos);
    if (d >= REPEL_RADIUS) continue;
    cands.push({
      d, apply: () => {
        const dv = repelShove(d, o.def.repelTaken);
        let dx = o.pos.x - s.pos.x, dy = o.pos.y - s.pos.y, dz = o.pos.z - s.pos.z;
        const l = Math.hypot(dx, dy, dz);
        if (l < 1e-3) { dx = 0; dy = 1; dz = 0; } else { dx /= l; dy /= l; dz /= l; }
        const k = dv * o.def.mass;
        o.body!.applyImpulse({ x: dx * k, y: dy * k, z: dz * k }, true);
        if (o.cloaked) sim.breakCloak(o);
      },
    });
  }
  for (const p of sim.projectiles) {
    if (p.ownerId === s.id) continue;
    const d = vdist(p.pos, s.pos);
    if (d < REPEL_RADIUS) cands.push({ d: d + 1000, apply: () => { if (!p.dead) endProjectile(sim, p, 'repel', p.pos); } });
  }
  for (const m of sim.missiles) {
    if (m.ownerId === s.id) continue;
    const d = vdist(m.pos, s.pos);
    if (d < REPEL_RADIUS) cands.push({ d: d + 500, apply: () => endMissile(sim, m, 'repel', m.pos, false) });
  }
  // ships first, then missiles, then projectiles; nearest first; at most 24 entities
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands.slice(0, REPEL_MAX_TARGETS)) c.apply();
  return true;
}

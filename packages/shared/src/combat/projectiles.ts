import { DT } from '../constants.js';
import type { EndReason, Missile, Projectile, Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { segmentPointDistSq, segmentSphere, v3, vlen, type V3 } from '../math.js';
import { castStatic } from '../physicsWorld.js';
import { applyDamage, applySplash } from './damage.js';
import { hitSphereWorld, poseAt, segmentVsShip } from './hitVolumes.js';
import { endMissile } from './missiles.js';

const _dir = v3(), _end = v3();

export function endProjectile(sim: GameSim, p: Projectile, reason: EndReason, pos: V3): void {
  sim.removeProjectile(p);
  sim.emit({ t: 'projEnd', id: p.id, reason, pos: { ...pos } });
}

function detonate(sim: GameSim, p: Projectile, pos: V3, directId: number): void {
  const w = p.weapon;
  if (w.splashRadius && w.splashDamage) {
    applySplash(sim, pos, w.splashRadius, (w.splashDamage * p.damage) / w.damage, w.splashMinFrac ?? 0, p.ownerId, w.id, directId);
  }
}

const _c = v3();

/**
 * Where along this tick's segment a shell flying past the ship is closest to one of its hit spheres, if that
 * point lies within `fuse` m of the sphere's surface: 0 when it is already past its closest approach (receding),
 * -1 when it is still closing (it will get nearer next tick) or never comes within range.
 */
export function closestApproachWithin(ship: Ship, a: V3, dir: V3, len: number, fuse: number): number {
  let best = -1;
  for (const hs of ship.def.hitSpheres) {
    hitSphereWorld(_c, ship.pos, ship.rot, hs.c);
    const t = Math.max(0, (_c.x - a.x) * dir.x + (_c.y - a.y) * dir.y + (_c.z - a.z) * dir.z);
    if (t > len) continue;
    const d = Math.hypot(a.x + dir.x * t - _c.x, a.y + dir.y * t - _c.y, a.z + dir.z * t - _c.z) - hs.r;
    if (d <= fuse && (best < 0 || t < best)) best = t;
  }
  return best;
}

export function updateProjectiles(sim: GameSim): void {
  const list = sim.projectiles.slice();
  for (const p of list) {
    if (p.dead) continue;
    const speed = vlen(p.vel);
    const len = speed * DT;
    _dir.x = p.vel.x / speed; _dir.y = p.vel.y / speed; _dir.z = p.vel.z / speed;
    let best = castStatic(sim.world, p.pos, _dir, len);
    let reason: EndReason = 'world';
    let target: Ship | null = null;
    let bulwark: Ship | null = null;
    let torpedo: Missile | null = null;
    const w = p.weapon;
    const pastTick = sim.tick - p.lagTicks;

    for (const s of sim.shipList) {
      if (!s.alive || s.id === p.ownerId) continue;
      // lag-compensated test against the pose the shooter saw
      const pose = p.lagTicks > 0 ? poseAt(s, pastTick) : null;
      const pp = pose ? pose.pos : s.pos, pr = pose ? pose.rot : s.rot;
      const t = segmentVsShip(s, pp, pr, p.pos, _dir, len, w.radius);
      if (t >= 0 && (best < 0 || t < best)) { best = t; reason = 'ship'; target = s; bulwark = null; torpedo = null; }
      const bt = sim.bulwarkIntersect(s, p.ownerId, p.pos, _dir, len);
      if (bt >= 0 && (best < 0 || bt <= best)) { best = bt; reason = 'bulwark'; bulwark = s; target = null; torpedo = null; }
    }
    for (const m of sim.missiles) {
      if (m.def.kind !== 'torpedo' || m.ownerId === p.ownerId) continue;
      const t = segmentSphere(p.pos, _dir, len, m.pos, m.def.hitRadius + w.radius);
      if (t >= 0 && (best < 0 || t < best)) { best = t; reason = 'torpedo'; torpedo = m; target = null; bulwark = null; }
    }

    if (best < 0 && w.proximity) {
      // Proximity fuse (present time; exempt from lag compensation). It is there to catch near misses, so it
      // holds fire while the shell's flight line would still strike a ship (the direct hit lands on a later
      // tick) and otherwise goes off at the point of closest approach. Firing on first entry into the fuse
      // radius turned every well-aimed shell into a 4 m near miss doing ~2 splash damage instead of a direct
      // hit (kx9: bot Brutes landed hits at a Dart's rate yet dealt a tenth of the damage).
      _end.x = p.pos.x + _dir.x * len; _end.y = p.pos.y + _dir.y * len; _end.z = p.pos.z + _dir.z * len;
      const ahead = Math.max(len, speed * Math.max(0, p.endTick - sim.tick) * DT);
      for (const s of sim.shipList) {
        if (!s.alive || s.id === p.ownerId) continue;
        const reach = s.def.boundingRadius + w.proximity;
        if (segmentPointDistSq(p.pos, _end, s.pos) > reach * reach) continue;
        if (segmentVsShip(s, s.pos, s.rot, p.pos, _dir, ahead, w.radius) >= 0) continue;
        const t = closestApproachWithin(s, p.pos, _dir, len, w.proximity);
        if (t >= 0 && (best < 0 || t < best)) { best = t; reason = 'proximity'; target = null; }
      }
    }

    if (best >= 0) {
      const back = reason === 'world' ? 0.3 : 0;
      const hp = v3(p.pos.x + _dir.x * Math.max(0, best - back), p.pos.y + _dir.y * Math.max(0, best - back), p.pos.z + _dir.z * Math.max(0, best - back));
      endProjectile(sim, p, reason, hp);
      const owner = sim.ship(p.ownerId);
      if (target) {
        if (owner) owner.stats.shotsHit++;
        applyDamage(sim, target, p.damage, p.ownerId, w.id, hp);
        detonate(sim, p, hp, target.id);
      } else if (bulwark) {
        sim.absorbBulwark(bulwark, p.damage, hp);
      } else if (torpedo) {
        torpedo.hp -= p.damage;
        // a shot-down torpedo still goes off — it's slow and juicy, not a free dud.
        if (torpedo.hp <= 0) endMissile(sim, torpedo, 'torpedo', torpedo.pos, true);
        detonate(sim, p, hp, -1);
      } else {
        detonate(sim, p, hp, -1);
      }
      continue;
    }
    p.pos.x += p.vel.x * DT; p.pos.y += p.vel.y * DT; p.pos.z += p.vel.z * DT;
    if (sim.tick >= p.endTick) endProjectile(sim, p, 'expire', p.pos);
  }
}

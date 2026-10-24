import { CONVERGE_DISTANCE, DT, MISSILE_SEEKER_CONE } from '../constants.js';
import type { EndReason, Missile, Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { DEG, qrot, v3, vdot, vlen, vnorm, type V3 } from '../math.js';
import { castStatic, lineOfSight } from '../physicsWorld.js';
import { applyDamage, applySplash } from './damage.js';
import { segmentVsShip } from './hitVolumes.js';

const _f = v3(), _d = v3();

export function forwardOf(out: V3, s: Ship): V3 { return qrot(out, s.rot, v3(0, 0, -1)); }

/** Can `s` currently target `t` for lock-on (cone, range, line of sight, visibility)? */
export function lockCandidateScore(sim: GameSim, s: Ship, t: Ship, coneDeg: number, range: number): number {
  if (!t.alive || t.id === s.id) return -1;
  if (!sim.canSee(s, t)) return -1;
  _d.x = t.pos.x - s.pos.x; _d.y = t.pos.y - s.pos.y; _d.z = t.pos.z - s.pos.z;
  const dist = vlen(_d);
  if (dist > range || dist < 1) return -1;
  forwardOf(_f, s);
  const cos = vdot(_f, _d) / dist;
  if (cos < Math.cos(coneDeg * DEG)) return -1;
  if (!lineOfSight(sim.world, s.pos, t.pos)) return -1;
  return cos;
}

export function updateLock(sim: GameSim, s: Ship, held: boolean): void {
  const sec = s.def.secondary;
  const L = s.lock;
  if (!held || s.ammo <= 0) { L.targetId = -1; L.progress = 0; L.locked = false; return; }
  // keep current target if still valid, else pick best
  let cur = L.targetId >= 0 ? sim.ship(L.targetId) : undefined;
  if (cur && lockCandidateScore(sim, s, cur, sec.lockConeDeg, sec.lockRange) < 0) cur = undefined;
  if (!cur) {
    let best: Ship | undefined, bestScore = -1;
    for (const t of sim.shipList) {
      const sc = lockCandidateScore(sim, s, t, sec.lockConeDeg, sec.lockRange);
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    if (best?.id !== L.targetId) { L.progress = 0; L.locked = false; }
    L.targetId = best ? best.id : -1;
    if (!best) return;
  }
  L.progress += DT;
  if (!L.locked && L.progress >= sec.lockTime) { L.locked = true; sim.emit({ t: 'lockOn', shipId: s.id, targetId: L.targetId }); }
}

export function launchSecondary(sim: GameSim, s: Ship): boolean {
  const sec = s.def.secondary;
  if (s.ammo <= 0) return false;
  if ((sim.tick - s.secondaryLastFire) * DT < sec.refire) return false;
  s.ammo--;
  s.secondaryLastFire = sim.tick;
  if (s.cloaked) sim.breakCloak(s);
  sim.endSpawnProtection(s);
  s.lastFireTick = sim.tick;
  const target = s.lock.locked ? s.lock.targetId : -1;
  forwardOf(_f, s);
  const fwd = v3(_f.x, _f.y, _f.z);
  const converge = v3(s.pos.x + fwd.x * CONVERGE_DISTANCE, s.pos.y + fwd.y * CONVERGE_DISTANCE, s.pos.z + fwd.z * CONVERGE_DISTANCE);
  for (let i = 0; i < sec.count; i++) {
    let local: V3;
    let origin: V3;
    if (sec.count > 1) {
      const a = (i / sec.count) * Math.PI * 2;
      local = vnorm(v3(), v3(Math.cos(a) * 0.45, Math.sin(a) * 0.45, -1));
      const m = qrot(v3(), s.rot, v3(Math.cos(a) * 1.2, Math.sin(a) * 0.6 - 0.4, -2));
      origin = v3(s.pos.x + m.x, s.pos.y + m.y, s.pos.z + m.z);
    } else {
      local = v3(0, 0, -1);
      const mz = s.def.muzzles[0]!;
      const m = qrot(v3(), s.rot, v3(0, mz.y - 0.3, mz.z));
      origin = v3(s.pos.x + m.x, s.pos.y + m.y, s.pos.z + m.z);
    }
    const dir = qrot(v3(), s.rot, local);
    const vel = v3(dir.x * sec.speed + s.vel.x * 0.5, dir.y * sec.speed + s.vel.y * 0.5, dir.z * sec.speed + s.vel.z * 0.5);
    const m: Missile = {
      id: sim.nextMissileId(), ownerId: s.id, def: sec, pos: origin, vel, targetId: target, tracking: target >= 0,
      spawnTick: sim.tick, endTick: sim.tick + Math.round(sec.life / DT), hp: sec.hp ?? 0,
      converge: target < 0 && sec.count > 1 ? converge : null, damage: sec.damage * s.tier.damage,
    };
    sim.missiles.push(m);
    sim.emit({ t: 'missileSpawn', id: m.id, ownerId: s.id, kind: sec.id, pos: { ...origin }, vel: { ...vel }, targetId: target });
  }
  s.lock.progress = 0; s.lock.locked = false; s.lock.targetId = -1;
  return true;
}

function turnToward(vel: V3, desired: V3, maxAngle: number, speed: number): void {
  const vd = vnorm(v3(), vel);
  const dd = vnorm(v3(), desired);
  const cos = Math.max(-1, Math.min(1, vdot(vd, dd)));
  const ang = Math.acos(cos);
  let nx: number, ny: number, nz: number;
  if (ang <= maxAngle || ang < 1e-5) { nx = dd.x; ny = dd.y; nz = dd.z; } else {
    const t = maxAngle / ang;
    // slerp between unit vectors
    const s = Math.sin(ang);
    const k0 = Math.sin((1 - t) * ang) / s, k1 = Math.sin(t * ang) / s;
    nx = vd.x * k0 + dd.x * k1; ny = vd.y * k0 + dd.y * k1; nz = vd.z * k0 + dd.z * k1;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  vel.x = (nx / l) * speed; vel.y = (ny / l) * speed; vel.z = (nz / l) * speed;
}

export function endMissile(sim: GameSim, m: Missile, reason: EndReason, pos: V3, explode: boolean, excludeId = -1): void {
  const idx = sim.missiles.indexOf(m);
  if (idx < 0) return;
  sim.missiles.splice(idx, 1);
  sim.emit({ t: 'missileEnd', id: m.id, reason, pos: { ...pos } });
  if (explode && m.def.splashRadius > 0) {
    applySplash(sim, pos, m.def.splashRadius, m.damage, m.def.splashMinFrac, m.ownerId, m.def.id, excludeId);
  }
}

export function updateMissiles(sim: GameSim): void {
  const list = sim.missiles.slice();
  for (const m of list) {
    if (!sim.missiles.includes(m)) continue;
    const speed = m.def.speed;
    // homing
    if (m.tracking) {
      const t = sim.ship(m.targetId);
      if (!t || !t.alive) { m.tracking = false; } else {
        _d.x = t.pos.x - m.pos.x; _d.y = t.pos.y - m.pos.y; _d.z = t.pos.z - m.pos.z;
        const dist = vlen(_d);
        const vd = vnorm(v3(), m.vel);
        if (dist > 1 && vdot(vd, _d) / dist < Math.cos(MISSILE_SEEKER_CONE)) m.tracking = false;
        else {
          const lead = dist / speed;
          const aim = v3(_d.x + t.vel.x * lead * 0.5, _d.y + t.vel.y * lead * 0.5, _d.z + t.vel.z * lead * 0.5);
          const age = (sim.tick - m.spawnTick) * DT;
          const turn = m.def.count > 1 && age < 0.25 ? 0 : m.def.turnDeg * DEG * DT;
          turnToward(m.vel, aim, turn, speed);
        }
      }
    } else if (m.converge) {
      const age = (sim.tick - m.spawnTick) * DT;
      _d.x = m.converge.x - m.pos.x; _d.y = m.converge.y - m.pos.y; _d.z = m.converge.z - m.pos.z;
      if (vdot(_d, m.vel) <= 0) m.converge = null;
      else if (age > 0.2) turnToward(m.vel, _d, m.def.turnDeg * DEG * DT, speed);
    } else {
      const l = vlen(m.vel);
      if (Math.abs(l - speed) > 0.5) { m.vel.x *= speed / l; m.vel.y *= speed / l; m.vel.z *= speed / l; }
    }
    const len = vlen(m.vel) * DT;
    const dir = vnorm(v3(), m.vel);
    // world
    let best = castStatic(sim.world, m.pos, dir, len);
    let hitShip: Ship | null = null;
    let wasBulwark: Ship | null = null;
    for (const s of sim.shipList) {
      if (!s.alive || s.id === m.ownerId) continue;
      const tt = segmentVsShip(s, s.pos, s.rot, m.pos, dir, len, m.def.hitRadius);
      if (tt >= 0 && (best < 0 || tt < best)) { best = tt; hitShip = s; wasBulwark = null; }
      const bt = sim.bulwarkIntersect(s, m.ownerId, m.pos, dir, len);
      if (bt >= 0 && (best < 0 || bt <= best)) { best = bt; hitShip = null; wasBulwark = s; }
    }
    if (best >= 0) {
      const p = v3(m.pos.x + dir.x * Math.max(0, best - 0.3), m.pos.y + dir.y * Math.max(0, best - 0.3), m.pos.z + dir.z * Math.max(0, best - 0.3));
      if (wasBulwark) {
        sim.absorbBulwark(wasBulwark, m.damage, p);
        endMissile(sim, m, 'bulwark', p, false);
      } else if (hitShip) {
        const owner = sim.ship(m.ownerId);
        if (owner) owner.stats.shotsHit++;
        const victim = hitShip;
        endMissile(sim, m, 'ship', p, true, victim.id);
        applyDamage(sim, victim, m.damage, m.ownerId, m.def.id, p);
      } else {
        endMissile(sim, m, 'world', p, true);
      }
      continue;
    }
    m.pos.x += m.vel.x * DT; m.pos.y += m.vel.y * DT; m.pos.z += m.vel.z * DT;
    if (sim.tick >= m.endTick) endMissile(sim, m, 'expire', m.pos, false);
  }
}

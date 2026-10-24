import type { Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { qrot, v3, type V3 } from '../math.js';

export const BULWARK_DISTANCE = 8;
export const BULWARK_RADIUS = 5.5;
export const BULWARK_ABSORB = 300;

const _n = v3(), _c = v3();

export function bulwarkActive(s: Ship): boolean {
  return s.alive && s.def.ability.id === 'bulwark' && s.abilityActive > 0 && s.bulwarkHp > 0;
}

export function bulwarkDisc(s: Ship, center: V3, normal: V3): void {
  qrot(normal, s.rot, v3(0, 0, -1));
  center.x = s.pos.x + normal.x * BULWARK_DISTANCE;
  center.y = s.pos.y + normal.y * BULWARK_DISTANCE;
  center.z = s.pos.z + normal.z * BULWARK_DISTANCE;
}

/** Distance along the segment where it crosses the Brute's frontal disc, or -1. Only blocks shots from the front. */
export function bulwarkIntersect(s: Ship, shooterId: number, a: V3, dir: V3, len: number): number {
  if (!bulwarkActive(s) || shooterId === s.id) return -1;
  bulwarkDisc(s, _c, _n);
  const dn = dir.x * _n.x + dir.y * _n.y + dir.z * _n.z;
  if (dn >= -1e-4) return -1;
  const t = ((_c.x - a.x) * _n.x + (_c.y - a.y) * _n.y + (_c.z - a.z) * _n.z) / dn;
  if (t < 0 || t > len) return -1;
  const px = a.x + dir.x * t - _c.x, py = a.y + dir.y * t - _c.y, pz = a.z + dir.z * t - _c.z;
  return px * px + py * py + pz * pz <= BULWARK_RADIUS * BULWARK_RADIUS ? t : -1;
}

export function absorbBulwark(sim: GameSim, s: Ship, dmg: number, pos: V3): void {
  s.bulwarkHp = Math.max(0, s.bulwarkHp - dmg);
  sim.emit({ t: 'bulwarkHit', shipId: s.id, pos: { ...pos }, remaining: s.bulwarkHp });
  if (s.bulwarkHp <= 0) endBulwark(sim, s);
}

export function activateBulwark(s: Ship): void {
  s.abilityActive = s.def.ability.duration;
  s.bulwarkHp = BULWARK_ABSORB;
}

export function endBulwark(sim: GameSim, s: Ship): void {
  if (s.abilityActive <= 0 && s.bulwarkHp <= 0) return;
  s.abilityActive = 0;
  s.bulwarkHp = 0;
  sim.emit({ t: 'ability', shipId: s.id, ability: 'bulwark', on: false, pos: { ...s.pos } });
}

import type { Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { lineOfSight } from '../physicsWorld.js';
import { v3, type V3 } from '../math.js';
import { pointToShipDistance } from './hitVolumes.js';

export interface DamageResult { shield: number; hull: number; killed: boolean }

/**
 * Route damage through shield then hull. Dead or protected ships take nothing.
 * Death is processed exactly once.
 */
export function applyDamage(sim: GameSim, target: Ship, amount: number, attackerId: number, weapon: string, pos: V3): DamageResult {
  const res: DamageResult = { shield: 0, hull: 0, killed: false };
  if (!target.alive || amount <= 0) return res;
  if (!sim.damageEnabled()) return res;
  if (sim.tick < target.spawnProtectedUntil || target.safe) return res;
  if (attackerId === target.id) return res; // no self-damage
  let rem = amount;
  if (target.shield > 0) {
    res.shield = Math.min(target.shield, rem);
    target.shield -= res.shield;
    rem -= res.shield;
  }
  if (rem > 0) {
    res.hull = Math.min(target.hull, rem);
    target.hull -= res.hull;
  }
  target.lastDamageTick = sim.tick;
  if (target.cloaked) sim.breakCloak(target);
  const attacker = sim.ship(attackerId);
  if (attacker && attacker.id !== target.id) {
    target.damagers.add(attacker.id);
    attacker.stats.damageDealt += res.shield + res.hull;
  }
  sim.noteCombat(pos);
  sim.emit({ t: 'hit', targetId: target.id, attackerId, shield: res.shield, hull: res.hull, pos: { ...pos }, weapon });
  if (target.hull <= 0) {
    res.killed = true;
    sim.killShip(target, attackerId, weapon);
  }
  return res;
}

/** Splash damage with linear falloff; requires line of sight from the blast to the ship center. */
export function applySplash(
  sim: GameSim, pos: V3, radius: number, damage: number, minFrac: number, attackerId: number, weapon: string, excludeId: number,
): void {
  if (radius <= 0 || damage <= 0) return;
  sim.emit({ t: 'splash', pos: { ...pos }, radius, weapon });
  for (const s of sim.shipList) {
    if (!s.alive || s.id === excludeId || s.id === attackerId) continue;
    const d = pointToShipDistance(s, pos);
    if (d > radius) continue;
    if (!lineOfSight(sim.world, pos, s.pos)) continue;
    const frac = 1 - (d / radius) * (1 - minFrac);
    applyDamage(sim, s, damage * frac, attackerId, weapon, v3(s.pos.x, s.pos.y, s.pos.z));
  }
}

import type { Ship } from '../entities.js';
import type { GameSim } from '../game.js';

export function activateCloak(s: Ship): void {
  s.cloaked = true;
  s.ambushReady = true;
  s.abilityActive = s.def.ability.duration;
}

/** Breaks on firing, damage, Repel, or Sensor Sweep. Cooldown starts when the cloak ends. */
export function breakCloak(sim: GameSim, s: Ship): void {
  if (!s.cloaked) return;
  s.cloaked = false;
  s.ambushReady = false;
  s.abilityActive = 0;
  s.abilityCooldown = s.def.ability.cooldown * s.tier.abilityCooldown;
  sim.emit({ t: 'ability', shipId: s.id, ability: 'cloak', on: false, pos: { ...s.pos } });
}

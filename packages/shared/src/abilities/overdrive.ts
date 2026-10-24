import type { Ship } from '../entities.js';

export function activateOverdrive(s: Ship): void {
  s.abilityActive = s.def.ability.duration;
}

export function overdriveActive(s: Ship): boolean {
  return s.def.ability.id === 'overdrive' && s.abilityActive > 0;
}

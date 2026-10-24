import type { ShipClassDef, TierDef } from './classes/types.js';
import { MAX_POWER } from './constants.js';

export interface TierEffect {
  index: number; // -1 = no tier
  units: number;
  name: string;
  damage: number;
  cadence: number;
  shield: number;
  bonusAmmo: number;
  repel: boolean;
  altPrimary: boolean;
  abilityCooldown: number;
  extraPellets: number;
}

const NO_TIER: TierEffect = {
  index: -1, units: 0, name: 'Unpowered', damage: 1, cadence: 1, shield: 1, bonusAmmo: 0, repel: false,
  altPrimary: false, abilityCooldown: 1, extraPellets: 0,
};

/** Tiers are absolute: the active tier is the highest at or below the current units. */
export function resolveTier(def: ShipClassDef, units: number): TierEffect {
  let t: TierDef | undefined;
  let idx = -1;
  def.tiers.forEach((tier, i) => { if (units >= tier.units) { t = tier; idx = i; } });
  if (!t) return NO_TIER;
  return {
    index: idx, units: t.units, name: t.name,
    damage: t.damage ?? 1, cadence: t.cadence ?? 1, shield: t.shield ?? 1,
    bonusAmmo: t.bonusAmmo ?? 0, repel: !!t.repel, altPrimary: !!t.altPrimary,
    abilityCooldown: t.abilityCooldown ?? 1, extraPellets: t.extraPellets ?? 0,
  };
}

export function nextTierUnits(def: ShipClassDef, units: number): number | null {
  for (const t of def.tiers) if (t.units > units) return t.units;
  return null;
}

/** Units granted by a pickup; 0 means the ship can't consume it (at full power). */
export function grantUnits(held: number, pickupUnits: number): number {
  if (held >= MAX_POWER) return 0;
  return Math.min(pickupUnits, MAX_POWER - held);
}

export function dropUnits(units: number): number {
  return units <= 0 ? 0 : Math.ceil(units / 2);
}

/** Split dropped units into at most 4 pickups. */
export function splitDrop(total: number): number[] {
  if (total <= 0) return [];
  const count = Math.min(total, 4);
  const base = Math.floor(total / count);
  const extra = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

export function worldOrangeTarget(activePlayers: number): number {
  return Math.min(40, 8 + Math.ceil(activePlayers * 1.5));
}

/**
 * Apply a tier change to vitals/ammo. Raising shield× raises the max without refilling;
 * losing a tier clamps. Ammo is topped up by the difference in bonus already granted.
 */
export function applyTierToVitals(
  def: ShipClassDef, tier: TierEffect, v: { shield: number; maxShield: number; ammo: number; bonusAmmoGranted: number },
): void {
  v.maxShield = def.shield * tier.shield;
  if (v.shield > v.maxShield) v.shield = v.maxShield;
  if (tier.bonusAmmo > v.bonusAmmoGranted) {
    v.ammo += tier.bonusAmmo - v.bonusAmmoGranted;
    v.bonusAmmoGranted = tier.bonusAmmo;
  }
}

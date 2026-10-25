import { DEG, v3 } from '../math.js';
import { BRUTE_HULL_EXPONENT, BRUTE_HULL_SECTIONS, loftHullPoints } from './shipShapes.js';
import type { ShipClassDef } from './types.js';

export const brute: ShipClassDef = {
  id: 'brute', index: 3, name: 'Brute', faction: 'machine', archetype: 'Heavy / area denial',
  size: v3(7.4, 3.8, 12.6),
  // Shield +10% (140 -> 154): more survivable up front, before the hull is ever exposed.
  mass: 32_000, hull: 200, shield: 154, shieldRegenDelay: 5.0, shieldRegenRate: 14,
  maxSpeed: { fwd: 46, reverse: 25, strafe: 30, vertical: 30 },
  accel: { fwd: 32, lateral: 24, vertical: 24 },
  boostSpeedMult: 1.5, boostAccelMult: 1.6, boostDrain: 0.3, boostRegen: 0.2,
  maxRate: { pitch: 70 * DEG, yaw: 70 * DEG, roll: 110 * DEG },
  angAccel: { pitch: 250 * DEG, yaw: 250 * DEG, roll: 400 * DEG },
  energyMax: 140, energyRegen: 18, dodgeDV: 16, dodgeCooldown: 2.0, repelTaken: 0.5,
  primary: {
    id: 'flak', name: 'Plasma Flak', rate: 2.4, energy: 12, count: 1, pattern: 'single', spreadDeg: 0,
    speed: 170, life: 2.2, radius: 0.6, damage: 18, splashRadius: 5, splashDamage: 10, splashMinFrac: 0,
    proximity: 4, muzzle: 'center', color: 0xb35cff, visual: 'flak',
  },
  altPrimary: {
    id: 'flakStorm', name: 'Flak Storm', rate: 1.8, energy: 18, count: 3, pattern: 'fan', spreadDeg: 5,
    speed: 170, life: 2.2, radius: 0.6, damage: 14, splashRadius: 5, splashDamage: 8, splashMinFrac: 0,
    proximity: 4, muzzle: 'center', color: 0xb35cff, visual: 'flak',
  },
  secondary: {
    id: 'torpedo', name: 'Siege Torpedo', kind: 'torpedo', ammo: 2, count: 1, lockTime: 1.2, lockConeDeg: 10,
    lockRange: 500, damage: 130, splashRadius: 10, splashMinFrac: 0, speed: 80, turnDeg: 45, life: 9,
    refire: 3.0, hp: 40, hitRadius: 1.0, color: 0xff3fd0,
  },
  ability: { id: 'bulwark', name: 'Bulwark', duration: 4, cooldown: 20 },
  tiers: [
    { units: 2, name: 'Heated Core', damage: 1.1 },
    { units: 4, name: 'Reinforced', cadence: 1.1, shield: 1.15, bonusAmmo: 1 },
    { units: 6, name: 'Repel Online', damage: 1.2, cadence: 1.1, shield: 1.2, bonusAmmo: 1, repel: true },
    { units: 8, name: 'Flak Storm', altPrimary: true, shield: 1.25, bonusAmmo: 1, repel: true },
    { units: 10, name: 'Juggernaut', altPrimary: true, damage: 1.2, cadence: 1.15, shield: 1.35, bonusAmmo: 1, repel: true, abilityCooldown: 0.8 },
  ],
  muzzles: [v3(-0.25, 2.0, -2.4), v3(0.25, 2.0, -2.4)],
  cockpit: v3(0, 0.5, -4.3),
  colliders: [
    { type: 'hull', points: loftHullPoints(BRUTE_HULL_SECTIONS, 16, BRUTE_HULL_EXPONENT) },
    { type: 'capsuleZ', pos: v3(1.3, -0.5, -5.1), halfHeight: 1.5, radius: 0.55 },
    { type: 'capsuleZ', pos: v3(-1.3, -0.5, -5.1), halfHeight: 1.5, radius: 0.55 },
    { type: 'cuboid', pos: v3(3.1, -0.9, 2.4), half: v3(0.7, 0.2, 1.8) },
    { type: 'cuboid', pos: v3(-3.1, -0.9, 2.4), half: v3(0.7, 0.2, 1.8) },
  ],
  hitSpheres: [
    { c: v3(0, 0, -3.2), r: 1.8 }, { c: v3(0, 0.1, 0), r: 2.4 }, { c: v3(0, 0, 3.4), r: 2.1 },
    { c: v3(-1.3, -0.5, -5.6), r: 0.7 }, { c: v3(1.3, -0.5, -5.6), r: 0.7 },
    { c: v3(-3.2, -0.9, 2.4), r: 0.9 }, { c: v3(3.2, -0.9, 2.4), r: 0.9 },
  ],
  boundingRadius: 7.0,
  preferredRange: [80, 300],
  stats: { speed: 0.4, agility: 0.3, armor: 1.0, firepower: 0.85 },
};

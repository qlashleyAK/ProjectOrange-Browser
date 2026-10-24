import { DEG, v3 } from '../math.js';
import type { ShipClassDef } from './types.js';

export const dart: ShipClassDef = {
  id: 'dart', index: 0, name: 'Dart', faction: 'fleet', archetype: 'Interceptor / duelist',
  size: v3(5.8, 2.6, 8.6),
  mass: 10_000, hull: 100, shield: 90, shieldRegenDelay: 3.5, shieldRegenRate: 15,
  maxSpeed: { fwd: 70, reverse: 40, strafe: 45, vertical: 45 },
  accel: { fwd: 60, lateral: 45, vertical: 45 },
  boostSpeedMult: 1.6, boostAccelMult: 1.5, boostDrain: 0.4, boostRegen: 0.25,
  maxRate: { pitch: 120 * DEG, yaw: 120 * DEG, roll: 220 * DEG },
  angAccel: { pitch: 600 * DEG, yaw: 600 * DEG, roll: 900 * DEG },
  energyMax: 100, energyRegen: 24, dodgeDV: 26, dodgeCooldown: 1.2, repelTaken: 1,
  primary: {
    id: 'pulse', name: 'Twin Pulse Cannons', rate: 8, energy: 4.5, count: 1, pattern: 'single', spreadDeg: 0,
    speed: 300, life: 1.5, radius: 0.25, damage: 8, muzzle: 'alternate', color: 0x9fe8ff, visual: 'bolt',
  },
  altPrimary: {
    id: 'quadPulse', name: 'Quad Pulse', rate: 6, energy: 6, count: 4, pattern: 'grid2x2', spreadDeg: 1.2,
    speed: 300, life: 1.5, radius: 0.25, damage: 7, muzzle: 'center', color: 0x9fe8ff, visual: 'bolt',
  },
  secondary: {
    id: 'seeker', name: 'Seeker Missiles', kind: 'missile', ammo: 4, count: 1, lockTime: 0.6, lockConeDeg: 14,
    lockRange: 350, damage: 55, splashRadius: 4, splashMinFrac: 0.5, speed: 140, turnDeg: 100, life: 5,
    refire: 1.0, hitRadius: 0.4, color: 0xfff1d6,
  },
  ability: { id: 'overdrive', name: 'Overdrive', duration: 5, cooldown: 20 },
  tiers: [
    { units: 2, name: 'Hot Barrels', damage: 1.1 },
    { units: 4, name: 'Tuned Coils', damage: 1.15, cadence: 1.15, shield: 1.1, bonusAmmo: 1 },
    { units: 6, name: 'Repel Online', damage: 1.2, cadence: 1.2, shield: 1.15, bonusAmmo: 1, repel: true },
    { units: 8, name: 'Quad Battery', altPrimary: true, shield: 1.2, bonusAmmo: 2, repel: true },
    { units: 10, name: 'Ace', altPrimary: true, damage: 1.15, cadence: 1.15, shield: 1.3, bonusAmmo: 2, repel: true, abilityCooldown: 0.8 },
  ],
  muzzles: [v3(-0.42, -0.2, -3.8), v3(0.42, -0.2, -3.8)],
  cockpit: v3(0, 0.62, -1.4),
  colliders: [
    { type: 'capsuleZ', pos: v3(0, 0, 0), halfHeight: 3.2, radius: 0.85 },
    { type: 'cuboid', pos: v3(0, -0.15, 2.0), half: v3(2.9, 0.15, 0.85) },
    { type: 'cuboid', pos: v3(0, 1.3, 2.6), half: v3(0.06, 0.7, 0.8) },
  ],
  hitSpheres: [
    { c: v3(0, 0, -2.6), r: 1.0 }, { c: v3(0, 0, 0), r: 1.1 }, { c: v3(0, 0, 2.6), r: 1.2 },
    { c: v3(-2.0, -0.2, 2.2), r: 0.9 }, { c: v3(2.0, -0.2, 2.2), r: 0.9 },
  ],
  boundingRadius: 4.4,
  preferredRange: [60, 200],
  stats: { speed: 0.75, agility: 0.75, armor: 0.5, firepower: 0.6 },
};

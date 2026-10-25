import { DEG, v3 } from '../math.js';
import type { ShipClassDef } from './types.js';

export const scythe: ShipClassDef = {
  id: 'scythe', index: 2, name: 'Scythe', faction: 'machine', archetype: 'Striker / ambusher',
  size: v3(9.2, 1.8, 5.6),
  mass: 7_000, hull: 70, shield: 60, shieldRegenDelay: 4.0, shieldRegenRate: 12,
  maxSpeed: { fwd: 80, reverse: 35, strafe: 40, vertical: 40 },
  accel: { fwd: 70, lateral: 40, vertical: 40 },
  boostSpeedMult: 1.7, boostAccelMult: 1.6, boostDrain: 0.45, boostRegen: 0.25,
  maxRate: { pitch: 150 * DEG, yaw: 150 * DEG, roll: 280 * DEG },
  angAccel: { pitch: 800 * DEG, yaw: 800 * DEG, roll: 1200 * DEG },
  // Light frame: takes 10% less Repel knockback than the other classes to offset how easily it gets shoved around.
  energyMax: 100, energyRegen: 26, dodgeDV: 30, dodgeCooldown: 1.0, repelTaken: 0.9,
  primary: {
    // +10% damage: thin armor needs to be paid for with more bite.
    id: 'spine', name: 'Ripper Spines', rate: 3, energy: 12, count: 1, pattern: 'single', spreadDeg: 0,
    speed: 380, life: 1.3, radius: 0.3, damage: 24, muzzle: 'alternate', color: 0xff2a3a, visual: 'spine',
  },
  altPrimary: {
    id: 'twinSpine', name: 'Twin Spines', rate: 3, energy: 14, count: 2, pattern: 'fan', spreadDeg: 2,
    speed: 380, life: 1.3, radius: 0.3, damage: 22, muzzle: 'all', color: 0xff2a3a, visual: 'spine',
  },
  secondary: {
    // Lock 10% quicker (0.9s -> 0.81s) to make the missile a real threat, not just a poke.
    id: 'hunter', name: 'Hunter Missile', kind: 'missile', ammo: 2, count: 1, lockTime: 0.81, lockConeDeg: 12,
    lockRange: 450, damage: 85, splashRadius: 5, splashMinFrac: 0, speed: 120, turnDeg: 120, life: 6,
    refire: 2.0, hitRadius: 0.45, color: 0xfff1d6,
  },
  ability: { id: 'cloak', name: 'Phase Cloak', duration: 5, cooldown: 22 },
  tiers: [
    { units: 2, name: 'Honed', damage: 1.1 },
    { units: 4, name: 'Quickened', cadence: 1.15, shield: 1.1, bonusAmmo: 1 },
    { units: 6, name: 'Repel Online', damage: 1.2, cadence: 1.15, shield: 1.15, bonusAmmo: 1, repel: true },
    { units: 8, name: 'Twin Spines', altPrimary: true, shield: 1.2, bonusAmmo: 1, repel: true },
    { units: 10, name: 'Reaper', altPrimary: true, damage: 1.2, cadence: 1.2, shield: 1.25, bonusAmmo: 2, repel: true, abilityCooldown: 0.75 },
  ],
  muzzles: [v3(-1.2, -0.1, -1.75), v3(1.2, -0.1, -1.75)],
  cockpit: v3(0, 0.2, -2.3),
  colliders: [
    { type: 'ball', pos: v3(0, 0.1, -0.4), radius: 1.25 },
    { type: 'cuboid', pos: v3(1.9, -0.1, 0), half: v3(0.9, 0.2, 0.9), yawDeg: -20 },
    { type: 'cuboid', pos: v3(-1.9, -0.1, 0), half: v3(0.9, 0.2, 0.9), yawDeg: 20 },
    { type: 'cuboid', pos: v3(3.9, -0.6, 1.3), half: v3(0.6, 0.2, 1.1), yawDeg: -40 },
    { type: 'cuboid', pos: v3(-3.9, -0.6, 1.3), half: v3(0.6, 0.2, 1.1), yawDeg: 40 },
  ],
  hitSpheres: [
    { c: v3(0, 0.1, -0.6), r: 1.3 }, { c: v3(0, 0.1, 0.8), r: 1.1 },
    { c: v3(-2.0, -0.1, 0), r: 0.9 }, { c: v3(2.0, -0.1, 0), r: 0.9 },
    { c: v3(-3.6, -0.5, 1.2), r: 0.8 }, { c: v3(3.6, -0.5, 1.2), r: 0.8 },
    { c: v3(-4.4, -0.9, 2.2), r: 0.6 }, { c: v3(4.4, -0.9, 2.2), r: 0.6 },
  ],
  boundingRadius: 4.9,
  preferredRange: [150, 400],
  stats: { speed: 0.9, agility: 0.95, armor: 0.3, firepower: 0.75 },
};

import { DEG, v3 } from '../math.js';
import type { ShipClassDef } from './types.js';

export const mule: ShipClassDef = {
  id: 'mule', index: 1, name: 'Mule', faction: 'fleet', archetype: 'Utility / support-scout',
  size: v3(5.6, 3.0, 9.8),
  mass: 18_000, hull: 130, shield: 110, shieldRegenDelay: 3.0, shieldRegenRate: 18,
  maxSpeed: { fwd: 58, reverse: 45, strafe: 52, vertical: 52 },
  accel: { fwd: 45, lateral: 55, vertical: 55 },
  boostSpeedMult: 1.5, boostAccelMult: 1.4, boostDrain: 0.35, boostRegen: 0.25,
  maxRate: { pitch: 90 * DEG, yaw: 90 * DEG, roll: 150 * DEG },
  angAccel: { pitch: 400 * DEG, yaw: 400 * DEG, roll: 600 * DEG },
  energyMax: 120, energyRegen: 20, dodgeDV: 30, dodgeCooldown: 1.4, repelTaken: 1,
  primary: {
    id: 'scatter', name: 'Scatter Blaster', rate: 1.8, energy: 18, count: 7, pattern: 'cone', spreadDeg: 3.5,
    speed: 240, life: 0.8, radius: 0.2, damage: 6, muzzle: 'center', color: 0xe6f4ff, visual: 'pellet',
  },
  altPrimary: {
    id: 'arcSlug', name: 'Arc Slug', rate: 2.2, energy: 16, count: 1, pattern: 'single', spreadDeg: 0,
    speed: 320, life: 2.0, radius: 0.35, damage: 40, splashRadius: 3, splashDamage: 40, splashMinFrac: 0,
    muzzle: 'center', color: 0x5aa0ff, visual: 'slug',
  },
  secondary: {
    id: 'swarm', name: 'Swarm Pod', kind: 'swarm', ammo: 3, count: 6, lockTime: 0.4, lockConeDeg: 20,
    lockRange: 250, damage: 12, splashRadius: 0, splashMinFrac: 0, speed: 160, turnDeg: 160, life: 3,
    refire: 1.5, hitRadius: 0.25, color: 0xfff1d6,
  },
  ability: { id: 'sweep', name: 'Sensor Sweep', duration: 6, cooldown: 18 },
  tiers: [
    { units: 2, name: 'Hot Loads', damage: 1.1 },
    { units: 4, name: 'Wide Choke', extraPellets: 1, shield: 1.1, bonusAmmo: 1 },
    { units: 6, name: 'Repel Online', damage: 1.15, shield: 1.2, bonusAmmo: 1, repel: true },
    { units: 8, name: 'Arc Slug', altPrimary: true, shield: 1.2, bonusAmmo: 1, repel: true },
    { units: 10, name: 'Quartermaster', altPrimary: true, damage: 1.2, cadence: 1.15, shield: 1.3, bonusAmmo: 2, repel: true, abilityCooldown: 0.75 },
  ],
  muzzles: [v3(-0.35, -0.75, -4.9), v3(0.35, -0.75, -4.9)],
  cockpit: v3(0, 0.55, -3.3),
  colliders: [
    { type: 'cuboid', pos: v3(0, 0, -0.8), half: v3(1.5, 1.1, 4.0) },
    { type: 'cuboid', pos: v3(-2.3, -0.25, 0.9), half: v3(0.5, 0.55, 2.7) },
    { type: 'cuboid', pos: v3(2.3, -0.25, 0.9), half: v3(0.5, 0.55, 2.7) },
  ],
  hitSpheres: [
    { c: v3(0, 0, -3), r: 1.3 }, { c: v3(0, 0, 0), r: 1.6 }, { c: v3(0, 0, 2.5), r: 1.5 },
    { c: v3(-2.3, -0.25, 0.9), r: 1.1 }, { c: v3(2.3, -0.25, 0.9), r: 1.1 },
    { c: v3(-2.3, -0.25, 2.8), r: 1.0 }, { c: v3(2.3, -0.25, 2.8), r: 1.0 },
  ],
  boundingRadius: 5.0,
  preferredRange: [15, 80],
  stats: { speed: 0.6, agility: 0.55, armor: 0.7, firepower: 0.7 },
};

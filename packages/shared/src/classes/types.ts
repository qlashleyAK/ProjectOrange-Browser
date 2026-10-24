import type { V3 } from '../math.js';

export type ClassId = 'dart' | 'mule' | 'scythe' | 'brute';
export const CLASS_IDS: readonly ClassId[] = ['dart', 'mule', 'scythe', 'brute'];
export type Faction = 'fleet' | 'machine';

export type SpreadPattern = 'single' | 'cone' | 'grid2x2' | 'fan';
export type ProjectileVisual = 'bolt' | 'pellet' | 'spine' | 'flak' | 'slug';

export interface PrimaryDef {
  id: string;
  name: string;
  rate: number;          // shots (trigger pulls) per second
  energy: number;        // per shot
  count: number;         // projectiles per shot
  pattern: SpreadPattern;
  spreadDeg: number;     // cone half-angle (cone), cluster spacing (grid), total fan width (fan)
  speed: number;
  life: number;
  radius: number;
  damage: number;
  splashRadius?: number;
  splashDamage?: number;
  splashMinFrac?: number;
  proximity?: number;    // proximity fuse distance to enemy hit volume
  muzzle: 'alternate' | 'all' | 'center';
  color: number;
  visual: ProjectileVisual;
}

export type SecondaryKind = 'missile' | 'swarm' | 'torpedo';
export interface SecondaryDef {
  id: string;
  name: string;
  kind: SecondaryKind;
  ammo: number;
  count: number;
  lockTime: number;
  lockConeDeg: number;
  lockRange: number;
  damage: number;
  splashRadius: number;
  splashMinFrac: number;
  speed: number;
  turnDeg: number;
  life: number;
  refire: number;
  hp?: number;
  hitRadius: number;
  color: number;
}

export type AbilityId = 'overdrive' | 'sweep' | 'cloak' | 'bulwark';
export interface AbilityDef {
  id: AbilityId;
  name: string;
  duration: number;
  cooldown: number;
}

export interface TierDef {
  units: number;
  name: string;
  damage?: number;
  cadence?: number;
  shield?: number;
  bonusAmmo?: number;
  repel?: boolean;
  altPrimary?: boolean;
  abilityCooldown?: number;
  extraPellets?: number;
}

export type ColliderSpec =
  | { type: 'capsuleZ'; pos: V3; halfHeight: number; radius: number }
  | { type: 'cuboid'; pos: V3; half: V3; yawDeg?: number }
  | { type: 'ball'; pos: V3; radius: number }
  | { type: 'hull'; points: number[] };

export interface HitSphere { c: V3; r: number }

export interface ShipClassDef {
  id: ClassId;
  index: number;
  name: string;
  faction: Faction;
  archetype: string;
  size: V3; // L x W x H stored as {x: W, y: H, z: L}
  mass: number; // kg
  hull: number;
  shield: number;
  shieldRegenDelay: number;
  shieldRegenRate: number;
  maxSpeed: { fwd: number; reverse: number; strafe: number; vertical: number };
  accel: { fwd: number; lateral: number; vertical: number };
  boostSpeedMult: number;
  boostAccelMult: number;
  boostDrain: number;
  boostRegen: number;
  maxRate: { pitch: number; yaw: number; roll: number };   // rad/s
  angAccel: { pitch: number; yaw: number; roll: number };  // rad/s^2
  energyMax: number;
  energyRegen: number;
  dodgeDV: number;
  dodgeCooldown: number;
  repelTaken: number;
  primary: PrimaryDef;
  altPrimary: PrimaryDef;
  secondary: SecondaryDef;
  ability: AbilityDef;
  tiers: TierDef[];
  muzzles: V3[];
  cockpit: V3;
  colliders: ColliderSpec[];
  hitSpheres: HitSphere[];
  boundingRadius: number;
  preferredRange: [number, number];
  stats: { speed: number; agility: number; armor: number; firepower: number }; // 0..1 for UI bars
}

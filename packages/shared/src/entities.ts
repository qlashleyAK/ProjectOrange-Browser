import type * as RAPIER from '@dimforge/rapier3d-deterministic-compat';
import type { ClassId, PrimaryDef, SecondaryDef, ShipClassDef } from './classes/types.js';
import type { FlightState } from './flight.js';
import type { InputCmd } from './input.js';
import type { Q4, V3 } from './math.js';
import type { TierEffect } from './power.js';

export interface PoseSample { tick: number; pos: V3; rot: Q4; alive: boolean; generation: number }

export interface ShipStats {
  kills: number; deaths: number; assists: number;
  damageDealt: number; shotsFired: number; shotsHit: number;
  orangesCollected: number; peakPower: number;
}

export interface LockState { targetId: number; progress: number; locked: boolean }

export interface Ship {
  id: number;
  playerId: string;
  name: string;
  isBot: boolean;
  accent: number;
  def: ShipClassDef;
  pendingClass: ClassId;
  body: RAPIER.RigidBody | null;
  alive: boolean;
  generation: number;
  connected: boolean;

  pos: V3; rot: Q4; vel: V3; angvel: V3;
  prevPos: V3; prevRot: Q4;

  flight: FlightState;
  hull: number; shield: number; maxShield: number;
  energy: number; ammo: number; bonusAmmoGranted: number;
  power: number; tier: TierEffect;
  lastDamageTick: number;
  lastFireTick: number;

  primaryLastFire: number;
  secondaryLastFire: number;
  muzzleIndex: number;
  abilityCooldown: number;
  abilityActive: number;
  repelCooldown: number;
  cloaked: boolean;
  ambushReady: boolean;
  bulwarkHp: number;
  sweepUntil: number;
  sweepRevealed: Set<number>;
  lock: LockState;
  secondaryHeld: boolean;

  spawnProtectedUntil: number;
  deathTick: number;
  respawnAt: number;
  holdSpawn: boolean;
  removeAtDeath: boolean;

  stats: ShipStats;
  damagers: Set<number>;

  input: InputCmd;
  prevFlags: number;
  lagTicks: number;
  lockWarn: number;
  missileWarn: number;

  poseHistory: PoseSample[];
}

export interface Projectile {
  id: number;
  ownerId: number;
  ownerGen: number;
  weapon: PrimaryDef;
  pos: V3;
  vel: V3;
  spawnTick: number;
  endTick: number;
  damage: number;
  lagTicks: number;
  shotId: number;
  index: number;
  dead?: boolean;
}

export interface Missile {
  id: number;
  ownerId: number;
  def: SecondaryDef;
  pos: V3;
  vel: V3;
  targetId: number;
  tracking: boolean;
  spawnTick: number;
  endTick: number;
  hp: number;
  converge: V3 | null;
  damage: number;
}

export interface Pickup {
  id: number;
  pos: V3;
  vel: V3;
  units: number;
  drop: boolean;
  spawnTick: number;
  expireTick: number;
  killerId: number;
}

export type EndReason = 'expire' | 'world' | 'ship' | 'bulwark' | 'torpedo' | 'repel' | 'owner' | 'proximity';

export type GameEvent =
  | { t: 'shot'; ownerId: number; weapon: string; shotId: number; pos: V3; dir: V3 }
  | { t: 'projSpawn'; id: number; ownerId: number; weapon: string; pos: V3; vel: V3; spawnTick: number; shotId: number; index: number }
  | { t: 'projEnd'; id: number; reason: EndReason; pos: V3 }
  | { t: 'missileSpawn'; id: number; ownerId: number; kind: string; pos: V3; vel: V3; targetId: number }
  | { t: 'missileEnd'; id: number; reason: EndReason; pos: V3 }
  | { t: 'hit'; targetId: number; attackerId: number; shield: number; hull: number; pos: V3; weapon: string }
  | { t: 'splash'; pos: V3; radius: number; weapon: string }
  | { t: 'death'; victimId: number; killerId: number; weapon: string; pos: V3; vel: V3; classId: ClassId; dropped: number; assists: number[] }
  | { t: 'pickupSpawn'; id: number; pos: V3; units: number; drop: boolean; expireTick: number; killerId: number }
  | { t: 'pickupTake'; id: number; shipId: number; units: number; pos: V3 }
  | { t: 'pickupExpire'; id: number }
  | { t: 'tier'; shipId: number; index: number; name: string; gained: boolean }
  | { t: 'ability'; shipId: number; ability: string; on: boolean; pos: V3 }
  | { t: 'repel'; shipId: number; pos: V3; radius: number }
  | { t: 'sweep'; shipId: number; pos: V3; radius: number }
  | { t: 'bulwarkHit'; shipId: number; pos: V3; remaining: number }
  | { t: 'dodge'; shipId: number }
  | { t: 'spawn'; shipId: number; pos: V3 }
  | { t: 'scrape'; shipId: number; pos: V3; force: number }
  | { t: 'phase'; phase: MatchPhase }
  | { t: 'matchEnd'; winnerId: number }
  | { t: 'lockOn'; shipId: number; targetId: number };

export type MatchPhase = 'waiting' | 'warmup' | 'inProgress' | 'postMatch';

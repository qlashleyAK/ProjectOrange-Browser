import type {
  ArenaData, ClassId, GameEvent, GameMode, MatchPhase, PowerupKind, PrimaryDef, Q4, RAPIER, RosterEntry, SecondaryDef, ShipClassDef, TierEffect, V3,
} from '@orange/shared';

/** Render-ready state of one ship (already interpolated / predicted). */
export interface ShipView {
  id: number;
  name: string;
  isBot: boolean;
  classId: ClassId;
  accent: number;
  alive: boolean;
  gen: number;
  pos: V3;
  rot: Q4;
  vel: V3;
  hullFrac: number;
  shieldFrac: number;
  power: number;
  tierIndex: number;
  /** cloaked and hidden from the local player */
  cloaked: boolean;
  /** cloaked but within reveal range: render a faint shimmer */
  shimmer: boolean;
  bulwark: boolean;
  overdrive: boolean;
  spawnProtected: boolean;
  /** inside a safe zone with charge left */
  safe: boolean;
  boosting: boolean;
  isLocal: boolean;
  powerup: PowerupKind | null;
}

export interface LocalState {
  shipId: number;
  alive: boolean;
  def: ShipClassDef;
  pendingClass: ClassId;
  hull: number;
  shield: number;
  maxShield: number;
  energy: number;
  ammo: number;
  abilityCooldown: number;
  abilityActive: number;
  repelCooldown: number;
  power: number;
  tier: TierEffect;
  boostMeter: number;
  boostLocked: boolean;
  dodgeCooldown: number;
  lockTarget: number;
  lockProgress: number;
  locked: boolean;
  lockWarn: number;
  missileWarn: number;
  spawnProtected: boolean;
  /** protected by a safe zone (weapons offline) */
  safe: boolean;
  /** seconds of safe-zone protection left */
  safeCharge: number;
  inSafeZone: boolean;
  cloaked: boolean;
  bulwarkHp: number;
  /** seconds until respawn is allowed (<=0 means ready / alive) */
  respawnIn: number;
  holdSpawn: boolean;
  /** seconds remaining before a held spawn is forced */
  holdLeft: number;
  killerId: number;
  primary: PrimaryDef;
  secondary: SecondaryDef;
  powerup: PowerupKind | null;
  /** seconds left on the powerup */
  powerupLeft: number;
}

export interface ProjView { id: number; ownerId: number; weapon: PrimaryDef; pos: V3; vel: V3; age: number }
export interface MissileView { id: number; ownerId: number; kind: string; color: number; pos: V3; vel: V3 }
export interface PickupView { id: number; pos: V3; units: number; drop: boolean; expireIn: number; killerId: number }
/** the live powerup, else where the next appears and in how many seconds */
export interface PowerupView { live: { id: number; kind: PowerupKind; pos: V3 } | null; next: { pos: V3; in: number } | null }
/**
 * `nextArena`: id of the map the following match is played on (null until the server has said).
 * `mode`: ffa or a daily challenge mode; `wave`: survival's current wave; `course`: mine-run checkpoints in order.
 */
export interface MatchView {
  phase: MatchPhase; timeLeft: number; winnerId: number; elapsed: number; nextArena: string | null;
  mode: GameMode; wave: number; course: V3[];
}

export interface NetStats { ping: number; loss: number; jitter: number; interpDelay: number; snapshotAge: number; corrections: number; bufferDepth: number; serverTick: number; bandwidthIn: number; bandwidthOut: number }

export interface ViewSource {
  readonly online: boolean;
  /** can change when the server welcomes us into a room running a different map */
  readonly arena: ArenaData;
  /** physics world containing the arena geometry (camera collision, effects raycasts) */
  readonly world: RAPIER.World;
  /** advance by real elapsed seconds */
  update(dt: number): void;
  ships(): ShipView[];
  local(): LocalState | null;
  projectiles(): ProjView[];
  missiles(): MissileView[];
  pickups(): PickupView[];
  powerup(): PowerupView;
  roster(): RosterEntry[];
  match(): MatchView;
  drainEvents(): GameEvent[];
  /** simulation time in seconds, for animation */
  time(): number;
  /** fractional tick that moving arena fixtures are posed at, matching the local ship's timeline */
  envTick(): number;
  setClass(c: ClassId): void;
  setHold(hold: boolean): void;
  setPaused(p: boolean): void;
  netStats(): NetStats | null;
  /** short status warning (connection problems), or null */
  warning(): string | null;
  dispose(): void;
}

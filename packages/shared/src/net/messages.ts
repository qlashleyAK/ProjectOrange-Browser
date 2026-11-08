import type { ClassId } from '../classes/types.js';
import type { GameEvent, GameMode, MatchPhase } from '../entities.js';
import type { V3 } from '../math.js';
import type { PowerupKind } from '../powerups.js';

export interface RosterEntry {
  id: number; name: string; isBot: boolean; classId: ClassId; accent: number;
  kills: number; deaths: number; assists: number; power: number; ping: number;
  alive: boolean; connected: boolean; damage: number; shotsFired: number; shotsHit: number;
  oranges: number; peakPower: number; tier: number; maxShield: number;
  /** mode score (kills in ffa; what daily modes rank on) and mine-run checkpoints passed */
  score: number; checkpoint: number;
}

export interface PickupInfo { id: number; pos: V3; units: number; drop: boolean; expireTick: number; killerId: number }
/** the live powerup, else when and where the next appears (null outside a match) */
export interface PowerupInfo { live: { id: number; kind: PowerupKind; pos: V3 } | null; next: { tick: number; pos: V3 } | null }

export type ClientMsg =
  | { t: 'hello'; name: string; classId: ClassId; version: string; token?: string }
  | { t: 'class'; classId: ClassId }
  | { t: 'hold'; hold: boolean };

export type ServerMsg =
  | { t: 'welcome'; shipId: number; token: string; tick: number; roomId: string; version: string; arena: string }
  | { t: 'reload'; version: string }
  | { t: 'full' }
  | { t: 'roster'; players: RosterEntry[] }
  /**
   * `arena` is the map being played (it changes between matches); `nextArena` the one after it.
   * `mode` is ffa or a daily challenge; `wave` is survival's current wave; `course` is mine-run's checkpoints in order.
   */
  | {
    t: 'match'; phase: MatchPhase; phaseEndTick: number; winnerId: number; tick: number; arena: string; nextArena: string;
    mode: GameMode; wave: number; course: V3[];
  }
  | { t: 'pickups'; list: PickupInfo[]; powerup: PowerupInfo }
  | { t: 'ev'; tick: number; list: GameEvent[] }
  | { t: 'vanish'; shipId: number };

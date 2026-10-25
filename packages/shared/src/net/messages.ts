import type { ClassId } from '../classes/types.js';
import type { GameEvent, MatchPhase } from '../entities.js';
import type { V3 } from '../math.js';

export interface RosterEntry {
  id: number; name: string; isBot: boolean; classId: ClassId; accent: number;
  kills: number; deaths: number; assists: number; power: number; ping: number;
  alive: boolean; connected: boolean; damage: number; shotsFired: number; shotsHit: number;
  oranges: number; peakPower: number; tier: number; maxShield: number;
}

export interface PickupInfo { id: number; pos: V3; units: number; drop: boolean; expireTick: number; killerId: number }

export type ClientMsg =
  | { t: 'hello'; name: string; classId: ClassId; version: string; token?: string }
  | { t: 'class'; classId: ClassId }
  | { t: 'hold'; hold: boolean };

export type ServerMsg =
  | { t: 'welcome'; shipId: number; token: string; tick: number; roomId: string; version: string; arena: string }
  | { t: 'reload'; version: string }
  | { t: 'full' }
  | { t: 'roster'; players: RosterEntry[] }
  /** `arena` is the map being played (it changes between matches); `nextArena` the one after it */
  | { t: 'match'; phase: MatchPhase; phaseEndTick: number; winnerId: number; tick: number; arena: string; nextArena: string }
  | { t: 'pickups'; list: PickupInfo[] }
  | { t: 'ev'; tick: number; list: GameEvent[] }
  | { t: 'vanish'; shipId: number };

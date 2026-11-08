import type { ClassId } from './classes/types.js';
import { DT } from './constants.js';
import type { GameSim } from './game.js';
import { standings } from './match.js';

/** One player's final line in a finished match. `token` is server-side only — never wire-broadcast. */
export interface MatchReportPlayer {
  playerId: string;
  /** full identity token for humans, null for bots (sink-internal only) */
  token: string | null;
  name: string;
  classId: ClassId;
  isBot: boolean;
  kills: number;
  deaths: number;
  assists: number;
  damageDealt: number;
  shotsFired: number;
  shotsHit: number;
  orangesCollected: number;
  peakPower: number;
  /** 1-based, standings order (kills desc, deaths asc, damage desc) */
  placement: number;
}

/** Server-internal record of a finished match, handed to the MatchSink. */
export interface MatchReport {
  roomId: string;
  matchNumber: number;
  mode: string;
  arena: string;
  startTick: number;
  endTick: number;
  durationS: number;
  /** winner's playerId, or null (no ships / draw) */
  winnerPlayerId: string | null;
  players: MatchReportPlayer[];
}

/** Consumers implement this; the room calls it once per finished match. Failures are contained. */
export interface MatchSink {
  onMatchEnd(report: MatchReport): void;
}

export function buildMatchReport(
  sim: GameSim,
  opts: { roomId: string; mode: string; tokenOf?: (shipId: number) => string | null },
): MatchReport {
  const order = standings(sim.shipList);
  const winner = sim.match.winnerId >= 0 ? sim.shipList.find((s) => s.id === sim.match.winnerId) : undefined;
  return {
    roomId: opts.roomId,
    matchNumber: sim.match.matchNumber,
    mode: opts.mode,
    arena: sim.arena.blueprint.id,
    startTick: sim.match.startTick,
    endTick: sim.tick,
    durationS: Math.round((sim.tick - sim.match.startTick) * DT),
    winnerPlayerId: winner ? winner.playerId : null,
    players: order.map((s, i) => ({
      playerId: s.playerId,
      token: s.isBot ? null : (opts.tokenOf?.(s.id) ?? null),
      name: s.name,
      classId: s.def.id,
      isBot: s.isBot,
      kills: s.stats.kills,
      deaths: s.stats.deaths,
      assists: s.stats.assists,
      damageDealt: Math.round(s.stats.damageDealt),
      shotsFired: s.stats.shotsFired,
      shotsHit: s.stats.shotsHit,
      orangesCollected: s.stats.orangesCollected,
      peakPower: Math.round(s.stats.peakPower),
      placement: i + 1,
    })),
  };
}

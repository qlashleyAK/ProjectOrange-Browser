import type { SpawnPoint } from './arena/generate.js';
import { placeAt } from './arena/generate.js';
import { DT, KILLS_TO_WIN, MATCH_DURATION_S, POSTMATCH_S } from './constants.js';
import type { MatchPhase, Ship } from './entities.js';
import type { GameSim } from './game.js';
import { vdist } from './math.js';
import { lineOfSight } from './physicsWorld.js';

export interface MatchState {
  phase: MatchPhase;
  phaseEndTick: number;
  startTick: number;
  winnerId: number;
  matchNumber: number;
}

export function newMatch(): MatchState {
  return { phase: 'waiting', phaseEndTick: 0, startTick: 0, winnerId: -1, matchNumber: 0 };
}

/** Kills desc, then fewest deaths, then most damage. */
export function standings(ships: Ship[]): Ship[] {
  return ships.slice().sort((a, b) =>
    b.stats.kills - a.stats.kills || a.stats.deaths - b.stats.deaths || b.stats.damageDealt - a.stats.damageDealt || a.id - b.id);
}

function setPhase(sim: GameSim, phase: MatchPhase, durationS: number): void {
  sim.match.phase = phase;
  sim.match.phaseEndTick = sim.tick + Math.round(durationS / DT);
  sim.emit({ t: 'phase', phase });
}

export function updateMatch(sim: GameSim): void {
  const m = sim.match;
  const n = sim.shipList.length;
  switch (m.phase) {
    case 'waiting':
      if (n >= 2) setPhase(sim, 'warmup', sim.warmupSeconds);
      break;
    case 'warmup':
      if (sim.tick >= m.phaseEndTick) {
        sim.resetRound();
        m.startTick = sim.tick;
        m.winnerId = -1;
        m.matchNumber++;
        setPhase(sim, 'inProgress', MATCH_DURATION_S);
      }
      break;
    case 'inProgress': {
      if (n < 2) { setPhase(sim, 'waiting', 0); break; }
      const top = standings(sim.shipList)[0];
      if ((top && top.stats.kills >= KILLS_TO_WIN) || sim.tick >= m.phaseEndTick) {
        m.winnerId = top ? top.id : -1;
        sim.emit({ t: 'matchEnd', winnerId: m.winnerId });
        setPhase(sim, 'postMatch', POSTMATCH_S);
      }
      break;
    }
    case 'postMatch':
      if (sim.tick >= m.phaseEndTick) {
        sim.resetRound();
        setPhase(sim, n >= 2 ? 'warmup' : 'waiting', sim.warmupSeconds);
      }
      break;
  }
}

/** Score spawn points: far from enemies (>120 m), no line of sight, no recent combat in the room. */
export function chooseSpawn(sim: GameSim, ship: Ship): SpawnPoint {
  const enemies = sim.shipList.filter((s) => s.alive && s.id !== ship.id);
  const scored = sim.arena.spawns.map((sp) => {
    let minD = Infinity, seen = false;
    for (const e of enemies) {
      const d = vdist(e.pos, sp.pos);
      if (d < minD) minD = d;
      if (!seen && d < 600 && lineOfSight(sim.world, sp.pos, e.pos)) seen = true;
    }
    const room = placeAt(sim.arena, sp.pos)?.id;
    const hot = sim.combatLog.some((c) => sim.tick - c.tick < 5 * 60 && c.place === room);
    const score = Math.min(minD, 120) / 60 + (minD > 120 ? 1 : 0) + (seen ? 0 : 1.5) + (hot ? -2 : 0);
    return { sp, score };
  }).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  return top[sim.rng.int(0, top.length)]!.sp;
}

export { KILLS_TO_WIN };

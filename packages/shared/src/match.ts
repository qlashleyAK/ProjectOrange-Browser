import type { SpawnPoint } from './arena/generate.js';
import { placeAt } from './arena/generate.js';
import {
  DAILY_MATCH_DURATION_S, DT, KILLS_TO_WIN, MATCH_DURATION_S, POSTMATCH_S, SURVIVAL_WAVE_GAP_S,
} from './constants.js';
import type { GameMode, MatchPhase, Ship } from './entities.js';
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

/** Mode score: what the daily leaderboards rank on. */
export function modeScore(s: Ship, mode: GameMode, sim: GameSim): number {
  switch (mode) {
    case 'score-attack':
      return s.stats.kills * 100 + s.stats.assists * 25 + s.stats.orangesCollected * 10;
    case 'survival':
      return sim.wave * 1000 + s.stats.kills * 100 + Math.floor(s.stats.damageDealt / 10);
    case 'mine-run':
      return s.checkpoint * 1000 - (s.courseDoneTick > 0 ? Math.round((s.courseDoneTick - sim.match.startTick) * DT) : 0);
    default:
      return s.stats.kills;
  }
}

/** Mode-aware standings: FFA by the classic order, daily modes by mode score. */
export function ranked(sim: GameSim): Ship[] {
  if (sim.mode === 'ffa') return standings(sim.shipList);
  return sim.shipList.slice().sort((a, b) => modeScore(b, sim.mode, sim) - modeScore(a, sim.mode, sim) || a.id - b.id);
}

function setPhase(sim: GameSim, phase: MatchPhase, durationS: number): void {
  sim.match.phase = phase;
  sim.match.phaseEndTick = sim.tick + Math.round(durationS / DT);
  sim.emit({ t: 'phase', phase });
}

export function updateMatch(sim: GameSim): void {
  const m = sim.match;
  const n = sim.shipList.length;
  const daily = sim.mode !== 'ffa';
  const minPlayers = daily ? 1 : 2;
  const duration = daily ? DAILY_MATCH_DURATION_S : MATCH_DURATION_S;
  switch (m.phase) {
    case 'waiting':
      if (n >= minPlayers) setPhase(sim, 'warmup', sim.warmupSeconds);
      break;
    case 'warmup':
      if (sim.tick >= m.phaseEndTick) {
        sim.resetRound();
        m.startTick = sim.tick;
        m.winnerId = -1;
        m.matchNumber++;
        setPhase(sim, 'inProgress', duration);
        if (sim.mode === 'survival') sim.waveNextAtTick = sim.tick; // first wave immediately
      }
      break;
    case 'inProgress': {
      if (n < minPlayers) { setPhase(sim, 'waiting', 0); break; }
      if (sim.mode === 'survival') {
        // waves: spawn on schedule; when the wave is cleared, line up the next one
        const aliveBots = sim.shipList.filter((s) => s.isBot && s.alive).length;
        if (sim.waveNextAtTick >= 0 && sim.tick >= sim.waveNextAtTick) {
          if (aliveBots === 0) { sim.spawnWave(); sim.waveNextAtTick = -1; }
          else sim.waveNextAtTick = sim.tick + Math.round(SURVIVAL_WAVE_GAP_S / DT); // retry later
        } else if (sim.waveNextAtTick < 0 && aliveBots === 0) {
          sim.waveNextAtTick = sim.tick + Math.round(SURVIVAL_WAVE_GAP_S / DT);
        }
        const aliveHumans = sim.shipList.filter((s) => !s.isBot && s.alive).length;
        if (aliveHumans === 0) {
          const top = ranked(sim).find((s) => !s.isBot) ?? ranked(sim)[0];
          m.winnerId = top ? top.id : -1;
          sim.emit({ t: 'matchEnd', winnerId: m.winnerId });
          setPhase(sim, 'postMatch', POSTMATCH_S);
        }
        break;
      }
      if (sim.mode === 'mine-run') {
        const finished = sim.shipList.filter((s) => s.courseDoneTick > 0);
        const done = finished.length > 0;
        if (done || sim.tick >= m.phaseEndTick) {
          const top = ranked(sim)[0];
          m.winnerId = top ? top.id : -1;
          sim.emit({ t: 'matchEnd', winnerId: m.winnerId });
          setPhase(sim, 'postMatch', POSTMATCH_S);
        }
        break;
      }
      // ffa / score-attack: kill-cap (ffa only) or clock
      const top = ranked(sim)[0];
      const capHit = sim.mode === 'ffa' && top && top.stats.kills >= KILLS_TO_WIN;
      if (capHit || sim.tick >= m.phaseEndTick) {
        m.winnerId = top ? top.id : -1;
        sim.emit({ t: 'matchEnd', winnerId: m.winnerId });
        setPhase(sim, 'postMatch', POSTMATCH_S);
      }
      break;
    }
    case 'postMatch':
      if (sim.tick >= m.phaseEndTick) {
        if (!daily) sim.rotateArena();
        sim.resetRound();
        setPhase(sim, n >= minPlayers ? 'warmup' : 'waiting', sim.warmupSeconds);
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

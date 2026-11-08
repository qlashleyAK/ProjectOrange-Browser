import type { GameMode } from './entities.js';

/** The daily challenge rotation — BSG division names, three moods of play. */
export const DAILY_MODES: readonly GameMode[] = ['survival', 'score-attack', 'mine-run'];

/**
 * Deterministic daily challenge: same date + mode + seed for every server,
 * forever. Mode rotates by day-of-cycle; seed is a hash of the date.
 */
export function dailyChallenge(date: string): { date: string; mode: GameMode; seed: number } {
  const days = Math.floor(Date.parse(date + 'T00:00:00Z') / 86400000);
  if (!Number.isFinite(days)) throw new Error(`bad date: ${date}`);
  const mode = DAILY_MODES[((days % DAILY_MODES.length) + DAILY_MODES.length) % DAILY_MODES.length]!;
  let h = 2166136261;
  for (const ch of date) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const seed = (h ^ Math.imul(days, 2654435761)) >>> 0;
  return { date, mode, seed };
}

/** Today's challenge in UTC. */
export function todayChallenge(): { date: string; mode: GameMode; seed: number } {
  return dailyChallenge(new Date().toISOString().slice(0, 10));
}

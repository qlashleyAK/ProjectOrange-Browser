/** Ranked-duel ELO + the Battlestar Galactica Colonial Fleet ladder. */

/** Standard ELO: K=32, start 1200 (Lieutenant — you earn your wings). */
export const ELO_START = 1200;
export const ELO_K = 32;

/** Expected score of `a` against `b` (0..1). */
export function expectedScore(eloA: number, eloB: number): number {
  return 1 / (1 + 10 ** ((eloB - eloA) / 400));
}

/** New ELO pair after a duel. `scoreA` is 1 (win), 0 (loss); 0.5 for a draw (not used yet). */
export function duelOutcome(eloA: number, eloB: number, scoreA: number, k = ELO_K): { a: number; b: number; deltaA: number; deltaB: number } {
  const deltaA = Math.round(k * (scoreA - expectedScore(eloA, eloB)));
  return { a: eloA + deltaA, b: eloB - deltaA, deltaA, deltaB: -deltaA };
}

/** Colonial Fleet ladder, low to high. Threshold = minimum ELO to hold the rank. */
export const RANKS: readonly { name: string; min: number }[] = Object.freeze([
  { name: 'Nugget', min: 0 },
  { name: 'Ensign', min: 900 },
  { name: 'Lieutenant JG', min: 1050 },
  { name: 'Lieutenant', min: 1150 },
  { name: 'Captain', min: 1275 },
  { name: 'Major', min: 1400 },
  { name: 'Colonel', min: 1525 },
  { name: 'Commander', min: 1650 },
  { name: 'Admiral', min: 1800 },
]);

/** The season's #1 by ELO holds the CAG title in addition to their rank. */
export const CAG_TITLE = 'CAG';

/** Rank for an ELO rating (highest threshold <= rating). */
export function rankFor(elo: number): { name: string; min: number } {
  let r = RANKS[0]!;
  for (const cand of RANKS) if (elo >= cand.min) r = cand;
  return r;
}

/** Progress toward the next promotion: 0..1 (1 = at the top rank). */
export function rankProgress(elo: number): number {
  const i = RANKS.indexOf(rankFor(elo));
  if (i >= RANKS.length - 1) return 1;
  const cur = RANKS[i]!.min === 0 && elo < RANKS[1]!.min ? RANKS[1]!.min - 200 : RANKS[i]!.min;
  const next = RANKS[i + 1]!.min;
  return Math.max(0, Math.min(1, (elo - cur) / (next - cur)));
}
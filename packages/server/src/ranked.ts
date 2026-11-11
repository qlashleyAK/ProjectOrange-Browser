import { DatabaseSync } from 'node:sqlite';
import { ELO_START, duelOutcome, rankFor, type MatchReport } from '@orange/shared';

/**
 * Ranked-duel state: queue pairing + ELO persistence on top of MatchStore's
 * schema. Kept separate from db.ts so the queue logic stays testable without
 * a live HTTP server.
 */

/** Add missing ranked columns to an existing DB (idempotent, pre-launch). */
export function migrateRanked(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE players ADD COLUMN elo INTEGER NOT NULL DEFAULT ${ELO_START}`);
    db.exec('ALTER TABLE match_players ADD COLUMN elo_delta INTEGER');
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK'); // columns already exist
  }
}

/** One pilot waiting for a duel. */
interface QueueEntry { token: string; handle: string; elo: number; joinedAt: number; ip: string | null }

/** Matched pair awaiting pickup by the second poller. */
export interface MatchedPair { a: QueueEntry; b: QueueEntry; room: string; createdAt: number }

const QUEUE_TTL_MS = 120_000;
const PAIR_TTL_MS = 30_000;
/** Same-IP pairings wait this long before pairing (Sybil penalty — same-house players still pair, just slower). */
const SAME_IP_PAIR_DELAY_MS = 45_000;
/** Minimum duels vs. distinct opponents before the ladder shows a pilot (Sybil ELO farms stay off the board). */
export const MIN_REAL_OPPONENT_DUELS = 3;

/** Sanitize a queue handle the same way the WS hello path sanitizes names. */
function sanitizeHandle(handle: string): string {
  return String(handle ?? '').replace(/[^\w \-.]/g, '').slice(0, 16).trim() || 'Pilot';
}

export class RankedQueue {
  private queue: QueueEntry[] = [];
  private matched = new Map<string, MatchedPair>(); // token -> pair

  constructor(
    private db: DatabaseSync,
    private createRoom: (a: QueueEntry, b: QueueEntry) => string,
    private now: () => number = () => Date.now(),
  ) {}

  private eloOf(token: string): number {
    const row = this.db.prepare('SELECT elo FROM players WHERE token = ?').get(token) as { elo: number } | undefined;
    return row?.elo ?? ELO_START;
  }

  private sweep(): void {
    const now = this.now();
    this.queue = this.queue.filter((e) => now - e.joinedAt < QUEUE_TTL_MS);
    for (const [tok, pair] of this.matched) if (now - pair.createdAt > PAIR_TTL_MS) this.matched.delete(tok);
  }

  /** Poll the queue: pair with a waiting opponent or join and wait. `ip` enables the same-IP pairing penalty. */
  join(token: string, handle: string, ip: string | null = null): { status: 'queued'; position: number; elo: number; waitMs?: number } | { status: 'matched'; room: string; elo: number; opponent: string; opponentElo: number } {
    this.sweep();
    const pending = this.matched.get(token);
    if (pending) {
      this.matched.delete(token); // one-shot pickup
      const me = pending.a.token === token ? pending.a : pending.b;
      const opp = pending.a.token === token ? pending.b : pending.a;
      return { status: 'matched', room: pending.room, elo: me.elo, opponent: opp.handle, opponentElo: opp.elo };
    }
    const sanitized = sanitizeHandle(handle);
    // already queued? refresh
    const mine = this.queue.find((e) => e.token === token);
    if (mine) {
      mine.joinedAt = this.now();
      mine.handle = sanitized;
      return { status: 'queued', position: this.queue.indexOf(mine) + 1, elo: mine.elo };
    }
    const me: QueueEntry = { token, handle: sanitized, elo: this.eloOf(token), joinedAt: this.now(), ip };
    // Sybil penalty: a waiting opponent from the same IP only pairs after the delay
    // window (same-house players still get their duel, just not instantly).
    const now = this.now();
    const candidates = this.queue.filter((e) => !e.ip || !ip || e.ip !== ip || now - e.joinedAt >= SAME_IP_PAIR_DELAY_MS);
    const opp = candidates.length ? this.queue.splice(this.queue.indexOf(candidates[0]!), 1)[0]! : null;
    if (opp) {
      const room = this.createRoom(opp, me);
      const pair: MatchedPair = { a: opp, b: me, room, createdAt: this.now() };
      this.matched.set(opp.token, pair);
      return { status: 'matched', room, elo: me.elo, opponent: opp.handle, opponentElo: opp.elo };
    }
    this.queue.push(me);
    return { status: 'queued', position: this.queue.length, elo: me.elo };
  }

  /** Leave the queue (disconnect, cancel). */
  leave(token: string): void {
    this.queue = this.queue.filter((e) => e.token !== token);
  }

  /** Apply ELO for a finished duel. Called from the match sink. */
  applyDuel(report: MatchReport, matchId: number): void {
    const humans = report.players.filter((p) => !p.isBot && p.token);
    if (humans.length !== 2) return;
    const [a, b] = [humans[0]!, humans[1]!];
    const scoreA = report.winnerPlayerId === a.playerId ? 1 : 0;
    const eloA = this.db.prepare('SELECT elo FROM players WHERE token = ?').get(a.token!) as { elo: number } | undefined;
    const eloB = this.db.prepare('SELECT elo FROM players WHERE token = ?').get(b.token!) as { elo: number } | undefined;
    const out = duelOutcome(eloA?.elo ?? ELO_START, eloB?.elo ?? ELO_START, scoreA);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE players SET elo = ? WHERE token = ?').run(out.a, a.token!);
      this.db.prepare('UPDATE players SET elo = ? WHERE token = ?').run(out.b, b.token!);
      for (const p of [a, b]) {
        const d = p.playerId === a.playerId ? out.deltaA : out.deltaB;
        this.db.prepare('UPDATE match_players SET elo_delta = ? WHERE match_id = ? AND player_id = ?').run(d, matchId, p.playerId);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The Colonial Fleet ladder: active pilots by ELO, only pilots with enough duels vs. DISTINCT opponents (Sybil farms stay off the board). */
  ladder(limit = 50): { handle: string; elo: number; rank: string; duels: number; wins: number }[] {
    return (this.db.prepare(`
      SELECT p.handle AS handle, p.elo AS elo, p.last_seen AS last_seen,
             COALESCE(d.duels, 0) AS duels, COALESCE(d.wins, 0) AS wins,
             COALESCE(o.real_opponents, 0) AS real_opponents
      FROM players p
      LEFT JOIN (
        SELECT mp.token AS token, COUNT(*) AS duels,
               SUM(CASE WHEN m.winner = mp.player_id THEN 1 ELSE 0 END) AS wins
        FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE m.mode = 'ranked-duel' GROUP BY mp.token
      ) d ON d.token = p.token
      LEFT JOIN (
        SELECT mp.token AS token, COUNT(DISTINCT other.player_id) AS real_opponents
        FROM match_players mp
        JOIN match_players other ON other.match_id = mp.match_id AND other.player_id != mp.player_id AND other.is_bot = 0
        JOIN matches m ON m.id = mp.match_id AND m.mode = 'ranked-duel'
        GROUP BY mp.token
      ) o ON o.token = p.token
      WHERE COALESCE(o.real_opponents, 0) >= ?
      ORDER BY p.elo DESC, p.last_seen DESC LIMIT ?`,
    ).all(MIN_REAL_OPPONENT_DUELS, limit) as { handle: string; elo: number; duels: number; wins: number; real_opponents: number; last_seen: number }[])
      .map((r) => ({ handle: r.handle, elo: r.elo, rank: rankFor(r.elo).name, duels: r.duels, wins: r.wins }));
  }
}
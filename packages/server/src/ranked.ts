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
interface QueueEntry { token: string; handle: string; elo: number; joinedAt: number }

/** Matched pair awaiting pickup by the second poller. */
export interface MatchedPair { a: QueueEntry; b: QueueEntry; room: string; createdAt: number }

const QUEUE_TTL_MS = 120_000;
const PAIR_TTL_MS = 30_000;

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

  /** Poll the queue: pair with a waiting opponent or join and wait. */
  join(token: string, handle: string): { status: 'queued'; position: number; elo: number } | { status: 'matched'; room: string; elo: number; opponent: string; opponentElo: number } {
    this.sweep();
    const pending = this.matched.get(token);
    if (pending) {
      this.matched.delete(token); // one-shot pickup
      const me = pending.a.token === token ? pending.a : pending.b;
      const opp = pending.a.token === token ? pending.b : pending.a;
      return { status: 'matched', room: pending.room, elo: me.elo, opponent: opp.handle, opponentElo: opp.elo };
    }
    // already queued? refresh
    const mine = this.queue.find((e) => e.token === token);
    if (mine) {
      mine.joinedAt = this.now();
      return { status: 'queued', position: this.queue.indexOf(mine) + 1, elo: mine.elo };
    }
    const opp = this.queue.shift();
    const me: QueueEntry = { token, handle, elo: this.eloOf(token), joinedAt: this.now() };
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

  /** The Colonial Fleet ladder: active pilots by ELO. */
  ladder(limit = 50): { handle: string; elo: number; rank: string; duels: number; wins: number }[] {
    return (this.db.prepare(`
      SELECT p.handle AS handle, p.elo AS elo, p.last_seen AS last_seen,
             COALESCE(d.duels, 0) AS duels, COALESCE(d.wins, 0) AS wins
      FROM players p
      LEFT JOIN (
        SELECT mp.token AS token, COUNT(*) AS duels,
               SUM(CASE WHEN m.winner = mp.player_id THEN 1 ELSE 0 END) AS wins
        FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE m.mode = 'ranked-duel' GROUP BY mp.token
      ) d ON d.token = p.token
      ORDER BY p.elo DESC, p.last_seen DESC LIMIT ?`,
    ).all(limit) as { handle: string; elo: number; duels: number; wins: number; last_seen: number }[])
      .map((r) => ({ handle: r.handle, elo: r.elo, rank: rankFor(r.elo).name, duels: r.duels, wins: r.wins }));
  }
}
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dailyChallenge, type MatchReport } from '@orange/shared';

/**
 * SQLite persistence for matches, players and daily seeds. Uses node:sqlite
 * (built in since Node 22.5) — no native dependency to compile or ship.
 * WAL journaling: the room tick thread never blocks on a checkpointer.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  token       TEXT PRIMARY KEY,
  handle      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     TEXT NOT NULL,
  arena       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  match_no    INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  duration_s  INTEGER NOT NULL,
  winner      TEXT,
  humans      INTEGER NOT NULL,
  bots        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL,
  token       TEXT,
  name        TEXT NOT NULL,
  is_bot      INTEGER NOT NULL,
  class_id    TEXT NOT NULL,
  kills       INTEGER NOT NULL,
  deaths      INTEGER NOT NULL,
  assists     INTEGER NOT NULL,
  damage      INTEGER NOT NULL,
  shots       INTEGER NOT NULL,
  hits        INTEGER NOT NULL,
  oranges     INTEGER NOT NULL,
  peak_power  INTEGER NOT NULL,
  score       INTEGER NOT NULL DEFAULT 0,
  placement   INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_match_players_token ON match_players(token, match_id);
CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at);
CREATE TABLE IF NOT EXISTS daily_seeds (
  date        TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,
  seed        INTEGER NOT NULL
);
`;

export interface LeaderboardRow {
  handle: string; kills: number; deaths: number; assists: number; wins: number;
  matches: number; damage: number; best_placement: number; last_seen: number;
}

export interface PilotProfile {
  handle: string; firstSeen: number; lastSeen: number;
  matches: number; wins: number; kills: number; deaths: number; assists: number; damage: number;
  shots: number; hits: number; oranges: number; peak_power: number; best_placement: number; seconds: number;
  /** most-flown first */
  classes: { classId: string; matches: number; kills: number }[];
}

/** `:memory:` for tests; a file path for production (`ORANGE_DB` env). */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export class MatchStore {
  constructor(private db: DatabaseSync) {}

  recordMatch(r: MatchReport): number {
    const now = Date.now();
    const humans = r.players.filter((p) => !p.isBot);
    this.db.exec('BEGIN');
    try {
      const m = this.db
        .prepare('INSERT INTO matches (room_id, arena, mode, match_no, started_at, ended_at, duration_s, winner, humans, bots) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.roomId, r.arena, r.mode, r.matchNumber, now - r.durationS * 1000, now, r.durationS, r.winnerPlayerId, humans.length, r.players.length - humans.length);
      const matchId = Number(m.lastInsertRowid);
      const ins = this.db.prepare(
        'INSERT INTO match_players (match_id, player_id, token, name, is_bot, class_id, kills, deaths, assists, damage, shots, hits, oranges, peak_power, score, placement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const p of r.players) {
        ins.run(matchId, p.playerId, p.token, p.name, p.isBot ? 1 : 0, p.classId, p.kills, p.deaths, p.assists, p.damageDealt, p.shotsFired, p.shotsHit, p.orangesCollected, p.peakPower, p.score, p.placement);
        if (!p.isBot && p.token) {
          this.db
            .prepare('INSERT INTO players (token, handle, created_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET handle = excluded.handle, last_seen = excluded.last_seen')
            .run(p.token, p.name, now, now);
        }
      }
      this.db.exec('COMMIT');
      return matchId;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** window: seconds back from now (e.g. 86400 = daily, 604800 = weekly, 0 = all time). */
  leaderboard(windowS: number, limit = 50): LeaderboardRow[] {
    const since = windowS > 0 ? Date.now() - windowS * 1000 : 0;
    const rows = this.db.prepare(`
      SELECT p.handle AS handle,
             SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths, SUM(mp.assists) AS assists,
             SUM(mp.damage) AS damage, COUNT(*) AS matches,
             SUM(CASE WHEN m.winner = mp.player_id THEN 1 ELSE 0 END) AS wins,
             MIN(mp.placement) AS best_placement,
             MAX(p.last_seen) AS last_seen
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      LEFT JOIN players p ON p.token = mp.token
      WHERE mp.is_bot = 0 AND (? = 0 OR m.ended_at >= ?)
      GROUP BY COALESCE(p.handle, mp.name)
      ORDER BY kills DESC, deaths ASC, damage DESC
      LIMIT ?`,
    ).all(since, since, limit) as unknown[] as LeaderboardRow[];
    return rows;
  }

  /** Lifetime stats for one identity token, or null if it has never finished a match. */
  profile(token: string): PilotProfile | null {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS matches,
             SUM(CASE WHEN m.winner = mp.player_id THEN 1 ELSE 0 END) AS wins,
             SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths, SUM(mp.assists) AS assists,
             SUM(mp.damage) AS damage, SUM(mp.shots) AS shots, SUM(mp.hits) AS hits,
             SUM(mp.oranges) AS oranges, MAX(mp.peak_power) AS peak_power, MIN(mp.placement) AS best_placement,
             SUM(m.duration_s) AS seconds
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.token = ? AND mp.is_bot = 0`,
    ).get(token) as Omit<PilotProfile, 'handle' | 'firstSeen' | 'lastSeen' | 'classes'> | undefined;
    if (!row || !row.matches) return null;
    const who = this.db.prepare('SELECT handle, created_at, last_seen FROM players WHERE token = ?').get(token) as
      { handle: string; created_at: number; last_seen: number } | undefined;
    const classes = this.db.prepare(`
      SELECT class_id AS classId, COUNT(*) AS matches, SUM(kills) AS kills
      FROM match_players WHERE token = ? AND is_bot = 0
      GROUP BY class_id ORDER BY matches DESC, kills DESC`,
    ).all(token) as unknown[] as PilotProfile['classes'];
    return { ...row, handle: who?.handle ?? '', firstSeen: who?.created_at ?? 0, lastSeen: who?.last_seen ?? 0, classes };
  }

  recentMatches(limit = 20): unknown[] {
    return this.db.prepare(`
      SELECT m.id, m.room_id, m.arena, m.mode, m.ended_at, m.duration_s, m.winner, m.humans, m.bots,
             (SELECT name FROM match_players mp WHERE mp.match_id = m.id AND mp.player_id = m.winner) AS winner_name
      FROM matches m ORDER BY m.ended_at DESC LIMIT ?`,
    ).all(limit);
  }

  /** Deterministic daily challenge (shared dailyChallenge fn, cached for the record). */
  dailySeed(date: string): { date: string; mode: string; seed: number } {
    const challenge = dailyChallenge(date);
    this.db.prepare('INSERT OR IGNORE INTO daily_seeds (date, mode, seed) VALUES (?, ?, ?)').run(challenge.date, challenge.mode, challenge.seed);
    return challenge;
  }

  /**
   * Daily leaderboard: each pilot's BEST run on a given day's challenge, best first — replaying can only
   * improve your line, never fill the board. (SQLite returns the bare columns from the MAX(score) row.)
   */
  dailyLeaderboard(date: string, limit = 50): unknown[] {
    const c = dailyChallenge(date);
    const from = Date.parse(date + 'T00:00:00Z');
    const to = from + 86400000;
    return this.db.prepare(`
      SELECT COALESCE(p.handle, mp.name) AS handle, MAX(mp.score) AS score, mp.kills, mp.deaths, mp.oranges, mp.placement, m.ended_at, m.arena,
             COUNT(*) AS runs
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      LEFT JOIN players p ON p.token = mp.token
      WHERE mp.is_bot = 0 AND m.mode = ? AND m.ended_at >= ? AND m.ended_at < ?
      GROUP BY COALESCE(mp.token, mp.name)
      ORDER BY score DESC, mp.placement ASC
      LIMIT ?`,
    ).all(c.mode, from, to, limit);
  }

  close(): void { this.db.close(); }
}

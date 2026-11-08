import { afterEach, describe, expect, it } from 'vitest';
import { MatchStore, openDb } from '../src/db.js';
import { dailyChallenge, type MatchReport, type MatchReportPlayer } from '@orange/shared';

function player(partial: Partial<MatchReportPlayer> & { playerId: string; name: string }): MatchReportPlayer {
  return {
    token: null, classId: 'dart', isBot: false, kills: 0, deaths: 0, assists: 0, damageDealt: 0,
    shotsFired: 0, shotsHit: 0, orangesCollected: 0, peakPower: 0, score: 0, placement: 1, ...partial,
  };
}

function report(partial: Partial<MatchReport> = {}): MatchReport {
  return {
    roomId: 'PUB1', matchNumber: 1, mode: 'ffa', arena: 'hollowdeep',
    startTick: 0, endTick: 21600, durationS: 360,
    winnerPlayerId: 'p:aaa', players: [], ...partial,
  };
}

describe('MatchStore', () => {
  const stores: MatchStore[] = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); });
  const fresh = () => { const s = new MatchStore(openDb(':memory:')); stores.push(s); return s; };

  it('records a match with players and reads it back', () => {
    const s = fresh();
    s.recordMatch(report({
      players: [
        player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', kills: 5, deaths: 2, damageDealt: 500, placement: 1 }),
        player({ playerId: 'p:bbb', token: 'tokB', name: 'Bob', kills: 3, deaths: 4, damageDealt: 300, placement: 2 }),
        player({ playerId: 'bot:z', name: 'BotZed', isBot: true, kills: 1, placement: 3 }),
      ],
    }));
    const recent = s.recentMatches(10) as { id: number; winner: string; humans: number; bots: number; winner_name: string }[];
    expect(recent).toHaveLength(1);
    expect(recent[0]!.winner_name).toBe('Alice');
    expect(recent[0]!.humans).toBe(2);
    expect(recent[0]!.bots).toBe(1);

    const lb = s.leaderboard(0);
    expect(lb).toHaveLength(2); // bots never appear
    expect(lb[0]!.handle).toBe('Alice');
    expect(lb[0]!.kills).toBe(5);
    expect(lb[0]!.wins).toBe(1);
    expect(lb[0]!.matches).toBe(1);
  });

  it('updates players on re-matches (same token keeps one row)', () => {
    const s = fresh();
    s.recordMatch(report({ players: [player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', kills: 2 })] }));
    s.recordMatch(report({
      matchNumber: 2,
      players: [player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice2', kills: 3, placement: 1 })],
    }));
    const lb = s.leaderboard(0);
    expect(lb).toHaveLength(1);
    expect(lb[0]!.handle).toBe('Alice2'); // latest handle wins
    expect(lb[0]!.kills).toBe(5); // summed across matches
    expect(lb[0]!.matches).toBe(2);
  });

  it('windowed leaderboards only count recent matches', () => {
    const s = fresh();
    s.recordMatch(report({ players: [player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', kills: 10 })] }));
    // window of 1 second: the just-recorded match (ended_at = now) is inside; hack a stale one by direct update
    s.recordMatch(report({ matchNumber: 2, players: [player({ playerId: 'p:bbb', token: 'tokB', name: 'Bob', kills: 99, placement: 1 })] }));
    // age Bob's match 30 days
    (s as unknown as { db: { exec(sql: string): void } }).db.exec(
      "UPDATE matches SET ended_at = ended_at - 2592000000 WHERE id = (SELECT MAX(id) FROM matches)",
    );
    const week = s.leaderboard(604800);
    expect(week.map((r) => r.handle)).toEqual(['Alice']);
    const all = s.leaderboard(0);
    expect(all.map((r) => r.handle)).toEqual(['Bob', 'Alice']); // kills desc
  });

  it('profiles sum a token\'s matches and rank its ships by use', () => {
    const s = fresh();
    expect(s.profile('tokA')).toBeNull(); // never flown
    s.recordMatch(report({
      winnerPlayerId: 'p:aaa',
      players: [
        player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', classId: 'scythe', kills: 6, deaths: 1, orangesCollected: 9, peakPower: 7, shotsFired: 100, shotsHit: 40, placement: 1 }),
        player({ playerId: 'p:bbb', token: 'tokB', name: 'Bob', kills: 1, placement: 2 }),
      ],
    }));
    s.recordMatch(report({
      matchNumber: 2, winnerPlayerId: 'p:bbb',
      players: [
        player({ playerId: 'p:bbb', token: 'tokB', name: 'Bob', kills: 9, placement: 1 }),
        player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', classId: 'scythe', kills: 2, deaths: 3, orangesCollected: 1, peakPower: 3, placement: 2 }),
      ],
    }));
    s.recordMatch(report({
      matchNumber: 3, winnerPlayerId: null,
      players: [player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', classId: 'brute', kills: 1, placement: 1 })],
    }));
    const p = s.profile('tokA')!;
    expect(p.handle).toBe('Alice');
    expect(p.matches).toBe(3);
    expect(p.wins).toBe(1);
    expect(p.kills).toBe(9);
    expect(p.deaths).toBe(4);
    expect(p.oranges).toBe(10);
    expect(p.peak_power).toBe(7);
    expect(p.best_placement).toBe(1);
    expect(p.seconds).toBe(3 * 360);
    expect(p.classes.map((c) => c.classId)).toEqual(['scythe', 'brute']);
    expect(p.classes[0]).toMatchObject({ matches: 2, kills: 8 });
    expect(s.profile('tokB')!.wins).toBe(1); // other pilots unaffected
  });

  it('the daily board keeps each pilot\'s best run only', () => {
    const s = fresh();
    const today = new Date().toISOString().slice(0, 10);
    const mode = dailyChallenge(today).mode;
    const run = (token: string, name: string, score: number, n: number) => s.recordMatch(report({
      mode, matchNumber: n, roomId: `DAILY-${today}`,
      players: [player({ playerId: `p:${token}`, token, name, score }), player({ playerId: `bot:${n}`, name: 'Bot', isBot: true, score: 99999 })],
    }));
    run('tokA', 'Alice', 500, 1);
    run('tokA', 'Alice', 900, 2);
    run('tokB', 'Bob', 700, 3);
    run('tokA', 'Alice', 300, 4);
    s.recordMatch(report({ mode: 'ffa', matchNumber: 5, players: [player({ playerId: 'p:tokC', token: 'tokC', name: 'Cat', score: 5000 })] }));
    const rows = s.dailyLeaderboard(today) as { handle: string; score: number; runs: number }[];
    expect(rows.map((r) => [r.handle, r.score, r.runs])).toEqual([['Alice', 900, 3], ['Bob', 700, 1]]); // bots and other modes excluded
  });

  it('daily seeds are stable per date and rotate modes', () => {
    const s = fresh();
    const a = s.dailySeed('2026-11-08');
    const b = s.dailySeed('2026-11-08');
    expect(a).toEqual(b); // stable across calls
    expect(a.seed).toBeGreaterThan(0);
    expect(['survival', 'score-attack', 'mine-run']).toContain(a.mode);
    const c = s.dailySeed('2026-11-09');
    expect(c.mode).not.toBe(a.mode); // rotation advances
    expect(c.seed).not.toBe(a.seed);
  });

  it('a failed record rolls back cleanly (no partial rows)', () => {
    const s = fresh();
    const bad = report({
      players: [
        player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', kills: 1 }),
        // duplicate player_id violates the composite PK mid-transaction
        player({ playerId: 'p:aaa', token: 'tokA', name: 'Alice', kills: 2, placement: 2 }),
      ],
    });
    expect(() => s.recordMatch(bad)).toThrow();
    expect(s.recentMatches(10)).toHaveLength(0);
    expect(s.leaderboard(0)).toHaveLength(0);
  });
});

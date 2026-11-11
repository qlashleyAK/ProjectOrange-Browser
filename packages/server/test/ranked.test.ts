import { describe, expect, it } from 'vitest';
import { MatchStore, openDb } from '../src/db.js';
import { RankedQueue, migrateRanked } from '../src/ranked.js';
import { ELO_START, type MatchReport, type MatchReportPlayer } from '@orange/shared';

function player(partial: Partial<MatchReportPlayer> & { playerId: string; name: string }): MatchReportPlayer {
  return {
    token: null, classId: 'dart', isBot: false, kills: 0, deaths: 0, assists: 0, damageDealt: 0,
    shotsFired: 0, shotsHit: 0, orangesCollected: 0, peakPower: 0, score: 0, placement: 1, ...partial,
  };
}

function duelReport(winnerId: string, loserId: string, winnerTok: string, loserTok: string): MatchReport {
  return {
    roomId: 'RK1', matchNumber: 1, mode: 'ranked-duel', arena: 'hollowdeep',
    startTick: 0, endTick: 21600, durationS: 360, winnerPlayerId: winnerId,
    players: [
      player({ playerId: winnerId, token: winnerTok, name: 'Apollo', kills: 12, placement: 1 }),
      player({ playerId: loserId, token: loserTok, name: 'Starbuck', kills: 3, placement: 2 }),
    ],
  };
}

describe('RankedQueue', () => {
  it('pairs two waiting pilots and hands both the room', () => {
    const db = openDb(':memory:');
    migrateRanked(db);
    let made = 0;
    const q = new RankedQueue(db, () => `RK${++made}`);
    const a = q.join('tokA', 'Apollo', '10.0.0.1');
    expect(a).toMatchObject({ status: 'queued', position: 1, elo: ELO_START });
    const b = q.join('tokB', 'Starbuck', '10.0.0.2');
    expect(b).toMatchObject({ status: 'matched', room: 'RK1', opponent: 'Apollo' });
    const aAgain = q.join('tokA', 'Apollo');
    expect(aAgain).toMatchObject({ status: 'matched', room: 'RK1', opponent: 'Starbuck' });
    // one-shot: both pickups consumed the pair
    expect(q.join('tokA', 'Apollo')).toMatchObject({ status: 'queued' });
    expect(made).toBe(1);
    db.close();
  });

  it('applies ELO after a duel: winner up, loser down, ladder ordered', () => {
    const db = openDb(':memory:');
    migrateRanked(db);
    const store = new MatchStore(db);
    // register pilots via a normal match so players rows exist
    store.recordMatch({
      roomId: 'PUB1', matchNumber: 1, mode: 'ffa', arena: 'hollowdeep',
      startTick: 0, endTick: 100, durationS: 360, winnerPlayerId: null,
      players: [player({ playerId: 'p:1', token: 'tokA', name: 'Apollo' }), player({ playerId: 'p:2', token: 'tokB', name: 'Starbuck' })],
    });
    const q = new RankedQueue(db, () => 'RK1');
    const duel = (w: string, l: string, wt: string, lt: string) => {
      const mid = store.recordMatch(duelReport(w, l, wt, lt));
      q.applyDuel(duelReport(w, l, wt, lt), mid);
    };
    duel('p:1', 'p:2', 'tokA', 'tokB');  // opp p:2
    duel('p:1', 'p:3', 'tokA', 'tokB');  // opp p:3
    duel('p:1', 'p:4', 'tokA', 'tokB');  // opp p:4 -> 3 distinct opponents
    const ladder = q.ladder(10);
    // Apollo: 3 duels vs 3 distinct opponents -> visible, 3 wins, +48 elo
    expect(ladder[0]).toMatchObject({ handle: 'Apollo', wins: 3, duels: 3 });
    expect(ladder[0]!.elo).toBeGreaterThan(ELO_START); // 3 wins vs even opponents: +44
    // Starbuck: 1 distinct opponent (tokB lost only to p:1) -> below MIN, hidden from the ladder
    expect(ladder.find((r) => r.handle === 'Starbuck')).toBeUndefined();
    db.close();
  });

  it('sybil penalty: same-IP tokens do not pair instantly (but do after the window)', () => {
    const db = openDb(':memory:');
    migrateRanked(db);
    let t = 0;
    let made = 0;
    const q = new RankedQueue(db, () => `RK${++made}`, () => t);
    q.join('tokA', 'Apollo', '7.7.7.7');
    expect(q.join('tokB', 'Starbuck', '7.7.7.7')).toMatchObject({ status: 'queued', position: 2 });
    q.leave('tokB'); // Starbuck leaves; Apollo (same IP) keeps waiting
    t = 46_000; // past the same-IP window
    const b = q.join('tokC', 'Helo', '7.7.7.7');
    expect(b.status).toBe('matched'); // same-IP pair allowed after the window
    expect(b.opponent).toBe('Apollo');
    db.close();
  });

  it('ladder hides pilots with too few distinct opponents (sybil farm invisible)', () => {
    const db = openDb(':memory:');
    migrateRanked(db);
    const store = new MatchStore(db);
    const q = new RankedQueue(db, () => 'RK1');
    // a legit pilot (tokA) duels THREE distinct opponents; a farmer (tokZ) duels only itself (tokZ2)
    const duel = (w: string, l: string, wt: string, lt: string) => {
      const mid = store.recordMatch(duelReport(w, l, wt, lt));
      q.applyDuel(duelReport(w, l, wt, lt), mid);
    };
    store.recordMatch({ roomId: 'P1', matchNumber: 1, mode: 'ffa', arena: 'hollowdeep', startTick: 0, endTick: 1, durationS: 1, winnerPlayerId: null,
      players: [player({ playerId: 'p:A', token: 'tokA', name: 'Apollo' }), player({ playerId: 'p:Z', token: 'tokZ', name: 'Zed' }), player({ playerId: 'p:Z2', token: 'tokZ2', name: 'Zed2' })] });
    duel('p:A', 'p:Z', 'tokA', 'tokZ');   // real opponent 1
    duel('p:A', 'p:2', 'tokA', 'tok2');   // real opponent 2
    duel('p:A', 'p:3', 'tokA', 'tok3');   // real opponent 3
    duel('p:Z', 'p:Z2', 'tokZ', 'tokZ2'); // farmer self-duel (both same farmer)
    duel('p:Z', 'p:Z2', 'tokZ', 'tokZ2');
    const ladder = q.ladder(10);
    expect(ladder.map((r) => r.handle)).toContain('Apollo');
    expect(ladder.map((r) => r.handle)).not.toContain('Zed'); // 1 distinct opponent < MIN, hidden
    db.close();
  });

  it('queue entries expire and leave() cancels', () => {
    const db = openDb(':memory:');
    migrateRanked(db);
    let t = 0;
    const q = new RankedQueue(db, () => 'RK1', () => t);
    q.join('tokA', 'Apollo');
    q.leave('tokA');
    expect(q.join('tokB', 'Starbuck')).toMatchObject({ status: 'queued', position: 1 });
    t = 180_000; // past TTL
    expect(q.join('tokC', 'Helo')).toMatchObject({ status: 'queued', position: 1 }); // queue swept
    db.close();
  });
});
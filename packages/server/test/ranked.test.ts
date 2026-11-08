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
    const a = q.join('tokA', 'Apollo');
    expect(a).toMatchObject({ status: 'queued', position: 1, elo: ELO_START });
    const b = q.join('tokB', 'Starbuck');
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
    const mid = store.recordMatch(duelReport('p:1', 'p:2', 'tokA', 'tokB'));
    q.applyDuel(duelReport('p:1', 'p:2', 'tokA', 'tokB'), mid);
    const ladder = q.ladder(10);
    expect(ladder[0]).toMatchObject({ handle: 'Apollo', elo: ELO_START + 16, rank: 'Lieutenant', wins: 1, duels: 1 });
    expect(ladder[1]).toMatchObject({ handle: 'Starbuck', elo: ELO_START - 16 });
    expect(ladder[0]!.elo).toBeGreaterThan(ladder[1]!.elo);
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
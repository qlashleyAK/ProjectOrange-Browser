import { beforeAll, describe, expect, it } from 'vitest';
import { DT, GameRoom, initPhysics, type MatchReport } from '../src/index.js';

beforeAll(async () => { await initPhysics(); });

describe('match reporting', () => {
  it('hands a full report to the sink when a match ends', async () => {
    const reports: MatchReport[] = [];
    let t = 0;
    const room = new GameRoom({ id: 'R1', now: () => t, seed: 11, sink: { onMatchEnd: (r) => reports.push(r) } });
    const advance = (ticks: number) => { for (let i = 0; i < ticks; i++) { t += DT * 1000; room.tick(); } };

    // drive to inProgress, then fast-forward the match clock instead of simulating 6 minutes
    const deadline = Date.now() + 10_000;
    while (room.sim.match.phase !== 'inProgress' && Date.now() < deadline) advance(60);
    expect(room.sim.match.phase).toBe('inProgress');

    // rig the standings deterministically: every ship alive, top ship gets the win
    for (const [i, s] of room.sim.shipList.entries()) {
      s.stats.kills = room.sim.shipList.length - i; // descending kills -> known placement order
      s.stats.deaths = i;
      s.stats.damageDealt = 1000 * (room.sim.shipList.length - i);
    }
    room.sim.match.phaseEndTick = room.sim.tick + 2; // end in 2 ticks
    advance(4);

    expect(reports.length).toBe(1);
    const r = reports[0]!;
    expect(r.roomId).toBe('R1');
    expect(r.mode).toBe('ffa');
    expect(r.matchNumber).toBe(1);
    expect(r.players.length).toBe(room.sim.shipList.length);
    // standings order: kills desc — placement 1 is the ship we gave the most kills
    expect(r.players[0]!.placement).toBe(1);
    expect(r.players[0]!.kills).toBeGreaterThan(r.players[1]!.kills);
    expect(r.winnerPlayerId).toBe(r.players[0]!.playerId);
    // bots never carry tokens; every placement is unique
    expect(r.players.every((p) => p.isBot ? p.token === null : true)).toBe(true);
    expect(new Set(r.players.map((p) => p.placement)).size).toBe(r.players.length);
  });

  it('a throwing sink never kills the room', async () => {
    let t = 0;
    const room = new GameRoom({
      id: 'R2', now: () => t, seed: 13,
      sink: { onMatchEnd: () => { throw new Error('sink exploded'); } },
    });
    const advance = (ticks: number) => { for (let i = 0; i < ticks; i++) { t += DT * 1000; room.tick(); } };
    const deadline = Date.now() + 10_000;
    while (room.sim.match.phase !== 'inProgress' && Date.now() < deadline) advance(60);
    room.sim.match.phaseEndTick = room.sim.tick + 2;
    advance(4);
    // room must still tick and roll into the next match
    expect(room.sim.match.phase).toBe('postMatch');
    advance(Math.ceil(10 / DT));
    expect(() => advance(10)).not.toThrow();
  });
});

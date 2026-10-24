import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GameRoom, generateArena, hollowdeep, initPhysics, InputFlag, neutralInput, vdist,
  type ArenaData, type ClientLink, type InputCmd,
} from '@orange/shared';
import { OnlineSource } from '../src/modes/online';
import type { Transport } from '../src/net/transport';

let arena: ArenaData;
let fakeMs = 0;
beforeAll(async () => {
  await initPhysics();
  arena = generateArena(hollowdeep());
  vi.spyOn(performance, 'now').mockImplementation(() => fakeMs);
});
afterAll(() => { vi.restoreAllMocks(); });

/** In-memory duplex link with a one-way latency, delivering in order. */
function wire(room: GameRoom, latencyMs: number) {
  const toServer: { at: number; d: Uint8Array | string }[] = [];
  const toClient: { at: number; d: ArrayBuffer | string }[] = [];
  const link: ClientLink = {
    send: (d) => toClient.push({ at: fakeMs + latencyMs, d: typeof d === 'string' ? d : d.slice().buffer }),
    close: () => {},
  };
  const t: Transport = {
    onopen: () => {}, onmessage: () => {}, onclose: () => {}, bytesIn: 0, bytesOut: 0,
    send: (d) => { toServer.push({ at: fakeMs + latencyMs, d: typeof d === 'string' ? d : d.slice() }); },
    close: () => {},
  };
  room.connect(link);
  const pump = () => {
    while (toServer.length && toServer[0]!.at <= fakeMs) room.message(link, toServer.shift()!.d);
    while (toClient.length && toClient[0]!.at <= fakeMs) t.onmessage(toClient.shift()!.d);
  };
  return { t, pump };
}

class ScriptedInput {
  tick = 0;
  beginFrame(): void {}
  sample(): InputCmd {
    this.tick++;
    const c = neutralInput(0, 0);
    c.tFwd = 1;
    c.rYaw = Math.sin(this.tick / 40) * 0.6;
    c.rPitch = Math.cos(this.tick / 55) * 0.3;
    if (this.tick % 90 < 30) c.flags |= InputFlag.Primary;
    if (this.tick % 240 < 40) c.flags |= InputFlag.Boost;
    return c;
  }
}

describe('client netcode against a real room', () => {
  it('predicts the local ship within tolerance at 60 ms RTT and interpolates remotes', () => {
    fakeMs = 1000;
    const room = new GameRoom({ id: 'NET', now: () => fakeMs, seed: 3 });
    const { t, pump } = wire(room, 30);
    const src = new OnlineSource(arena, new ScriptedInput(), 'Tester', 'dart', { makeTransport: () => t, offline: false });
    t.onopen();
    const frameMs = 1000 / 60;
    let maxErr = 0;
    let shots = 0;
    let gen = -1, genChangedAt = 0, compared = 0;
    for (let i = 0; i < 60 * 12; i++) {
      fakeMs += frameMs;
      pump();
      room.tick();
      pump();
      src.update(frameMs / 1000);
      for (const e of src.drainEvents()) if (e.t === 'shot' && e.ownerId === src.shipId) shots++;
      const g = room.sim.ship(src.shipId)?.generation ?? -1;
      if (g !== gen) { gen = g; genChangedAt = i; }
      // skip the round-trip window after a respawn, when the server has teleported the ship and the client has not heard yet
      if (i > 60 * 2 && i - genChangedAt > 20 && src.local()?.alive) {
        // the server just consumed input `me.input.seq`; our prediction for that same input must match its result
        const me = room.sim.ship(src.shipId)!;
        const hist = (src as unknown as { predictor: { history: Map<number, { pos: { x: number; y: number; z: number } }> } }).predictor.history;
        const h = hist.get(me.input.seq);
        if (h && me.alive) { maxErr = Math.max(maxErr, vdist(h.pos, me.pos)); compared++; }
      }
    }
    expect(src.status).toBe('live');
    const stats = src.netStats();
    expect(stats.ping).toBeGreaterThan(40);
    expect(stats.ping).toBeLessThan(90);
    expect(compared).toBeGreaterThan(200);
    expect(maxErr).toBeLessThan(0.5);
    expect(shots).toBeGreaterThan(5);
    expect(src.ships().filter((v) => !v.isLocal).length).toBeGreaterThan(0);
    const corrections = (src as unknown as { predictor: { corrections: number } }).predictor.corrections;
    // steady flight in open space should rarely need replays (bot collisions can cause a few)
    expect(corrections).toBeLessThan(60);
    src.dispose();
  });
});

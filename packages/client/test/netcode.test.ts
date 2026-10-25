import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  arenaById, GameRoom, generateArena, hollowdeep, initPhysics, InputFlag, neutralInput, q4, vdist,
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

/** Sit still, hold secondary, then release so one missile launches straight ahead. */
class LaunchOnce {
  tick = 0;
  beginFrame(): void {}
  sample(): InputCmd {
    this.tick++;
    const c = neutralInput(0, 0);
    if (this.tick >= 90 && this.tick <= 140) c.flags |= InputFlag.Secondary;
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

  it('flies a launched missile instead of leaving it and its smoke at the muzzle', () => {
    fakeMs = 1000;
    const room = new GameRoom({ id: 'MSL', now: () => fakeMs, seed: 11 });
    room.sim.forceInProgress();
    const { t, pump } = wire(room, 30);
    const src = new OnlineSource(arena, new LaunchOnce(), 'Tester', 'dart', { makeTransport: () => t, offline: false });
    t.onopen();
    const frameMs = 1000 / 60;
    const first = new Map<number, { x: number; y: number; z: number; at: number }>();
    let spawns = 0;
    let parked = false;
    let placed = false;
    for (let i = 0; i < 60 * 8; i++) {
      const me = room.sim.ship(src.shipId);
      if (!placed && me?.alive) {
        // hub center, nose toward -Z, with open room ahead of the muzzle
        room.sim.placeShip(me, { x: 0, y: 0, z: 40 });
        placed = true;
      }
      fakeMs += frameMs;
      pump();
      room.tick();
      pump();
      src.update(frameMs / 1000);
      for (const e of src.drainEvents()) if (e.t === 'missileSpawn' && e.ownerId === src.shipId) spawns++;
      for (const m of src.missiles()) {
        if (m.ownerId !== src.shipId) continue;
        let seen = first.get(m.id);
        if (!seen) { seen = { x: m.pos.x, y: m.pos.y, z: m.pos.z, at: i }; first.set(m.id, seen); }
        // the old bug pinned the missile a few meters from the muzzle and rebuilt it every frame
        if (i - seen.at > 20 && vdist(seen, m.pos) < 25) parked = true;
      }
    }
    expect(placed).toBe(true);
    expect(spawns).toBe(1);
    expect(first.size).toBeGreaterThan(0);
    expect(parked).toBe(false);
    expect(src.missiles().filter((m) => m.ownerId === src.shipId)).toHaveLength(0);
    src.dispose();
  });

  it('switches to the map the room is running and predicts safe-zone state there', () => {
    fakeMs = 1000;
    const room = new GameRoom({ id: 'GYR', now: () => fakeMs, seed: 5, arena: 'gyre' });
    const { t, pump } = wire(room, 30);
    const src = new OnlineSource(arena, new ScriptedInput(), 'Tester', 'dart', { makeTransport: () => t, offline: false, resolveArena: arenaById });
    t.onopen();
    const frameMs = 1000 / 60;
    let sawSafe = false, safeMismatch = 0, maxErr = 0, compared = 0;
    let gen = -1, genChangedAt = 0;
    for (let i = 0; i < 60 * 10; i++) {
      fakeMs += frameMs;
      pump();
      room.tick();
      pump();
      src.update(frameMs / 1000);
      src.drainEvents();
      const me = room.sim.ship(src.shipId);
      const g = me?.generation ?? -1;
      if (g !== gen) { gen = g; genChangedAt = i; }
      const L = src.local();
      if (L?.alive && L.safe) sawSafe = true;
      if (i > 60 * 2 && i - genChangedAt > 20 && L?.alive && me?.alive) {
        const hist = (src as unknown as { predictor: { history: Map<number, { pos: { x: number; y: number; z: number }; st: { safe: boolean } }> } }).predictor.history;
        const h = hist.get(me.input.seq);
        if (h) { maxErr = Math.max(maxErr, vdist(h.pos, me.pos)); compared++; if (h.st.safe !== me.safe) safeMismatch++; }
      }
    }
    expect(src.arena.blueprint.id).toBe('gyre');
    expect(src.arena.movers.length).toBeGreaterThan(0);
    expect(sawSafe).toBe(true);
    expect(compared).toBeGreaterThan(200);
    expect(safeMismatch).toBeLessThan(3);
    expect(maxErr).toBeLessThan(0.5);
    src.dispose();
  });

  it('predicts being shoved by a sliding wall without corrections (movers on the server timeline)', () => {
    fakeMs = 1000;
    const room = new GameRoom({ id: 'SHV', now: () => fakeMs, seed: 5, arena: 'gyre' });
    room.sim.forceInProgress();
    const { t, pump } = wire(room, 30);
    const src = new OnlineSource(arena, new Idle(), 'Tester', 'brute', { makeTransport: () => t, offline: false, resolveArena: arenaById });
    t.onopen();
    const frameMs = 1000 / 60;
    let placedAt = -1, maxErr = 0, compared = 0, corrAtPlace = 0;
    const predictor = (src as unknown as { predictor: { corrections: number; history: Map<number, { pos: { x: number; y: number; z: number } }> } });
    for (let i = 0; i < 60 * 24; i++) {
      const me = room.sim.ship(src.shipId);
      // shutter-a is at its west end once per 16 s cycle; park just past its east edge
      if (placedAt < 0 && me?.alive && i > 120 && room.sim.tick % 960 < 8) {
        room.sim.placeShip(me, { x: 14, y: 0, z: -322 }, q4());
        placedAt = i;
      }
      fakeMs += frameMs;
      pump(); room.tick(); pump();
      src.update(frameMs / 1000);
      src.drainEvents();
      if (placedAt >= 0 && i - placedAt === 30) corrAtPlace = predictor.predictor.corrections;
      if (placedAt >= 0 && i - placedAt > 30 && me?.alive) {
        const h = predictor.predictor.history.get(me.input.seq);
        if (h) { maxErr = Math.max(maxErr, vdist(h.pos, me.pos)); compared++; }
      }
    }
    const me = room.sim.ship(src.shipId)!;
    expect(placedAt).toBeGreaterThan(0);
    expect(me.pos.x).toBeGreaterThan(40);
    expect(compared).toBeGreaterThan(200);
    expect(maxErr).toBeLessThan(0.05);
    expect(predictor.predictor.corrections - corrAtPlace).toBeLessThan(5);
    src.dispose();
  });
});

class Idle { beginFrame(): void {} sample(): InputCmd { return neutralInput(0, 0); } }

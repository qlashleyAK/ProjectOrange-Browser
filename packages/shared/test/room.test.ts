import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOT_BACKFILL_TARGET, BUILD_VERSION, DT, GameRoom, InputFlag, MAX_PARTICIPANTS, MsgType, POSTMATCH_S, Reader, decodeSnapshot,
  encodeInputPacket, initPhysics, neutralInput, type ClientLink, type ServerMsg, type Snapshot,
} from '../src/index.js';

beforeAll(async () => { await initPhysics(); });

class FakeClient implements ClientLink {
  json: ServerMsg[] = [];
  snaps: Snapshot[] = [];
  closed = false;
  send(d: Uint8Array | string): void {
    if (typeof d === 'string') { this.json.push(JSON.parse(d) as ServerMsg); return; }
    const r = new Reader(d);
    if (r.u8() === MsgType.Snapshot) this.snaps.push(decodeSnapshot(r));
  }
  close(): void { this.closed = true; }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    for (let i = this.json.length - 1; i >= 0; i--) if (this.json[i]!.t === t) return this.json[i] as Extract<ServerMsg, { t: T }>;
    return undefined;
  }
}

function makeRoom(id = 'TEST') {
  let t = 0;
  const room = new GameRoom({ id, now: () => t, seed: 7 });
  const advance = (ticks: number, each?: () => void) => { for (let i = 0; i < ticks; i++) { t += DT * 1000; each?.(); room.tick(); } };
  return { room, advance };
}

const hello = (name = 'Tester', token?: string) => JSON.stringify({ t: 'hello', name, classId: 'dart', version: BUILD_VERSION, token });

describe('GameRoom', () => {
  it('backfills bots, welcomes a player, streams snapshots and acknowledges inputs', () => {
    const { room, advance } = makeRoom();
    expect(room.participants).toBe(BOT_BACKFILL_TARGET);
    const c = new FakeClient();
    room.connect(c);
    room.message(c, hello());
    const w = c.last('welcome')!;
    expect(w).toBeDefined();
    expect(c.last('roster')!.players.some((p) => p.id === w.shipId && !p.isBot)).toBe(true);

    let seq = 0;
    advance(120, () => {
      const cmd = neutralInput(++seq, 0);
      cmd.tFwd = 1;
      room.message(c, encodeInputPacket([cmd]));
    });
    expect(c.snaps.length).toBeGreaterThan(50);
    const last = c.snaps[c.snaps.length - 1]!;
    expect(last.owner?.id).toBe(w.shipId);
    expect(seq - last.owner!.lastSeq).toBeLessThan(4);
    expect(last.ships.length).toBeGreaterThan(0);
    // a human join flags one bot for removal at its next death
    expect(room.participants).toBe(BOT_BACKFILL_TARGET);
  });

  it('rejects a mismatched version with a reload message', () => {
    const { room } = makeRoom();
    const c = new FakeClient();
    room.connect(c);
    room.message(c, JSON.stringify({ t: 'hello', name: 'Old', classId: 'dart', version: '0.0.0-old' }));
    expect(c.last('reload')).toBeDefined();
    expect(c.last('welcome')).toBeUndefined();
  });

  it('holds a disconnected slot and restores it by token', () => {
    const { room, advance } = makeRoom();
    const a = new FakeClient();
    room.connect(a);
    room.message(a, hello('Alice'));
    const w = a.last('welcome')!;
    advance(30);
    room.disconnect(a);
    advance(60 * 5);
    expect(room.sim.ship(w.shipId)?.connected).toBe(false);
    const b = new FakeClient();
    room.connect(b);
    room.message(b, hello('Alice', w.token));
    const w2 = b.last('welcome')!;
    expect(w2.shipId).toBe(w.shipId);
    expect(room.sim.ship(w.shipId)?.connected).toBe(true);
  });

  it('drops a held slot after the grace period', () => {
    const { room, advance } = makeRoom();
    const a = new FakeClient();
    room.connect(a);
    room.message(a, hello('Bob'));
    const w = a.last('welcome')!;
    room.disconnect(a);
    advance(60 * 21);
    expect(room.sim.ship(w.shipId)?.isBot ?? true).toBe(true);
    expect(room.humans).toBe(0);
  });

  it('refuses a ninth human', () => {
    const { room } = makeRoom();
    const clients: FakeClient[] = [];
    for (let i = 0; i < MAX_PARTICIPANTS; i++) {
      const c = new FakeClient();
      room.connect(c);
      room.message(c, hello(`P${i}`));
      expect(c.last('welcome')).toBeDefined();
      clients.push(c);
    }
    const late = new FakeClient();
    room.connect(late);
    room.message(late, hello('Late'));
    expect(late.last('full')).toBeDefined();
    expect(late.closed).toBe(true);
  });

  it('repeats the last input on a missed tick without re-firing one-shot actions', () => {
    const { room, advance } = makeRoom();
    const c = new FakeClient();
    room.connect(c);
    room.message(c, hello());
    const id = c.last('welcome')!.shipId;
    const cmd = neutralInput(1, 0);
    cmd.tFwd = 1; cmd.flags |= InputFlag.Repel;
    room.message(c, encodeInputPacket([cmd]));
    advance(1);
    advance(1);
    const s = room.sim.ship(id)!;
    expect(s.input.tFwd).toBe(1);
    expect(s.input.flags & InputFlag.Repel).toBe(0);
  });

  it('tells clients which map is next, then moves them to it after the match', () => {
    const { room, advance } = makeRoom();
    const c = new FakeClient();
    room.connect(c);
    room.message(c, hello());
    expect(c.last('match')).toMatchObject({ arena: 'hollowdeep', nextArena: 'gyre' });
    room.sim.forceInProgress();
    room.sim.match.phaseEndTick = room.sim.tick + 1;
    advance(2);
    expect(c.last('match')).toMatchObject({ phase: 'postMatch', arena: 'hollowdeep', nextArena: 'gyre' });
    advance(Math.round(POSTMATCH_S / DT) + 5);
    expect(c.last('match')).toMatchObject({ phase: 'warmup', arena: 'gyre', nextArena: 'tower' });
    expect(room.sim.arena.blueprint.id).toBe('gyre');
    // the player is flying in the new map's world
    advance(10);
    expect(c.snaps.at(-1)!.owner).not.toBeNull();
  });
});

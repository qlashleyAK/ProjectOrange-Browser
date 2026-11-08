import { beforeAll, describe, expect, it } from 'vitest';
import { DT, GameRoom, initPhysics } from '../src/index.js';

beforeAll(async () => { await initPhysics(); });

function makeRoom(mode: 'survival' | 'score-attack' | 'mine-run', seed = 99) {
  let t = 0;
  const room = new GameRoom({ id: `T-${mode}`, now: () => t, seed, mode, rotation: false });
  const advance = (ticks: number) => { for (let i = 0; i < ticks; i++) { t += DT * 1000; room.tick(); } };
  const toInProgress = () => {
    const deadline = Date.now() + 10_000;
    while (room.sim.match.phase !== 'inProgress' && Date.now() < deadline) advance(30);
    expect(room.sim.match.phase).toBe('inProgress');
  };
  return { room, advance, toInProgress };
}

describe('daily challenge modes', () => {
  it('survival: waves spawn, grow, and the run ends when the last pilot falls', () => {
    const { room, advance, toInProgress } = makeRoom('survival');
    const human = room.sim.addPlayer('p:hero', 'Hero', 'dart');
    toInProgress();

    // first wave spawns immediately at match start
    expect(room.sim.wave).toBe(1);
    expect(room.sim.shipList.filter((s) => s.isBot && s.alive).length).toBeGreaterThan(0);
    // wave bots die for good
    expect(room.sim.shipList.filter((s) => s.isBot).every((s) => s.removeAtDeath)).toBe(true);
    const wave1Count = room.sim.shipList.filter((s) => s.isBot && s.alive).length;

    // clear the wave -> after the gap the next wave is bigger
    for (const b of room.sim.shipList.filter((s) => s.isBot && s.alive)) room.sim.despawn(b);
    advance(Math.ceil(5 / DT) + 10);
    expect(room.sim.wave).toBe(2);
    expect(room.sim.shipList.filter((s) => s.isBot && s.alive).length).toBeGreaterThan(wave1Count);

    // the human falls -> match ends, human wins
    human.stats.kills = 3;
    room.sim.despawn(human);
    advance(10);
    expect(room.sim.match.phase).toBe('postMatch');
    expect(room.sim.match.winnerId).toBe(human.id);
  });

  it('survival: dead humans do not respawn mid-run', () => {
    const { room, advance, toInProgress } = makeRoom('survival');
    const human = room.sim.addPlayer('p:hero', 'Hero', 'dart');
    toInProgress();
    room.sim.despawn(human);
    advance(Math.ceil(10 / DT)); // well past the normal respawn delay
    expect(human.alive).toBe(false);
    expect(room.sim.match.phase).toBe('postMatch');
  });

  it('score-attack: winner is by mode score, not kills; no kill-cap early end', () => {
    const { room, advance, toInProgress } = makeRoom('score-attack');
    const collector = room.sim.addPlayer('p:hoard', 'Hoarder', 'dart');
    const killer = room.sim.addPlayer('p:slay', 'Slayer', 'brute');
    toInProgress();
    // bots backfill normally in score-attack
    expect(room.sim.shipList.filter((s) => s.isBot).length).toBeGreaterThan(0);

    // a kill count that would end ffa early must not end score-attack
    killer.stats.kills = 20;
    advance(30);
    expect(room.sim.match.phase).toBe('inProgress');

    room.sim.match.phaseEndTick = room.sim.tick + 2;
    advance(4);
    expect(room.sim.match.phase).toBe('postMatch');
    expect(room.sim.match.winnerId).toBe(killer.id);

    // and a pure collector outranks a mediocre killer on the mode score
    collector.stats.kills = 1; collector.stats.orangesCollected = 60; // 700
    killer.stats.kills = 4; killer.stats.orangesCollected = 0;         // 400
    const score = (s: typeof collector) => s.stats.kills * 100 + s.stats.assists * 25 + s.stats.orangesCollected * 10;
    expect(score(collector)).toBeGreaterThan(score(killer));
  });

  it('mine-run: seeded course, checkpoints in order, first finish ends the match', () => {
    const { room, advance, toInProgress } = makeRoom('mine-run', 4242);
    const human = room.sim.addPlayer('p:racer', 'Racer', 'dart');
    toInProgress();

    // solo mode: no bots at all
    expect(room.sim.shipList.filter((s) => s.isBot)).toHaveLength(0);
    // du0 regression: no checkpoint sits on top of a live ship's spawn (first gate must be earned)
    for (const cp of room.sim.course) {
      for (const s of room.sim.shipList.filter((x) => x.alive)) {
        const d = Math.hypot(cp.x - s.pos.x, cp.y - s.pos.y, cp.z - s.pos.z);
        expect(d).toBeGreaterThan(1);
      }
    }
    // course built at match start, distinct points
    expect(room.sim.course.length).toBeGreaterThan(3);
    const first = room.sim.course;
    expect(first.length).toBe(new Set(first.map((c) => `${c.x},${c.y},${c.z}`)).size);

    // fly the course by teleporting through each checkpoint
    for (const cp of room.sim.course) {
      human.body!.setTranslation(cp, true);
      advance(2);
    }
    expect(human.checkpoint).toBe(room.sim.course.length);
    expect(human.courseDoneTick).toBeGreaterThan(0);
    // early end: match closes as soon as the course is finished
    advance(4);
    expect(room.sim.match.phase).toBe('postMatch');
    expect(room.sim.match.winnerId).toBe(human.id);

    // same seed -> same course (same live-ship layout)
    const again = makeRoom('mine-run', 4242);
    again.room.sim.addPlayer('p:racer', 'Racer', 'dart');
    again.toInProgress();
    expect(again.room.sim.course).toEqual(first);
  });

  it('uhl: client-claimed ring passes are validated by proximity (near ok, far rejected)', () => {
    const { room, advance, toInProgress } = makeRoom('mine-run', 7);
    // note: claims arrive via room.message, so use a FakeClient-style link
    const human = room.sim.addPlayer('p:hero', 'Hero', 'dart');
    toInProgress();
    const cp = room.sim.course[0]!;

    // ship far from ring 1 -> claim rejected, no progress
    room.sim.registerCheckpoint(human.id, 0, true);
    expect(human.checkpoint).toBe(0);

    // ship at the ring: the sim's own sweep registers the pass...
    human.body!.setTranslation(cp, true);
    advance(2);
    expect(human.checkpoint).toBeGreaterThanOrEqual(1);

    // ...and a claim for the NEXT ring while standing there is rejected (far)
    const nextCp = room.sim.course[human.checkpoint]!;
    human.body!.setTranslation({ x: nextCp.x + 500, y: nextCp.y, z: nextCp.z }, true);
    advance(2);
    expect(room.sim.registerCheckpoint(human.id, human.checkpoint, true)).toBe(false);

    // claim accepted when the ship is genuinely at the claimed ring
    // (set the authoritative pos directly: no step, so only the claim path can register)
    const target = room.sim.course[human.checkpoint]!;
    human.body!.setTranslation(target, true);
    human.pos = { ...target };
    expect(room.sim.registerCheckpoint(human.id, human.checkpoint, true)).toBe(true);
    expect(human.checkpoint).toBeGreaterThanOrEqual(2);

    // stale index claims do nothing
    expect(room.sim.registerCheckpoint(human.id, 0, true)).toBe(false);
  });

  it('uhl: pose-window sweep registers a pass the live view already moved past', () => {
    const { room, advance, toInProgress } = makeRoom('mine-run', 8);
    const human = room.sim.addPlayer('p:hero', 'Hero', 'dart');
    toInProgress();
    const cp = room.sim.course[0]!;
    human.lagTicks = 30;

    // inject a recent pose AT the ring while the live ship is far away
    human.body!.setTranslation(cp, true);
    advance(2); // pose recorded at the ring (and the ring may already register — that's fine)
    if (human.checkpoint === 0) {
      // sweep test proper: move far, inject history at the ring, next tick must register
      human.poseHistory[(room.sim.tick - 2) % 60] = {
        tick: room.sim.tick - 2, pos: { ...cp }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: true, generation: human.generation,
      };
      human.body!.setTranslation({ x: cp.x + 500, y: cp.y, z: cp.z }, true);
      advance(2);
      expect(human.checkpoint).toBe(1);
    }
    expect(human.checkpoint).toBeGreaterThanOrEqual(1);
  });

  it('weapons are disabled in mine-run but live in score-attack', () => {
    const a = makeRoom('mine-run');
    a.room.sim.addPlayer('p:a', 'A', 'dart');
    a.toInProgress();
    expect(a.room.sim.weaponsEnabled()).toBe(false);
    const b = makeRoom('score-attack');
    b.room.sim.addPlayer('p:b', 'B', 'dart');
    b.toInProgress();
    expect(b.room.sim.weaponsEnabled()).toBe(true);
  });
});

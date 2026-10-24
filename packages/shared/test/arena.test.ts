import { beforeAll, describe, expect, it } from 'vitest';
import {
  addArenaColliders, countRoutes, createWorld, finalizeSpawns, generateArena, hollowdeep, initPhysics,
  rectMinusHoles, sphereFree, validateArenaGeometry, validateArenaPhysics, type ArenaData,
} from '../src/index.js';

let arena: ArenaData;
beforeAll(async () => {
  await initPhysics();
  arena = generateArena(hollowdeep());
});

describe('rectMinusHoles', () => {
  it('covers the rect minus the hole exactly', () => {
    const rects = rectMinusHoles([0, 10], [0, 10], [{ u: [4, 6], v: [4, 6] }]);
    const area = rects.reduce((s, r) => s + (r.u[1] - r.u[0]) * (r.v[1] - r.v[0]), 0);
    expect(area).toBeCloseTo(96);
    expect(rects.length).toBeLessThanOrEqual(4);
  });
});

describe('arena generator', () => {
  it('passes geometric validation', () => {
    expect(validateArenaGeometry(arena)).toEqual([]);
  });

  it('has six rooms with at least three routes between every pair', () => {
    const rooms = arena.blueprint.rooms.map((r) => r.id);
    expect(rooms.length).toBe(6);
    for (const a of rooms) for (const b of rooms) if (a !== b) expect(countRoutes(arena, a, b)).toBeGreaterThanOrEqual(3);
  });

  it('passes physics validation (sphere-cast traversal, doorway clearance) and spawns are clear', () => {
    const world = createWorld();
    addArenaColliders(world, arena);
    world.step();
    expect(finalizeSpawns(world, arena)).toEqual([]);
    expect(validateArenaPhysics(world, arena, 8)).toEqual([]);
    expect(arena.spawns.length).toBe(18);
    for (const s of arena.spawns) expect(sphereFree(world, s.pos, 12)).toBe(true);
  });

  it('orange region weights match the spec', () => {
    const w = Object.fromEntries(arena.regions.filter((r) => !r.id.includes('#')).map((r) => [r.id, r.weight]));
    expect(w.hub).toBeCloseTo(9.4, 1);
    expect(w.gallery).toBeCloseTo(6.5, 1);
    expect(w.reactor).toBeCloseTo(6.4, 1);
    expect(w.foundry).toBeCloseTo(4.5, 1);
    expect(w.dock).toBeCloseTo(4.3, 1);
    expect(w.crusher).toBeCloseTo(3.9, 1);
    expect(arena.regions.some((r) => r.bonus)).toBe(true);
  });

  it('has the expected props', () => {
    const props = arena.blueprint.props;
    expect(props.filter((p) => p.room === 'hub' && p.kind === 'rock').length).toBe(10);
    expect(props.filter((p) => p.room === 'gallery' && p.kind === 'pillar').length).toBe(6);
    expect(props.filter((p) => p.room === 'gallery' && p.kind === 'crystal').length).toBe(7);
  });
});

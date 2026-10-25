import { beforeAll, describe, expect, it } from 'vitest';
import {
  addArenaColliders, arenaById, countRoutes, createWorld, finalizeSpawns, generateArena, gyre, initPhysics,
  moverClearance, safeZoneAt, sphereFree, validateArenaGeometry, validateArenaPhysics, validateMovers, type ArenaData,
} from '../src/index.js';

let arena: ArenaData;
beforeAll(async () => {
  await initPhysics();
  arena = generateArena(gyre());
});

describe('the gyre', () => {
  it('passes geometric validation', () => {
    expect(validateArenaGeometry(arena)).toEqual([]);
  });

  it('has five big rooms with at least three routes between every pair', () => {
    const rooms = arena.blueprint.rooms;
    expect(rooms.length).toBe(5);
    for (const r of rooms) expect(Math.min(r.size.x, r.size.y, r.size.z)).toBeGreaterThanOrEqual(100);
    for (const a of rooms) for (const b of rooms) if (a !== b) expect(countRoutes(arena, a.id, b.id)).toBeGreaterThanOrEqual(3);
  });

  it('passes physics validation and spawns are clear', () => {
    const world = createWorld();
    addArenaColliders(world, arena);
    world.step();
    expect(finalizeSpawns(world, arena)).toEqual([]);
    expect(validateArenaPhysics(world, arena, 8)).toEqual([]);
    for (const s of arena.spawns) expect(sphereFree(world, s.pos, 12)).toBe(true);
  });

  it('movers keep clear of walls, props, doorways and each other through a full cycle', () => {
    const world = createWorld();
    addArenaColliders(world, arena);
    world.step();
    expect(arena.movers.length).toBeGreaterThanOrEqual(8);
    expect(validateMovers(world, arena)).toEqual([]);
  });

  it('mover validation catches a mover that slides into a wall', () => {
    const bp = gyre();
    const m = bp.movers!.find((x) => x.id === 'shutter-a')!;
    m.motion = { kind: 'slide', offset: { x: 200, y: 0, z: 0 }, period: 16 };
    const bad = generateArena(bp);
    const world = createWorld();
    addArenaColliders(world, bad);
    world.step();
    const errors = validateMovers(world, bad);
    expect(errors.some((e) => e.includes('shutter-a') && e.includes('static geometry'))).toBe(true);
    expect(errors.some((e) => e.includes('shutter-a') && e.includes('leaves room'))).toBe(true);
  });

  it('spawns are inside safe zones, away from moving machinery', () => {
    expect(arena.safeZones.length).toBe(4);
    expect(arena.spawns.length).toBe(arena.safeZones.length * 3);
    for (const s of arena.spawns) {
      expect(safeZoneAt(arena, s.pos)).not.toBeNull();
      expect(moverClearance(arena.sweeps, s.pos)).toBeGreaterThan(20);
    }
  });

  it('is in the registry and cached', () => {
    expect(arenaById('gyre').blueprint.id).toBe('gyre');
    expect(arenaById('gyre')).toBe(arenaById('gyre'));
    expect(arenaById('nope').blueprint.id).toBe('hollowdeep');
  });
});

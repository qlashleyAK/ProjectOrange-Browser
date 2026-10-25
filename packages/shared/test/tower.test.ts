import { beforeAll, describe, expect, it } from 'vitest';
import {
  addArenaColliders, arenaById, countRoutes, createWorld, finalizeSpawns, GameSim, generateArena, initPhysics, NavGraph,
  orangeTarget, placeAt, sphereFree, tower, validateArenaGeometry, validateArenaPhysics, type ArenaData,
} from '../src/index.js';

let arena: ArenaData;
beforeAll(async () => {
  await initPhysics();
  arena = generateArena(tower());
});

describe('meridian tower', () => {
  it('passes geometric validation', () => {
    expect(validateArenaGeometry(arena)).toEqual([]);
  });

  it('stacks four floors with at least three routes between every pair', () => {
    const rooms = arena.blueprint.rooms;
    expect(rooms.map((r) => r.id)).toEqual(['roof', 'exec', 'cubes', 'garage']);
    for (let i = 1; i < rooms.length; i++) expect(rooms[i]!.center.y).toBeLessThan(rooms[i - 1]!.center.y);
    for (const a of rooms) for (const b of rooms) if (a !== b) expect(countRoutes(arena, a.id, b.id)).toBeGreaterThanOrEqual(3);
  });

  it('passes physics validation and spawns are clear', () => {
    const world = createWorld();
    addArenaColliders(world, arena);
    world.step();
    expect(finalizeSpawns(world, arena)).toEqual([]);
    expect(validateArenaPhysics(world, arena, 8)).toEqual([]);
    expect(arena.spawns.length).toBe(12);
    for (const s of arena.spawns) expect(sphereFree(world, s.pos, 12)).toBe(true);
  });

  it('puts the only cover on the roof in the middle: the AC unit', () => {
    const roof = arena.blueprint.rooms.find((r) => r.id === 'roof')!;
    const floor = roof.center.y - roof.size.y / 2;
    const cover = arena.blueprint.props.filter((p) => p.room === 'roof' && p.collides && p.kind === 'box' && p.size.y > 4);
    expect(cover.length).toBeGreaterThan(0);
    for (const p of cover) expect(Math.hypot(p.center.x, p.center.z)).toBeLessThan(50);
    // nothing else on the roof stands taller than a ship could hide behind
    for (const p of arena.blueprint.props) {
      if (p.room !== 'roof' || !p.collides || cover.includes(p)) continue;
      const top = p.kind === 'cylinder' ? p.center.y + p.height / 2 : p.kind === 'box' ? p.center.y + p.size.y / 2 : p.center.y;
      const thin = p.kind === 'cylinder' && p.radius < 1.5;
      if (!thin) expect(top - floor).toBeLessThanOrEqual(4);
    }
  });

  it('weights orange spawns toward the elevator shafts and packs them tight', () => {
    const total = arena.regions.reduce((s, r) => s + r.weight, 0);
    const shafts = arena.regions.filter((r) => /^S\d#/.test(r.id));
    expect(shafts.length).toBe(6);
    expect(shafts.reduce((s, r) => s + r.weight, 0) / total).toBeGreaterThan(0.7);
    for (const r of shafts) expect(r.spacing).toBe(8);
    expect(orangeTarget(arena, 8)).toBeGreaterThan(orangeTarget(arenaById('hollowdeep'), 8));
    expect(orangeTarget(arena, 64)).toBe(64);
  });

  it('fills the shafts with oranges while bots play', () => {
    const sim = new GameSim({ arena, offline: true, seed: 31, botSkill: 'normal' });
    for (let i = 0; i < 6; i++) sim.addBot();
    for (let i = 0; i < 60 * 40; i++) sim.step();
    const live = sim.pickups.filter((p) => !p.drop);
    const inShafts = live.filter((p) => /^S\d$/.test(placeAt(arena, p.pos)?.id ?? ''));
    expect(live.length).toBeGreaterThan(20);
    expect(inShafts.length / live.length).toBeGreaterThan(0.5);
    sim.world.free();
  }, 60_000);

  it('builds a connected nav graph across all four floors', () => {
    const world = createWorld();
    addArenaColliders(world, arena);
    world.step();
    const nav = new NavGraph(world, arena);
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) for (const l of nav.nodes[stack.pop()!]!.links) if (!seen.has(l)) { seen.add(l); stack.push(l); }
    expect(seen.size).toBe(nav.nodes.length);
    for (const r of arena.blueprint.rooms) expect(nav.nodes.filter((n) => n.place === r.id).length).toBeGreaterThanOrEqual(9);
  });

  it('is in the registry and cached', () => {
    expect(arenaById('tower').blueprint.id).toBe('tower');
    expect(arenaById('tower')).toBe(arenaById('tower'));
  });
});

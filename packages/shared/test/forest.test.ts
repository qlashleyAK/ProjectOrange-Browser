import { beforeAll, describe, expect, it } from 'vitest';
import {
  FOREST_EXITS, FOREST_FLOOR, FOREST_POWERUP, FOREST_TIP, addArenaColliders, arenaById, createWorld, finalizeSpawns, forest,
  GameSim, generateArena, initPhysics, lineOfSight, NavGraph, nextInRotation, safeZoneAt, sphereFree, validateArenaGeometry, validateArenaPhysics,
  vdist, v3, type ArenaData,
} from '../src/index.js';

let arena: ArenaData;
beforeAll(async () => {
  await initPhysics();
  arena = generateArena(forest());
});

const world = () => { const w = createWorld(); addArenaColliders(w, arena); w.step(); return w; };

describe('gloamwood', () => {
  it('passes geometric and physics validation', () => {
    expect(validateArenaGeometry(arena)).toEqual([]);
    const w = world();
    expect(finalizeSpawns(w, arena)).toEqual([]);
    expect(validateArenaPhysics(w, arena, 8)).toEqual([]);
    w.free();
  });

  it('is a forest: dozens of big trees, every one rooted and branching', () => {
    const limbs = arena.blueprint.props.filter((p) => p.kind === 'limb');
    const trunks = limbs.filter((p) => p.kind === 'limb' && p.role === 'trunk' && p.points[p.points.length - 1]!.y - FOREST_FLOOR > 80);
    expect(trunks.length).toBeGreaterThan(50);
    expect(limbs.filter((p) => p.kind === 'limb' && p.role === 'branch').length).toBeGreaterThan(trunks.length * 5);
    for (const t of trunks) if (t.kind === 'limb') expect(t.points[0]!.y).toBeLessThan(FOREST_FLOOR);
    // thicker toward the walls than near the spire
    const near = trunks.filter((t) => t.kind === 'limb' && Math.hypot(t.points[0]!.x, t.points[0]!.z) < 220).length;
    const far = trunks.length - near;
    expect(far).toBeGreaterThan(near);
  });

  it('spawns everyone in the safe chamber under the spire, facing out of its arches', () => {
    const w = world();
    finalizeSpawns(w, arena);
    expect(arena.spawns.length).toBe(10);
    for (const s of arena.spawns) {
      expect(safeZoneAt(arena, s.pos)).not.toBeNull();
      expect(sphereFree(w, s.pos, 12)).toBe(true);
      expect(Math.hypot(s.facing.x, s.facing.z)).toBeCloseTo(1, 6);
      // out through an arch: open air 200 m straight ahead
      const out = v3(s.pos.x + s.facing.x * 200, s.pos.y, s.pos.z + s.facing.z * 200);
      expect(lineOfSight(w, s.pos, out)).toBe(true);
      expect(FOREST_EXITS.some((a) => Math.abs(Math.cos(a) - s.facing.x) < 1e-6 && Math.abs(Math.sin(a) - s.facing.z) < 1e-6)).toBe(true);
    }
    w.free();
  });

  it('puts the powerup in open air just over the spire tip, the highest stone in the forest', () => {
    const w = world();
    expect(sphereFree(w, FOREST_POWERUP, 8)).toBe(true);
    expect(FOREST_POWERUP.y - FOREST_TIP.y).toBeGreaterThan(8);
    expect(FOREST_POWERUP.y - FOREST_TIP.y).toBeLessThan(16);
    expect(sphereFree(w, v3(FOREST_TIP.x, FOREST_TIP.y - 4, FOREST_TIP.z), 1)).toBe(false);
    // reachable from the canopy: open sky all round it
    for (const a of [0, 1, 2, 3]) {
      const d = v3(Math.cos(a * Math.PI / 2) * 120, 0, Math.sin(a * Math.PI / 2) * 120);
      expect(lineOfSight(w, FOREST_POWERUP, v3(FOREST_POWERUP.x + d.x, FOREST_POWERUP.y, FOREST_POWERUP.z + d.z))).toBe(true);
    }
    w.free();
  });

  it('grows the oranges in the outskirts', () => {
    const total = arena.regions.reduce((s, r) => s + r.weight, 0);
    const woods = arena.regions.filter((r) => r.id.endsWith('woods'));
    expect(woods.length).toBe(4);
    expect(woods.reduce((s, r) => s + r.weight, 0) / total).toBeGreaterThan(0.9);
    const sim = new GameSim({ arena, offline: true, seed: 3 });
    for (let i = 0; i < 6; i++) sim.addBot();
    for (let i = 0; i < 60 * 40; i++) sim.step();
    const live = sim.pickups.filter((p) => !p.drop);
    expect(live.length).toBeGreaterThan(25);
    const outer = live.filter((p) => Math.max(Math.abs(p.pos.x), Math.abs(p.pos.z)) > 230);
    expect(outer.length / live.length).toBeGreaterThan(0.8);
    sim.world.free();
  }, 60_000);

  it('builds a connected nav graph that reaches the powerup', () => {
    const w = world();
    const nav = new NavGraph(w, arena);
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) for (const l of nav.nodes[stack.pop()!]!.links) if (!seen.has(l)) { seen.add(l); stack.push(l); }
    expect(seen.size).toBe(nav.nodes.length);
    expect(nav.nodes.length).toBeGreaterThan(400);
    expect(nav.nodes.some((n) => vdist(n.pos, FOREST_POWERUP) < 80 && lineOfSight(w, n.pos, FOREST_POWERUP))).toBe(true);
    w.free();
  });

  it('bots fly out of the chamber and someone takes the powerup', () => {
    const sim = new GameSim({ arena, offline: true, seed: 9, botSkill: 'normal' });
    for (let i = 0; i < 6; i++) sim.addBot();
    let taken = 0;
    for (let i = 0; i < 60 * 90; i++) {
      sim.step();
      taken += sim.drainEvents().filter((e) => e.t === 'powerupTake').length;
    }
    expect(taken).toBeGreaterThan(0);
    const out = sim.shipList.filter((s) => s.alive && Math.hypot(s.pos.x, s.pos.z) > 70).length;
    expect(out).toBeGreaterThan(2);
    sim.world.free();
  }, 120_000);

  it('is in the registry, in the rotation and cached', () => {
    expect(arenaById('forest').blueprint.id).toBe('forest');
    expect(arenaById('forest')).toBe(arenaById('forest'));
    expect(nextInRotation(arenaById('tower')).blueprint.id).toBe('forest');
    expect(nextInRotation(arenaById('forest')).blueprint.id).toBe('hollowdeep');
  });
});

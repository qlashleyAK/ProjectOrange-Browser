import { beforeAll, describe, expect, it } from 'vitest';
import {
  DROP_CAP, GameSim, PROJECTILE_CAP_PER_SHIP, WORLD_ORANGE_CAP, arenaById, generateArena, hollowdeep, initPhysics, nextInRotation,
  type ArenaData,
} from '../src/index.js';

let arena: ArenaData;
beforeAll(async () => { await initPhysics(); arena = generateArena(hollowdeep()); });

describe('bot soak', () => {
  it('8 bots play for 3 minutes without crashes, unbounded entities, or stuck warnings', () => {
    const sim = new GameSim({ arena, offline: true, seed: 99, botSkill: 'hard' });
    for (let i = 0; i < 8; i++) sim.addBot();
    let deaths = 0, pickups = 0, maxProj = 0, maxPickups = 0;
    const t0 = performance.now();
    const ticks = 3 * 60 * 60;
    for (let i = 0; i < ticks; i++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.t === 'death') deaths++;
        if (e.t === 'pickupTake') pickups++;
      }
      maxProj = Math.max(maxProj, sim.projectiles.length);
      maxPickups = Math.max(maxPickups, sim.pickups.length);
      for (const s of sim.shipList) {
        if (s.alive) {
          expect(Number.isFinite(s.pos.x + s.pos.y + s.pos.z)).toBe(true);
          const b = arena.bounds;
          expect(s.pos.x > b.min.x && s.pos.x < b.max.x && s.pos.y > b.min.y && s.pos.y < b.max.y && s.pos.z > b.min.z && s.pos.z < b.max.z).toBe(true);
        }
      }
    }
    const msPerTick = (performance.now() - t0) / ticks;
    console.log(`soak: ${deaths} deaths, ${pickups} pickups, max proj ${maxProj}, max pickups ${maxPickups}, ${msPerTick.toFixed(3)} ms/tick`);
    expect(deaths).toBeGreaterThan(3);
    expect(pickups).toBeGreaterThan(3);
    expect(maxProj).toBeLessThan(PROJECTILE_CAP_PER_SHIP * 8);
    expect(maxPickups).toBeLessThanOrEqual(WORLD_ORANGE_CAP + DROP_CAP);
    for (const s of sim.shipList) if (!sim.missiles.some((m) => m.targetId === s.id && m.tracking)) expect(s.missileWarn).toBe(0);
  }, 300_000);
});

describe('map rotation', () => {
  it('moves every match to the next map, with everyone respawned in its world', () => {
    const sim = new GameSim({ arena: arenaById('hollowdeep'), offline: true, seed: 7, nextArena: nextInRotation });
    for (let i = 0; i < 4; i++) sim.addBot();
    const seen: string[] = [];
    for (const expected of ['gyre', 'tower', 'hollowdeep']) {
      expect(sim.upcomingArena().blueprint.id).toBe(expected);
      sim.forceInProgress();
      sim.match.phaseEndTick = sim.tick + 1;
      for (let i = 0; i < 2000 && sim.match.phase !== 'warmup'; i++) sim.step();
      expect(sim.match.phase).toBe('warmup');
      seen.push(sim.arena.blueprint.id);
      const b = sim.arena.bounds;
      for (const s of sim.shipList) {
        expect(s.alive).toBe(true);
        expect(sim.world.getRigidBody(s.body!.handle)).toBeDefined();
        expect(s.pos.x > b.min.x && s.pos.x < b.max.x && s.pos.y > b.min.y && s.pos.y < b.max.y && s.pos.z > b.min.z && s.pos.z < b.max.z).toBe(true);
      }
      // and the new map plays
      for (let i = 0; i < 600; i++) sim.step();
      for (const s of sim.shipList) if (s.alive) expect(Number.isFinite(s.pos.x + s.pos.y + s.pos.z)).toBe(true);
    }
    expect(seen).toEqual(['gyre', 'tower', 'hollowdeep']);
  }, 120_000);

  it('stays put without a rotation', () => {
    const sim = new GameSim({ arena, offline: true, seed: 8 });
    for (let i = 0; i < 2; i++) sim.addBot();
    sim.forceInProgress();
    sim.match.phaseEndTick = sim.tick + 1;
    for (let i = 0; i < 2000 && sim.match.phase !== 'warmup'; i++) sim.step();
    expect(sim.arena).toBe(arena);
  });
});

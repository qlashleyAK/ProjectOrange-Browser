import { beforeAll, describe, expect, it } from 'vitest';
import {
  DT, GameSim, InputFlag, SAFE_ZONE_CHARGE_S, applyDamage, generateArena, gyre, initPhysics, lineOfSight, lockCandidateScore,
  moverClearance, moverPose, neutralInput, q4, qfromAxisAngle, safeZoneAt, sphereFree, v3, type ArenaData,
} from '../src/index.js';

let arena: ArenaData;
beforeAll(async () => { await initPhysics(); arena = generateArena(gyre()); });

const faceX = (sign: number) => qfromAxisAngle(q4(), v3(0, 1, 0), sign > 0 ? -Math.PI / 2 : Math.PI / 2);

function duel() {
  const sim = new GameSim({ arena, offline: true, seed: 5 });
  const a = sim.addPlayer('p1', 'One', 'dart');
  const b = sim.addPlayer('p2', 'Two', 'dart');
  sim.forceInProgress();
  sim.step();
  a.spawnProtectedUntil = 0; b.spawnProtectedUntil = 0;
  return { sim, a, b };
}

const BAY = v3(416, 0, 0);          // quarry-bay safe zone
const OUTSIDE = v3(390, 30, 30);    // open quarry air outside it

describe('moving fixtures', () => {
  it('kinematic bodies follow the tick-driven pose exactly', () => {
    const sim = new GameSim({ arena, offline: true, seed: 1 });
    expect(sim.movers.length).toBe(arena.movers.length);
    const pos = v3(), rot = q4();
    for (let i = 0; i < 137; i++) sim.step();
    for (const m of sim.movers) {
      moverPose(m.def, sim.tick, pos, rot);
      const t = m.body.translation(), r = m.body.rotation();
      expect(Math.hypot(t.x - pos.x, t.y - pos.y, t.z - pos.z)).toBeLessThan(1e-3);
      expect(Math.abs(r.x * rot.x + r.y * rot.y + r.z * rot.z + r.w * rot.w)).toBeGreaterThan(0.9999);
    }
    sim.world.free();
  });

  it('a sliding shutter blocks the line, then opens it half a cycle later', () => {
    const sim = new GameSim({ arena, offline: true, seed: 1 });
    const a = v3(-35, 0, -300), b = v3(-35, 0, -340);
    sim.step();
    expect(lineOfSight(sim.world, a, b)).toBe(false);
    for (let i = 0; i < 8 / DT; i++) sim.step();
    expect(lineOfSight(sim.world, a, b)).toBe(true);
    sim.world.free();
  });

  it('a sliding shutter shoves a ship in its way', () => {
    const sim = new GameSim({ arena, offline: true, seed: 1 });
    const s = sim.addPlayer('p1', 'One', 'brute');
    sim.forceInProgress();
    sim.step();
    const start = v3(14, 0, -322);
    sim.placeShip(s, start, faceX(1));
    for (let i = 0; i < 4 / DT; i++) sim.step();
    expect(s.alive).toBe(true);
    expect(Math.hypot(s.pos.x - start.x, s.pos.z - start.z)).toBeGreaterThan(10);
    sim.world.free();
  });
});

describe('safe zones', () => {
  it('ships spawn inside a safe zone, protected', () => {
    const { sim, a } = duel();
    expect(safeZoneAt(arena, a.pos)).not.toBeNull();
    expect(a.safe).toBe(true);
    sim.world.free();
  });

  it('safe ships take no damage and cannot fire', () => {
    const { sim, a, b } = duel();
    sim.placeShip(a, BAY, faceX(-1));
    applyDamage(sim, a, 200, b.id, 'test', a.pos);
    expect(a.shield).toBe(a.maxShield);
    expect(a.hull).toBe(a.def.hull);
    a.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    for (let i = 0; i < 30; i++) sim.step();
    expect(a.stats.shotsFired).toBe(0);
    expect(sim.projectiles.some((p) => p.ownerId === a.id)).toBe(false);
    sim.world.free();
  });

  it('protection drains while inside, then lapses even in the zone', () => {
    const { sim, a, b } = duel();
    sim.placeShip(a, BAY, faceX(-1));
    for (let i = 0; i < SAFE_ZONE_CHARGE_S / DT - 10; i++) sim.step();
    expect(a.safe).toBe(true);
    for (let i = 0; i < 20; i++) sim.step();
    expect(safeZoneAt(arena, a.pos)).not.toBeNull();
    expect(a.safe).toBe(false);
    applyDamage(sim, a, 50, b.id, 'test', a.pos);
    expect(a.shield).toBeLessThan(a.maxShield);
    sim.world.free();
  });

  it('charge recharges slowly outside and protection ends on leaving', () => {
    const { sim, a } = duel();
    expect(sphereFree(sim.world, OUTSIDE, 8)).toBe(true);
    expect(moverClearance(arena.sweeps, OUTSIDE)).toBeGreaterThan(20);
    a.safeCharge = 1;
    sim.placeShip(a, OUTSIDE, faceX(1));
    expect(a.safe).toBe(false);
    for (let i = 0; i < 5 / DT; i++) sim.step();
    expect(a.safe).toBe(false);
    expect(a.safeCharge).toBeCloseTo(3, 1);
    sim.world.free();
  });

  it('ships in a safe zone cannot be locked', () => {
    const { sim, a, b } = duel();
    sim.placeShip(a, BAY, faceX(-1));
    sim.placeShip(b, OUTSIDE, faceX(1));
    sim.step();
    expect(lockCandidateScore(sim, b, a, 180, 1000)).toBe(-1);
    a.safeCharge = 0;
    sim.step();
    expect(a.safe).toBe(false);
    expect(lockCandidateScore(sim, b, a, 180, 1000)).toBeGreaterThanOrEqual(0);
    sim.world.free();
  });

  it('oranges never spawn in safe zones or in the path of machinery', () => {
    const sim = new GameSim({ arena, offline: true, seed: 9 });
    for (let i = 0; i < 6; i++) sim.addBot();
    sim.forceInProgress();
    let seen = 0;
    for (let i = 0; i < 60 / DT; i++) {
      sim.step();
      // once spawned, the magnet may drag an orange anywhere
      for (const e of sim.drainEvents()) {
        if (e.t !== 'pickupSpawn' || e.drop) continue;
        seen++;
        expect(safeZoneAt(arena, e.pos)).toBeNull();
        expect(moverClearance(arena.sweeps, e.pos)).toBeGreaterThanOrEqual(4);
      }
    }
    expect(seen).toBeGreaterThan(0);
    sim.world.free();
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLASSES, DT, FOREST_POWERUP, GameSim, InputFlag, POWERUP_DURATION_S, POWERUP_RESPAWN_S, POWERUP_RADIUS, QUAD_DAMAGE, REFLECT_MULT,
  SPEED_TOP, activePrimary, applyDamage, applyFlightControl, arenaById, createShipBody, createWorld, initPhysics, neutralInput,
  newFlightState, powerupFlight, q4, qfromAxisAngle, qrotInv, safeZoneAt, sphereFree, v3, vdist, type GameEvent, type PowerupKind,
  type Ship,
} from '../src/index.js';

beforeAll(async () => { await initPhysics(); });

// an open line along +X in the Docking Bay
const OPEN = v3(-50, 0, 232);
const faceX = qfromAxisAngle(q4(), v3(0, 1, 0), -Math.PI / 2);

function duel() {
  const sim = new GameSim({ arena: arenaById('hollowdeep'), offline: true, seed: 11 });
  const s1 = sim.addPlayer('p1', 'One', 'dart');
  const s2 = sim.addPlayer('p2', 'Two', 'dart');
  sim.forceInProgress();
  sim.step();
  s1.spawnProtectedUntil = 0; s2.spawnProtectedUntil = 0;
  sim.placeShip(s1, OPEN, faceX);
  sim.placeShip(s2, v3(OPEN.x + 60, OPEN.y, OPEN.z), faceX);
  return { sim, s1, s2 };
}
const give = (sim: GameSim, s: Ship, k: PowerupKind) => { s.powerup = k; s.powerupUntil = sim.tick + Math.round(POWERUP_DURATION_S / DT); };

describe('powerup spawning', () => {
  it('finds a clear spot near the middle of every main room, and the spire tip in the forest', () => {
    const counts: Record<string, number> = { hollowdeep: 6, gyre: 5, tower: 4, forest: 1 };
    for (const [id, n] of Object.entries(counts)) {
      const sim = new GameSim({ arena: arenaById(id), seed: 1 });
      const spots = sim.arena.powerupSpots;
      expect(spots.length).toBe(n);
      for (const p of spots) {
        expect(sphereFree(sim.world, p, 6)).toBe(true);
        expect(safeZoneAt(sim.arena, p)).toBeNull();
      }
      if (id !== 'forest') {
        sim.arena.blueprint.rooms.forEach((r, i) => {
          const s = spots[i]!;
          expect(Math.abs(s.x - r.center.x)).toBeLessThan(r.size.x * 0.3 + 1);
          expect(Math.abs(s.z - r.center.z)).toBeLessThan(r.size.z * 0.3 + 1);
        });
      }
      sim.world.free();
    }
    expect(arenaById('forest').powerupSpots).toEqual([FOREST_POWERUP]);
  });

  it('keeps one live, or one held with the next on a 10 s timer, rotating through the rooms', () => {
    const sim = new GameSim({ arena: arenaById('hollowdeep'), offline: true, seed: 5, botSkill: 'hard' });
    for (let i = 0; i < 6; i++) sim.addBot();
    const spots = sim.arena.powerupSpots;
    const spawns: GameEvent[] = [], takes: GameEvent[] = [];
    let first = -1;
    for (let i = 0; i < 60 * 150; i++) {
      sim.step();
      for (const e of sim.drainEvents()) { if (e.t === 'powerupSpawn') spawns.push(e); if (e.t === 'powerupTake') takes.push(e); }
      if (sim.match.phase !== 'inProgress') continue;
      if (first < 0) first = sim.tick;
      const st = sim.powerups;
      if (!st.live) {
        expect(st.nextTick).toBeGreaterThan(sim.tick - 1);
        expect(st.nextTick - sim.tick).toBeLessThanOrEqual(POWERUP_RESPAWN_S / DT);
      }
    }
    expect(spawns.length).toBeGreaterThan(2);
    expect(takes.length).toBeGreaterThanOrEqual(spawns.length - 1);
    // consecutive spawns walk the room list, never repeating a kind back to back
    for (let i = 1; i < spawns.length; i++) {
      const a = spawns[i - 1] as Extract<GameEvent, { t: 'powerupSpawn' }>, b = spawns[i] as Extract<GameEvent, { t: 'powerupSpawn' }>;
      const ia = spots.findIndex((p) => vdist(p, a.pos) < 0.01), ib = spots.findIndex((p) => vdist(p, b.pos) < 0.01);
      expect(ib).toBe((ia + 1) % spots.length);
      expect(b.kind).not.toBe(a.kind);
    }
    for (const e of takes) {
      const t = e as Extract<GameEvent, { t: 'powerupTake' }>;
      expect(t.until - t.nextTick).toBe((POWERUP_DURATION_S - POWERUP_RESPAWN_S) / DT);
    }
    sim.world.free();
  }, 120_000);

  it('goes to the first ship to touch it, for 30 s, and is lost on death', () => {
    const { sim, s1, s2 } = duel();
    const live = sim.powerups.live!;
    expect(live).toBeTruthy();
    sim.placeShip(s1, v3(live.pos.x + POWERUP_RADIUS + s1.def.boundingRadius - 0.5, live.pos.y, live.pos.z));
    sim.drainEvents();
    sim.step();
    expect(s1.powerup).toBe(live.kind);
    expect(sim.powerups.live).toBeNull();
    expect(s1.powerupUntil - sim.tick).toBe(POWERUP_DURATION_S / DT);
    expect(sim.drainEvents().some((e) => e.t === 'powerupTake' && e.shipId === s1.id)).toBe(true);
    // the next appears 10 s later, while s1 still holds the first
    for (let i = 0; i < POWERUP_RESPAWN_S / DT; i++) sim.step();
    expect(sim.powerups.live).not.toBeNull();
    expect(s1.powerup).toBe(live.kind);
    applyDamage(sim, s1, 10_000, s2.id, 'test', s1.pos);
    expect(s1.powerup).toBeNull();
    expect(sim.drainEvents().some((e) => e.t === 'powerupEnd' && e.shipId === s1.id && e.reason === 'death')).toBe(true);
    sim.world.free();
  });

  it('runs out after 30 s', () => {
    const { sim, s1 } = duel();
    give(sim, s1, 'speed');
    sim.drainEvents();
    for (let i = 0; i < POWERUP_DURATION_S / DT; i++) sim.step();
    expect(s1.powerup).toBeNull();
    expect(sim.drainEvents().some((e) => e.t === 'powerupEnd' && e.shipId === s1.id && e.reason === 'expire')).toBe(true);
    sim.world.free();
  });
});

describe('powerup effects', () => {
  it('quad damage: shots and missiles hit four times as hard', () => {
    const { sim, s1 } = duel();
    give(sim, s1, 'quad');
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    sim.step();
    const w = activePrimary(s1.def, s1.tier);
    const p = sim.projectiles.find((q) => q.ownerId === s1.id)!;
    expect(p.damage).toBeCloseTo(w.damage * s1.tier.damage * QUAD_DAMAGE, 6);
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Secondary };
    sim.step();
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn };
    sim.step();
    const m = sim.missiles.find((q) => q.ownerId === s1.id)!;
    expect(m.damage).toBeCloseTo(s1.def.secondary.damage * s1.tier.damage * QUAD_DAMAGE, 6);
    sim.world.free();
  });

  it('reflect: the holder still takes the hit, the attacker takes four times it, and it never bounces back', () => {
    const { sim, s1, s2 } = duel();
    give(sim, s2, 'reflect');
    const v1 = s1.hull + s1.shield, v2 = s2.hull + s2.shield;
    applyDamage(sim, s2, 20, s1.id, 'zap', s2.pos);
    expect(v2 - (s2.hull + s2.shield)).toBeCloseTo(20, 6);
    expect(v1 - (s1.hull + s1.shield)).toBeCloseTo(20 * REFLECT_MULT, 6);
    // two reflectors: the reflected damage is not reflected again
    give(sim, s1, 'reflect');
    const w1 = s1.hull + s1.shield, w2 = s2.hull + s2.shield;
    applyDamage(sim, s2, 5, s1.id, 'zap', s2.pos);
    expect(w2 - (s2.hull + s2.shield)).toBeCloseTo(5, 6);
    expect(w1 - (s1.hull + s1.shield)).toBeCloseTo(5 * REFLECT_MULT, 6);
    // a reflected kill counts for the holder, even one that dies to the same hit
    s1.hull = 1; s1.shield = 0; s2.hull = 1; s2.shield = 0;
    s1.powerup = null;
    applyDamage(sim, s2, 50, s1.id, 'zap', s2.pos);
    expect(s1.alive).toBe(false);
    expect(s2.alive).toBe(false);
    expect(s2.stats.kills).toBe(1);
    expect(s1.stats.kills).toBe(1);
    sim.world.free();
  });

  it('haste: four times the fire rate, no energy, missiles without ammo at a quarter of the refire', () => {
    const count = (haste: boolean) => {
      const { sim, s1 } = duel();
      if (haste) give(sim, s1, 'haste');
      s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
      let shots = 0;
      for (let i = 0; i < 60; i++) { sim.step(); shots += sim.drainEvents().filter((e) => e.t === 'shot' && e.ownerId === s1.id).length; }
      const energy = s1.energy;
      sim.world.free();
      return { shots, energy, max: s1.def.energyMax };
    };
    const base = count(false), fast = count(true);
    expect(fast.shots).toBeGreaterThanOrEqual(base.shots * 3.5);
    expect(fast.energy).toBe(fast.max);

    const { sim, s1 } = duel();
    give(sim, s1, 'haste');
    s1.ammo = 0;
    const sec = s1.def.secondary;
    let launches = 0;
    for (let i = 0; i < Math.round((sec.refire * 2) / DT); i++) {
      s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | (i % 2 ? 0 : InputFlag.Secondary) };
      sim.step();
      launches += sim.drainEvents().filter((e) => e.t === 'missileSpawn' && e.ownerId === s1.id).length;
    }
    expect(s1.ammo).toBe(0);
    expect(launches / sec.count).toBeGreaterThanOrEqual(7);
    sim.world.free();
  });

  it('speed: four times the thrust and twice the top speed, boost never drains', () => {
    const def = CLASSES.dart;
    const fly = (k: PowerupKind | null, ticks: number) => {
      const world = createWorld();
      const body = createShipBody(world, def, v3(), q4());
      const st = newFlightState();
      const input = { ...neutralInput(), tFwd: 1, flags: InputFlag.AssistOn | InputFlag.Boost };
      for (let i = 0; i < ticks; i++) { applyFlightControl(body, input, def, st, DT, powerupFlight(false, k)); world.step(); }
      const v = -qrotInv(v3(), body.rotation(), body.linvel()).z;
      const meter = st.boostMeter;
      world.free();
      return { v, meter };
    };
    const top = def.maxSpeed.fwd * def.boostSpeedMult;
    const slow = fly(null, 20), fast = fly('speed', 20);
    expect(fast.v).toBeGreaterThan(slow.v * 3.5);
    expect(fly('speed', 600).v).toBeCloseTo(top * SPEED_TOP, 0);
    expect(fly('speed', 600).meter).toBe(1);
  });
});

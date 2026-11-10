import { beforeAll, describe, expect, it } from 'vitest';
import {
  DT, GameSim, InputFlag, PROJECTILE_CAP_PER_SHIP, applyDamage, cadenceTicks, endMissile, generateArena, hollowdeep, initPhysics,
  neutralInput, q4, qfromAxisAngle, v3, type ArenaData, type ClassId, type Missile, type Ship,
} from '../src/index.js';

let arena: ArenaData;
beforeAll(async () => { await initPhysics(); arena = generateArena(hollowdeep()); });

// An open line along +X in the Docking Bay, above the cargo hulls and behind the gantry.
const OPEN = v3(-50, 0, 232);
const faceX = (sign: number) => qfromAxisAngle(q4(), v3(0, 1, 0), sign > 0 ? -Math.PI / 2 : Math.PI / 2);

function sim2(a: ClassId = 'dart', b: ClassId = 'dart') {
  const sim = new GameSim({ arena, offline: true, seed: 7 });
  const s1 = sim.addPlayer('p1', 'One', a);
  const s2 = sim.addPlayer('p2', 'Two', b);
  sim.forceInProgress();
  sim.step();
  s1.spawnProtectedUntil = 0; s2.spawnProtectedUntil = 0;
  return { sim, s1, s2 };
}
/** facing +1 = toward +X (down the line), -1 = back toward -X */
function place(sim: GameSim, s: Ship, pos: { x: number; y: number; z: number }, facing = 1) {
  sim.placeShip(s, v3(pos.x, pos.y, pos.z), faceX(facing));
}
const at = (dx: number) => v3(OPEN.x + dx, OPEN.y, OPEN.z);

describe('damage routing', () => {
  it('shield absorbs first, overflow goes to hull', () => {
    const { sim, s1, s2 } = sim2();
    applyDamage(sim, s2, 100, s1.id, 'test', s2.pos);
    expect(s2.shield).toBe(0);
    expect(s2.hull).toBe(s2.def.hull - 10);
  });
  it('simultaneous lethal hits produce exactly one death', () => {
    const { sim, s1, s2 } = sim2();
    sim.drainEvents();
    applyDamage(sim, s2, 1000, s1.id, 'a', s2.pos);
    applyDamage(sim, s2, 1000, s1.id, 'b', s2.pos);
    const deaths = sim.drainEvents().filter((e) => e.t === 'death');
    expect(deaths.length).toBe(1);
    expect(s1.stats.kills).toBe(1);
    expect(s2.stats.deaths).toBe(1);
  });
  it('spawn protection blocks damage; no self-damage', () => {
    const { sim, s1, s2 } = sim2();
    s2.spawnProtectedUntil = sim.tick + 100;
    applyDamage(sim, s2, 50, s1.id, 'a', s2.pos);
    expect(s2.shield).toBe(s2.maxShield);
    applyDamage(sim, s1, 50, s1.id, 'a', s1.pos);
    expect(s1.shield).toBe(s1.maxShield);
  });
});

describe('weapons', () => {
  it('fires by tick cadence and a volley charges energy once', () => {
    const { sim, s1, s2 } = sim2('mule');
    place(sim, s1, OPEN); place(sim, s2, v3(OPEN.x + 40, OPEN.y + 8, OPEN.z - 20));
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    const e0 = s1.energy;
    sim.step();
    expect(s1.energy).toBeCloseTo(e0 - s1.def.primary.energy + s1.def.energyRegen * DT, 5);
    expect(sim.projectiles.filter((p) => p.ownerId === s1.id).length).toBe(7);
    const every = cadenceTicks(s1.def.primary, 1);
    let shots = 1;
    for (let i = 0; i < every * 3; i++) { sim.step(); }
    shots = sim.events.length >= 0 ? s1.stats.shotsFired : shots;
    expect(s1.stats.shotsFired).toBe(4);
  });

  it('rejects a volley that would exceed the projectile cap', () => {
    const { sim, s1, s2 } = sim2('mule');
    place(sim, s1, OPEN); place(sim, s2, v3(OPEN.x + 40, OPEN.y + 8, OPEN.z - 20));
    for (let i = 0; i < PROJECTILE_CAP_PER_SHIP - 3; i++) sim.spawnProjectile(s1, s1.def.primary, v3(0, 0, 0), v3(0, 0, -1), 0, 0, i);
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    const shots = s1.stats.shotsFired;
    sim.step();
    expect(s1.stats.shotsFired).toBe(shots);
  });

  it('a Dart pulse hits a target ahead and damages shields', () => {
    const { sim, s1, s2 } = sim2();
    place(sim, s1, OPEN); place(sim, s2, at(60), -1);
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    for (let i = 0; i < 30; i++) sim.step();
    expect(s2.shield).toBeLessThan(s2.maxShield);
  });

  // kx9: the fuse used to go off on first entry into its 4 m radius, so a shell flying straight at a ship always
  // detonated 4 m short for ~2 splash damage and never landed its 18-damage direct hit.
  it('flak aimed straight at a ship lands a direct hit instead of tripping its proximity fuse', () => {
    const { sim, s1, s2 } = sim2('brute', 'mule');
    place(sim, s1, OPEN); place(sim, s2, at(60), -1);
    const flak = s1.def.primary;
    sim.drainEvents();
    sim.spawnProjectile(s1, flak, at(20), v3(flak.speed, 0, 0), flak.damage, 1, 0);
    let end: string | undefined;
    for (let i = 0; i < 60 && !end; i++) {
      sim.step();
      end = sim.drainEvents().find((e) => e.t === 'projEnd')?.reason;
    }
    expect(end).toBe('ship');
    expect(s2.maxShield - s2.shield).toBeGreaterThanOrEqual(flak.damage);
  });
  it('flak passing a ship detonates near its closest approach, inside the fuse radius', () => {
    const { sim, s1, s2 } = sim2('brute', 'mule');
    place(sim, s1, OPEN); place(sim, s2, at(60), -1);
    const flak = s1.def.primary;
    // a level line beside the Mule that clears its hit volume but passes inside the 4 m fuse (facing ±X, its
    // local x runs along world z)
    const reach = Math.max(...s2.def.hitSpheres.map((h) => Math.abs(h.c.x) + h.r));
    const off = reach + (flak.proximity ?? 0) * 0.6;
    sim.drainEvents();
    sim.spawnProjectile(s1, flak, v3(OPEN.x + 20, OPEN.y, OPEN.z + off), v3(flak.speed, 0, 0), flak.damage, 1, 0);
    let ev: { reason: string; pos: { x: number } } | undefined;
    for (let i = 0; i < 60 && !ev; i++) {
      sim.step();
      const e = sim.drainEvents().find((x) => x.t === 'projEnd');
      if (e && e.t === 'projEnd') ev = e;
    }
    expect(ev?.reason).toBe('proximity');
    // closest approach to the Mule (at +60) is level with it, not 4 m before its nose
    expect(Math.abs(ev!.pos.x - (OPEN.x + 60))).toBeLessThan(s2.def.size.z / 2 + 1);
    expect(s2.shield).toBeLessThan(s2.maxShield);
  });

  it("Arc Slug's seek cone bends a shot onto a target a dumb-fire slug would have missed", () => {
    const { sim, s1, s2 } = sim2('mule', 'dart');
    s1.power = 8; sim.grantPower(s1, 0); // unlock the Arc Slug altPrimary
    place(sim, s1, OPEN);
    // 5° off dead-ahead at 100 m: ~8.7 m of lateral miss for a straight shot, but inside the 8° seek cone.
    const off = 100 * Math.tan(5 * Math.PI / 180);
    place(sim, s2, v3(OPEN.x + 100, OPEN.y + off, OPEN.z), -1);
    const shieldBefore = s2.shield;
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    for (let i = 0; i < 30; i++) sim.step();
    expect(s2.shield).toBeLessThan(shieldBefore);
  });
});

describe('missiles and warnings', () => {
  it('lock-warning and missile-warning counters return to 0', () => {
    const { sim, s1, s2 } = sim2();
    place(sim, s1, OPEN); place(sim, s2, at(110), -1);
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Secondary };
    let sawLock = false;
    for (let i = 0; i < 50; i++) { sim.step(); if (s2.lockWarn > 0) sawLock = true; }
    expect(sawLock).toBe(true);
    expect(s1.lock.locked).toBe(true);
    s1.input = neutralInput();
    sim.step();
    expect(sim.missiles.length).toBe(1);
    expect(s2.missileWarn).toBe(1);
    for (let i = 0; i < 6 * 60; i++) sim.step();
    expect(sim.missiles.length).toBe(0);
    expect(s2.missileWarn).toBe(0);
    expect(s2.lockWarn).toBe(0);
  });

  it('torpedoes can be shot down', () => {
    const { sim, s1, s2 } = sim2('brute', 'dart');
    place(sim, s1, OPEN);
    // torpedo leaves the dorsal turret ~1.7 m above center; line the Dart's guns up with it
    place(sim, s2, v3(OPEN.x + 110, OPEN.y + 1.9, OPEN.z), -1);
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Secondary };
    sim.step();
    s1.input = neutralInput();
    sim.step();
    const torp = sim.missiles.find((m) => m.def.kind === 'torpedo');
    expect(torp).toBeTruthy();
    s2.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    let ended = false;
    for (let i = 0; i < 120 && !ended; i++) {
      sim.step();
      ended = sim.drainEvents().some((e) => e.t === 'missileEnd' && e.reason === 'torpedo');
    }
    expect(ended).toBe(true);
  });

  it('a torpedo destroyed by gunfire explodes for splash damage (but never hurts its own owner)', () => {
    const { sim, s1, s2 } = sim2('brute', 'dart');
    place(sim, s1, OPEN);
    place(sim, s2, at(5), -1); // standing right where the torpedo dies
    const torp: Missile = {
      id: sim.nextMissileId(), ownerId: s1.id, def: s1.def.secondary, pos: v3(s2.pos.x - 2, s2.pos.y, s2.pos.z),
      vel: v3(0, 0, 0), targetId: -1, tracking: false, spawnTick: sim.tick, endTick: sim.tick + 1,
      hp: 0, converge: null, damage: s1.def.secondary.damage,
    };
    sim.missiles.push(torp);
    const shieldBefore = s2.shield;
    // mirrors what combat/projectiles.ts now does when a shot depletes a torpedo's hp.
    endMissile(sim, torp, 'torpedo', torp.pos, true);
    const evs = sim.drainEvents();
    expect(evs.some((e) => e.t === 'splash' && e.weapon === 'torpedo')).toBe(true);
    expect(s2.shield).toBeLessThan(shieldBefore);
    expect(s1.shield).toBe(s1.maxShield); // the torpedo's own owner is excluded from its blast
  });
});

describe('abilities', () => {
  it('Bulwark absorbs up to 300 and only blocks frontal shots', () => {
    const { sim, s1, s2 } = sim2('brute', 'dart');
    place(sim, s1, OPEN, 1);
    place(sim, s2, at(70), -1); // in front, facing the Brute
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Ability };
    sim.step();
    s1.input = neutralInput();
    expect(s1.bulwarkHp).toBe(300);
    s2.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    for (let i = 0; i < 60; i++) sim.step();
    expect(s1.shield).toBe(s1.maxShield);
    expect(s1.bulwarkHp).toBeLessThan(300);
    // from behind: not blocked
    const { sim: simB, s1: b1, s2: b2 } = sim2('brute', 'dart');
    place(simB, b1, at(40), 1);
    place(simB, b2, at(0), 1); // behind, facing the Brute's tail
    b1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Ability };
    simB.step();
    b1.input = neutralInput();
    b2.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary };
    for (let i = 0; i < 30; i++) simB.step();
    expect(b1.shield).toBeLessThan(b1.maxShield);
    // absorbs at most 300 then collapses
    simB.absorbBulwark(b1, 400, b1.pos);
    expect(b1.bulwarkHp).toBe(0);
  });

  it('cloak breaks on firing, damage, repel and sweep', () => {
    const triggers: ((sim: GameSim, sc: Ship, other: Ship) => void)[] = [
      (sim, sc) => { sc.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Primary }; sim.step(); },
      (sim, sc, o) => { applyDamage(sim, sc, 5, o.id, 't', sc.pos); },
      (sim, sc, o) => { o.power = 6; sim.grantPower(o, 0); o.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Repel }; sim.step(); },
      (sim, _sc, o) => { o.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Ability }; sim.step(); },
    ];
    triggers.forEach((trig, i) => {
      const { sim, s1, s2 } = sim2('scythe', i === 3 ? 'mule' : 'dart');
      place(sim, s1, OPEN); place(sim, s2, at(20), -1);
      s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Ability };
      sim.step();
      s1.input = neutralInput();
      sim.step();
      expect(s1.cloaked).toBe(true);
      trig(sim, s1, s2);
      expect(s1.cloaked).toBe(false);
      expect(s1.abilityCooldown).toBeGreaterThan(0);
    });
  });

  it('Repel shoves ships, scaled by shove taken', () => {
    const { sim, s1, s2 } = sim2('dart', 'brute');
    place(sim, s1, OPEN); place(sim, s2, at(15));
    s1.power = 6; sim.grantPower(s1, 0);
    s1.input = { ...neutralInput(), flags: InputFlag.AssistOn | InputFlag.Repel };
    sim.step();
    const expected = 45 * (1 - 15 / 45) ** 2 * 0.5;
    expect(s2.vel.x).toBeGreaterThan(expected * 0.7);
    expect(s2.vel.x).toBeLessThan(expected * 1.1);
  });
});

describe('physics', () => {
  it('a Brute pushes a Scythe further than the reverse', () => {
    const push = (a: ClassId, b: ClassId) => {
      const { sim, s1, s2 } = sim2(a, b);
      place(sim, s1, OPEN); place(sim, s2, at(14));
      s1.input = { ...neutralInput(), tFwd: 1, flags: InputFlag.AssistOn };
      s2.input = neutralInput();
      const x0 = s2.pos.x;
      for (let i = 0; i < 90; i++) { s2.input = { ...neutralInput(), flags: 0 }; sim.step(); }
      return s2.pos.x - x0;
    };
    expect(push('brute', 'scythe')).toBeGreaterThan(push('scythe', 'brute'));
  });

  it('a max-boost ram into walls never ends inside geometry', () => {
    const { sim, s1 } = sim2('scythe', 'dart');
    const dirs = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 1, 0), v3(0, -1, 0), v3(0, 0, 1), v3(0, 0, -1)];
    const start = v3(30, 0, 245); // walls (not doorways) in all six directions
    for (const d of dirs) {
      place(sim, s1, start);
      s1.body!.setLinvel({ x: d.x * 136, y: d.y * 136, z: d.z * 136 }, true);
      for (let i = 0; i < 120; i++) { s1.input = neutralInput(0, 0, false); sim.step(); }
      const room = arena.roomBoxes.get('dock')!;
      const p = s1.pos;
      expect(p.x).toBeGreaterThan(room.min.x - 0.5); expect(p.x).toBeLessThan(room.max.x + 0.5);
      expect(p.y).toBeGreaterThan(room.min.y - 0.5); expect(p.y).toBeLessThan(room.max.y + 0.5);
      expect(p.z).toBeGreaterThan(room.min.z - 0.5); expect(p.z).toBeLessThan(room.max.z + 0.5);
    }
  });
});

describe('power loop in sim', () => {
  it('nearest-wins collection, capped ships do not consume, drops on death, reset on respawn', () => {
    const { sim, s1, s2 } = sim2();
    place(sim, s1, OPEN); place(sim, s2, at(30));
    sim.pickups = [];
    const p = { id: 999, pos: at(6), vel: v3(), units: 2, drop: false, spawnTick: sim.tick, expireTick: -1, killerId: -1 };
    sim.pickups.push(p);
    sim.step();
    expect(s1.power).toBe(2);
    expect(sim.pickups.length).toBe(0);
    s1.power = 10; sim.grantPower(s1, 0);
    sim.pickups.push({ ...p, id: 1000 });
    sim.step();
    expect(sim.pickups.find((q) => q.id === 1000)).toBeTruthy();
    sim.pickups = [];
    applyDamage(sim, s1, 1000, s2.id, 'x', s1.pos);
    const drops = sim.pickups.filter((q) => q.drop);
    expect(drops.reduce((a, q) => a + q.units, 0)).toBe(5);
    expect(drops.length).toBe(4);
    for (let i = 0; i < 3 * 60 + 2; i++) sim.step();
    expect(s1.alive).toBe(true);
    expect(s1.power).toBe(0);
  });
});

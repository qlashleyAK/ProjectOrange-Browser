import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLASS_LIST, DT, InputFlag, applyFlightControl, createShipBody, createWorld, initPhysics, neutralInput, newFlightState,
  q4, qrot, qrotInv, v3, type InputCmd, type ShipClassDef,
} from '../src/index.js';

beforeAll(async () => { await initPhysics(); });

function setup(def: ShipClassDef) {
  const world = createWorld();
  const body = createShipBody(world, def, v3(0, 0, 0), q4());
  const st = newFlightState();
  const run = (cmd: Partial<InputCmd>, ticks: number) => {
    const input = { ...neutralInput(), ...cmd };
    for (let i = 0; i < ticks; i++) { applyFlightControl(body, input, def, st, DT); world.step(); }
  };
  const fwd = () => qrot(v3(), body.rotation(), v3(0, 0, -1));
  const localVel = () => qrotInv(v3(), body.rotation(), body.linvel());
  return { world, body, st, run, fwd, localVel };
}

describe('flight sign contract (Section 3)', () => {
  const def = CLASS_LIST[0]!;
  it('yaw +1 swings the nose right', () => {
    const s = setup(def); s.run({ rYaw: 1 }, 20);
    expect(s.fwd().x).toBeGreaterThan(0.1);
  });
  it('pitch +1 swings the nose up', () => {
    const s = setup(def); s.run({ rPitch: 1 }, 20);
    expect(s.fwd().y).toBeGreaterThan(0.1);
  });
  it('roll +1 puts the right wing down', () => {
    const s = setup(def); s.run({ rRoll: 1 }, 20);
    const right = qrot(v3(), s.body.rotation(), v3(1, 0, 0));
    expect(right.y).toBeLessThan(-0.1);
  });
});

describe.each(CLASS_LIST.map((c) => [c.name, c] as const))('%s flight', (_n, def) => {
  it('reaches max forward speed in about maxSpeed/accel', () => {
    const s = setup(def);
    const expected = def.maxSpeed.fwd / def.accel.fwd;
    let t = 0;
    while (-s.localVel().z < def.maxSpeed.fwd * 0.999 && t < 10) { s.run({ tFwd: 1 }, 1); t += DT; }
    expect(t).toBeGreaterThan(expected * 0.9);
    expect(t).toBeLessThan(expected * 1.1);
    s.run({ tFwd: 1 }, 60);
    expect(-s.localVel().z).toBeCloseTo(def.maxSpeed.fwd, 1);
  });

  it('comes to rest with Assist on and no input', () => {
    const s = setup(def);
    s.run({ tFwd: 1, tRight: 1, rYaw: 1 }, 120);
    s.run({}, 600);
    const v = s.body.linvel(), w = s.body.angvel();
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.01);
    expect(Math.hypot(w.x, w.y, w.z)).toBeLessThan(0.01);
  });

  it('boost multiplies speed and drains/regenerates the meter', () => {
    const s = setup(def);
    s.run({ tFwd: 1, flags: InputFlag.AssistOn | InputFlag.Boost }, 60);
    expect(s.st.boostMeter).toBeCloseTo(1 - def.boostDrain, 2);
    s.run({ tFwd: 1, flags: InputFlag.AssistOn | InputFlag.Boost }, 30);
    if (s.st.boostMeter > 0) {
      const t = (def.maxSpeed.fwd * def.boostSpeedMult) / (def.accel.fwd * def.boostAccelMult);
      expect(t).toBeLessThan(5);
    }
    // drain fully, then verify cap speed while boosting from rest in a fresh ship
    const b = setup(def);
    let peak = 0;
    for (let i = 0; i < 300 && b.st.boostMeter > 0.05; i++) {
      b.run({ tFwd: 1, flags: InputFlag.AssistOn | InputFlag.Boost }, 1);
      peak = Math.max(peak, -b.localVel().z);
    }
    expect(peak).toBeGreaterThan(def.maxSpeed.fwd * 1.05);
    expect(peak).toBeLessThanOrEqual(def.maxSpeed.fwd * def.boostSpeedMult + 0.01);
    // regen after 0.5 s
    const before = b.st.boostMeter;
    b.run({}, 30);
    expect(b.st.boostMeter).toBeCloseTo(before, 5);
    b.run({}, 60);
    expect(b.st.boostMeter).toBeCloseTo(Math.min(1, before + def.boostRegen * (61 / 60)), 2);
  });

  it('dodge produces the configured Δv and one full roll', () => {
    const s = setup(def);
    s.run({ flags: InputFlag.AssistOn | InputFlag.DodgeR }, 1);
    const v = s.body.linvel();
    expect(v.x).toBeCloseTo(def.dodgeDV, 0);
    expect(s.st.boostMeter).toBeCloseTo(0.8, 5);
    s.run({}, 40);
    const r = s.body.rotation();
    const up = qrot(v3(), r, v3(0, 1, 0));
    expect(up.y).toBeGreaterThan(0.99); // full 360° returns to level
    const w = s.body.angvel();
    expect(Math.abs(w.z)).toBeLessThan(0.01);
  });
});

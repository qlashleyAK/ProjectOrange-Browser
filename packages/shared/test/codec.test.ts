import { describe, expect, it } from 'vitest';
import {
  MAX_INPUTS_PER_PACKET, Reader, decodeInputPacket, decodeQuat, decodeSnapshot, encodeInputPacket, encodeQuat, encodeSnapshot,
  newFlightState, q4, qangle, qfromAxisAngle, qnorm, quantizeInput, seqDiff, seqGreater, v3, type InputCmd, type Snapshot,
} from '../src/index.js';

describe('quantization', () => {
  it('quantize→dequantize is idempotent and matches the wire', () => {
    const c: InputCmd = { seq: 70000, tick: 5, tFwd: 0.333, tRight: -1.2, tUp: 0.5, rPitch: 0.01, rYaw: -0.77, rRoll: 1, flags: 0x1234 };
    quantizeInput(c);
    const r = new Reader(encodeInputPacket([c]).slice(1));
    const d = decodeInputPacket(r)[0]!;
    expect(d).toEqual(c);
    expect(c.tRight).toBe(-1);
    expect(c.seq).toBe(70000 & 0xffff);
  });
  it('one batch constant bounds sender and decoder', () => {
    const cmds = Array.from({ length: MAX_INPUTS_PER_PACKET }, (_, i) => quantizeInput({ seq: i, tick: i, tFwd: 0, tRight: 0, tUp: 0, rPitch: 0, rYaw: 0, rRoll: 0, flags: 0 }));
    const r = new Reader(encodeInputPacket(cmds).slice(1));
    expect(decodeInputPacket(r).length).toBe(MAX_INPUTS_PER_PACKET);
    expect(() => encodeInputPacket([...cmds, cmds[0]!])).toThrow();
  });
  it('smallest-three quaternions round-trip within 0.1°', () => {
    for (let i = 0; i < 200; i++) {
      const q = qnorm(q4(), q4(Math.sin(i), Math.cos(i * 1.3), Math.sin(i * 0.7), Math.cos(i * 2.1)));
      const e = encodeQuat(q);
      const d = decodeQuat(q4(), e[0], e[1], e[2], e[3]);
      expect(qangle(q, d)).toBeLessThan(0.1 * Math.PI / 180);
    }
  });
  it('wrap-safe sequence comparison', () => {
    expect(seqGreater(1, 65535)).toBe(true);
    expect(seqGreater(65535, 1)).toBe(false);
    expect(seqDiff(2, 65534)).toBe(4);
  });
});

describe('snapshot codec', () => {
  it('round-trips ships, owner state, missiles and projectile events', () => {
    const snap: Snapshot = {
      tick: 123456, bufferDepth: 2,
      owner: {
        id: 3, gen: 7, cls: 2, lastSeq: 999, pos: v3(1.5, -2.25, 300.125), rot: qfromAxisAngle(q4(), v3(0, 1, 0), 0.3), vel: v3(10, 0, -5), angvel: v3(0.1, 0.2, 0.3),
        flight: { ...newFlightState(), boostMeter: 0.123456789 }, energy: 55.5, ammo: 3, abilityCooldown: 4, abilityActive: 1, repelCooldown: 0,
        power: 6, hull: 80, shield: 20, maxShield: 103.5, lockTarget: -1, lockProgress: 0, locked: false, lockWarn: 1, missileWarn: 2,
        bulwarkHp: 0, primaryLastFire: 123400, muzzleIndex: 5, spawnProtectedUntil: 0, cloaked: false,
      },
      ships: [{ id: 1, gen: 2, cls: 3, pos: v3(-100.001, 50, 20), rot: qfromAxisAngle(q4(), v3(1, 0, 0), 1), vel: v3(70, -3, 2), angvel: v3(1, 2, -3), boost: 0.5, flags: 9, hull: 0.5, shield: 1, power: 4 }],
      missiles: [{ id: 77, pos: v3(1, 2, 3), vel: v3(140, 0, 0) }],
      projSpawns: [{ id: 5, owner: 1, weapon: 2, pos: v3(1, 2, 3), vel: v3(380, 0, 0), spawnTick: 123450, shotId: 0x7fffffff, index: 3 }],
      projEnds: [{ id: 4, reason: 2, pos: v3(5, 5, 5) }],
    };
    const bytes = encodeSnapshot(snap);
    const r = new Reader(bytes); r.u8();
    const d = decodeSnapshot(r);
    expect(d.tick).toBe(snap.tick);
    expect(d.owner!.flight.boostMeter).toBe(0.123456789);
    expect(d.owner!.pos.z).toBeCloseTo(300.125, 4);
    expect(d.ships[0]!.pos.x).toBeCloseTo(-100.001, 3);
    expect(d.ships[0]!.vel.x).toBeCloseTo(70, 2);
    expect(qangle(d.ships[0]!.rot, snap.ships[0]!.rot)).toBeLessThan(0.002);
    expect(d.missiles![0]!.id).toBe(77);
    expect(d.projSpawns[0]!.shotId).toBe(0x7fffffff);
    expect(d.projSpawns[0]!.vel.x).toBeCloseTo(380, 0);
    expect(d.projEnds[0]!.reason).toBe(2);
    expect(bytes.byteLength).toBeLessThan(300);
  });
});

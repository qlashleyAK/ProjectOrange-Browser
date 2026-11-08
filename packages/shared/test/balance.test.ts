import { beforeAll, describe, expect, it } from 'vitest';
import { CLASSES, initPhysics } from '../src/index.js';
import {
  applyProposal, describeChange, formatReport, pairedDelta, parseProposal, runMatch, summarize, type ShipLine,
} from '../scripts/balanceLib.js';

beforeAll(async () => { await initPhysics(); });

const line = (classId: ShipLine['classId'], kills: number, deaths: number, placement: number): ShipLine =>
  ({ classId, kills, deaths, damage: kills * 100, placement, won: placement === 1 });

describe('balance evidence', () => {
  it('parses proposals and explains bad ones', () => {
    expect(parseProposal(['Brute', 'hull=220', 'primary.damage*=1.1', 'maxSpeed.fwd+=-2'])).toEqual({
      ship: 'brute',
      changes: [{ path: 'hull', op: '=', value: 220 }, { path: 'primary.damage', op: '*=', value: 1.1 }, { path: 'maxSpeed.fwd', op: '+=', value: -2 }],
    });
    expect(() => parseProposal(['zeppelin', 'hull=1'])).toThrow(/unknown ship/);
    expect(() => parseProposal(['dart'])).toThrow(/no change/);
    expect(() => parseProposal(['dart', 'hull=$(rm -rf /)'])).toThrow(/can't read/);
    expect(() => parseProposal(['dart', 'primary.name=3'])).toThrow(/no numeric stat/); // strings aren't tunable
    expect(() => parseProposal(['dart', 'speed=3'])).toThrow(/did you mean .*primary\.speed/);
  });

  it('applies a proposal to the live ship and undoes it exactly', () => {
    const before = { hull: CLASSES.brute.hull, dmg: CLASSES.brute.primary.damage, tier: CLASSES.brute.tiers[2]!.damage };
    const p = parseProposal(['brute', 'hull=250', 'primary.damage*=2', 'tiers.2.damage+=0.1']);
    expect(describeChange(p)).toContain('`hull` 200 → 250');
    const undo = applyProposal(p);
    expect(CLASSES.brute.hull).toBe(250);
    expect(CLASSES.brute.primary.damage).toBe(before.dmg * 2);
    expect(CLASSES.brute.tiers[2]!.damage).toBeCloseTo(before.tier! + 0.1);
    undo();
    expect({ hull: CLASSES.brute.hull, dmg: CLASSES.brute.primary.damage, tier: CLASSES.brute.tiers[2]!.damage }).toEqual(before);
    // a change that would go negative is refused and leaves nothing half-applied
    expect(() => applyProposal(parseProposal(['brute', 'hull=300', 'shield+=-1000']))).toThrow(/would become/);
    expect(CLASSES.brute.hull).toBe(before.hull);
  });

  it('pairs matches by seed: same seed + tuning replays identically, so B−A isolates the change', () => {
    const a1 = runMatch(11, 'hollowdeep', 'normal', 1500);
    const a2 = runMatch(11, 'hollowdeep', 'normal', 1500);
    expect(a2).toEqual(a1);
    expect(a1).toHaveLength(8);
    expect(new Set(a1.map((l) => l.classId)).size).toBe(4); // two of each ship
    expect(a1.map((l) => l.placement)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('summarizes per ship and computes paired deltas with a standard error', () => {
    const a = [
      [line('dart', 4, 2, 1), line('dart', 2, 2, 3), line('brute', 0, 3, 8), line('brute', 1, 3, 7)],
      [line('dart', 3, 1, 2), line('dart', 3, 3, 4), line('brute', 1, 2, 6), line('brute', 0, 4, 8)],
    ];
    const b = [
      [line('dart', 4, 2, 1), line('dart', 2, 2, 3), line('brute', 2, 1, 4), line('brute', 2, 2, 5)],
      [line('dart', 3, 1, 2), line('dart', 3, 3, 4), line('brute', 2, 1, 3), line('brute', 1, 2, 6)],
    ];
    const s = summarize(a);
    expect(s.dart.kills).toBe(3);
    expect(s.brute.net).toBe(-2.5);
    expect(s.dart.wins).toBe(1);
    const d = pairedDelta(a, b, 'brute', (l) => l.kills - l.deaths);
    // pair 1: brute net −2.5 → +0.5 (+3); pair 2: −2.5 → 0 (+2.5)
    expect(d.mean).toBeCloseTo(2.75);
    expect(d.se).toBeCloseTo(0.25);
    expect(pairedDelta(a, b, 'dart', (l) => l.kills - l.deaths)).toEqual({ mean: 0, se: 0 });

    const md = formatReport({ proposal: parseProposal(['brute', 'hull=260']), change: '`hull` 200 → 260', seeds: [1, 2], arenas: ['Hollowdeep Mine'], skill: 'normal', a, b, version: 'test' });
    expect(md).toContain('| **Brute** (changed) |');
    expect(md).toContain('+2.75 ± 0.25 ✱');
    expect(md).toMatch(/a real shift/);
  });
});

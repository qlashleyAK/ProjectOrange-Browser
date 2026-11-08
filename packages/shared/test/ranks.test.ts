import { describe, expect, it } from 'vitest';
import { ELO_START, duelOutcome, rankFor, rankProgress } from '../src/ranks.js';

describe('ranks (BSG ladder + ELO)', () => {
  it('even duel: win +16, loss -16', () => {
    const ea = duelOutcome(1200, 1200, 1);
    expect(ea.a).toBe(1200 + 16);
    expect(ea.b).toBe(1200 - 16);
    expect(duelOutcome(1200, 1200, 0).deltaA).toBe(-16);
  });

  it('beating a stronger pilot pays more', () => {
    const upset = duelOutcome(1000, 1600, 1);
    const expected = duelOutcome(1600, 1000, 1);
    expect(upset.deltaA).toBeGreaterThan(16);
    expect(expected.deltaA).toBeLessThanOrEqual(4);
    expect(duelOutcome(1000, 1600, 0).deltaA).toBeGreaterThan(-4);
  });

  it('ladder floors at Nugget and tops at Admiral', () => {
    expect(rankFor(0).name).toBe('Nugget');
    expect(rankFor(ELO_START).name).toBe('Lieutenant');
    expect(rankFor(1799).name).toBe('Commander');
    expect(rankFor(1800).name).toBe('Admiral');
    expect(rankFor(999_999).name).toBe('Admiral');
  });

  it('progress climbs 0..1 within a rank', () => {
    expect(rankProgress(900)).toBeGreaterThanOrEqual(0);
    expect(rankProgress(1800)).toBe(1);
    expect(rankProgress(1200)).toBeGreaterThan(0);
    expect(rankProgress(1200)).toBeLessThan(1);
  });
});
import { describe, expect, it } from 'vitest';
import { CLASS_LIST, applyTierToVitals, dropUnits, grantUnits, resolveTier, splitDrop, worldOrangeTarget } from '../src/index.js';

describe('tiers', () => {
  it.each(CLASS_LIST.map((c) => [c.name, c] as const))('%s resolves absolute tiers 0–10', (_n, def) => {
    const expectIdx = [-1, -1, 0, 0, 1, 1, 2, 2, 3, 3, 4];
    for (let u = 0; u <= 10; u++) {
      const t = resolveTier(def, u);
      expect(t.index).toBe(expectIdx[u]);
      expect(t.repel).toBe(u >= 6);
      expect(t.altPrimary).toBe(u >= 8);
    }
  });
});

describe('drops', () => {
  it('drops ceil(u/2) split into ≤ 4 pickups', () => {
    for (let u = 0; u <= 10; u++) {
      const d = dropUnits(u);
      expect(d).toBe(u === 0 ? 0 : Math.ceil(u / 2));
      const parts = splitDrop(d);
      expect(parts.length).toBeLessThanOrEqual(4);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(d);
      if (parts.length) expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    }
  });
  it('a capped ship does not consume; excess is lost', () => {
    expect(grantUnits(10, 2)).toBe(0);
    expect(grantUnits(9, 2)).toBe(1);
    expect(grantUnits(3, 2)).toBe(2);
  });
  it('world population target', () => {
    expect(worldOrangeTarget(6)).toBe(17);
    expect(worldOrangeTarget(100)).toBe(40);
  });
});

describe('tier application', () => {
  const dart = CLASS_LIST[0]!;
  it('raising shield× raises the max but does not refill; losing a tier clamps', () => {
    const v = { shield: 50, maxShield: dart.shield, ammo: 4, bonusAmmoGranted: 0 };
    applyTierToVitals(dart, resolveTier(dart, 10), v);
    expect(v.maxShield).toBeCloseTo(dart.shield * 1.3);
    expect(v.shield).toBe(50);
    v.shield = v.maxShield;
    applyTierToVitals(dart, resolveTier(dart, 0), v);
    expect(v.shield).toBe(dart.shield);
  });
  it('ammo tops up by the difference instead of refilling', () => {
    const v = { shield: 0, maxShield: dart.shield, ammo: 0, bonusAmmoGranted: 0 };
    applyTierToVitals(dart, resolveTier(dart, 4), v);
    expect(v.ammo).toBe(1);
    applyTierToVitals(dart, resolveTier(dart, 6), v);
    expect(v.ammo).toBe(1);
    applyTierToVitals(dart, resolveTier(dart, 8), v);
    expect(v.ammo).toBe(2);
    applyTierToVitals(dart, resolveTier(dart, 10), v);
    expect(v.ammo).toBe(2);
  });
});

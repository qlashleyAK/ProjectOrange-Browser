import { describe, expect, it } from 'vitest';
import { Presence } from '../src/presence.js';

describe('Presence', () => {
  it('counts menu tabs within the TTL plus pilots in matches', () => {
    const p = new Presence(45_000);
    p.touch('tab001', 0);
    p.touch('tab002', 10_000);
    p.touch('tab001', 20_000); // refresh, not a second pilot
    expect(p.counts(3, 30_000)).toEqual({ online: 5, inMatch: 3, onMenu: 2 });
    // tab002 last seen at 10 s, expires after 55 s; tab001 (20 s) lasts until 65 s
    expect(p.onMenu(60_000)).toBe(1);
    expect(p.onMenu(70_000)).toBe(0);
  });

  it('ignores malformed ids and holds a hard cap', () => {
    const p = new Presence(45_000, 2);
    p.touch(null, 0);
    p.touch('x', 0);
    p.touch('NOT-OK!', 0);
    p.touch('a'.repeat(40), 0);
    expect(p.onMenu(0)).toBe(0);
    p.touch('aaaaaa', 0);
    p.touch('bbbbbb', 0);
    p.touch('cccccc', 0); // over the cap: dropped
    expect(p.onMenu(0)).toBe(2);
    p.touch('cccccc', 50_000); // the others expired: room again
    expect(p.onMenu(50_000)).toBe(1);
  });
});

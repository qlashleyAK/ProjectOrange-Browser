/** Seeded PRNG (mulberry32). Deterministic across platforms. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hiExclusive: number): number { return lo + Math.floor(this.next() * (hiExclusive - lo)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
  get state(): number { return this.s; }
}

export function hash32(...parts: number[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    h ^= p & 0xff; h = Math.imul(h, 16777619);
    h ^= (p >>> 8) & 0xff; h = Math.imul(h, 16777619);
    h ^= (p >>> 16) & 0xff; h = Math.imul(h, 16777619);
    h ^= (p >>> 24) & 0xff; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

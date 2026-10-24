import { DT, INTERP_DELAY_MAX, INTERP_DELAY_MIN, SNAPSHOT_EVERY_TICKS } from '@orange/shared';

const median = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };

/** NTP-style server-tick estimate (8 samples, median) plus jitter → adaptive interpolation delay. */
export class ClockSync {
  private offsets: number[] = [];
  private rtts: number[] = [];
  rtt = 0.1;
  jitter = 0;
  private offset = 0;
  private synced = false;
  private lastSnapAt = -1;
  private lastSnapTick = -1;
  snapshotsSeen = 0;
  ticksMissing = 0;
  ticksExpected = 0;

  /** seconds */
  now(): number { return performance.now() / 1000; }

  seed(serverTick: number): void {
    if (this.synced) return;
    this.offset = serverTick - this.now() / DT;
  }

  onPong(clientTimeMs: number, serverTick: number, since: number): void {
    const now = performance.now();
    const rtt = (now - clientTimeMs) / 1000;
    if (rtt < 0 || rtt > 5) return;
    this.rtts.push(rtt);
    if (this.rtts.length > 8) this.rtts.shift();
    this.rtt = median(this.rtts);
    const off = serverTick + since + rtt / 2 / DT - now / 1000 / DT;
    this.offsets.push(off);
    if (this.offsets.length > 8) this.offsets.shift();
    this.offset = median(this.offsets);
    this.synced = true;
  }

  /** Shift the estimate by whole ticks (the server clock was frozen, e.g. an offline pause). */
  shift(ticks: number): void {
    this.offset += ticks;
    for (let i = 0; i < this.offsets.length; i++) this.offsets[i]! += ticks;
    if (this.lastSnapAt >= 0) this.lastSnapAt -= ticks * DT;
  }

  /** Estimated current server tick (fractional). */
  serverTick(): number { return this.now() / DT + this.offset; }

  onSnapshot(tick: number): void {
    const t = this.now();
    if (this.lastSnapAt >= 0 && tick > this.lastSnapTick) {
      const expected = (tick - this.lastSnapTick) * DT;
      const actual = t - this.lastSnapAt;
      const dev = Math.abs(actual - expected);
      this.jitter += (dev - this.jitter) * 0.1;
      const gap = tick - this.lastSnapTick;
      this.ticksExpected += gap;
      if (gap > SNAPSHOT_EVERY_TICKS) this.ticksMissing += gap - SNAPSHOT_EVERY_TICKS;
      if (this.ticksExpected > 600) { this.ticksExpected *= 0.5; this.ticksMissing *= 0.5; }
    }
    this.lastSnapAt = t;
    this.lastSnapTick = Math.max(this.lastSnapTick, tick);
    this.snapshotsSeen++;
  }

  get loss(): number { return this.ticksExpected > 0 ? this.ticksMissing / this.ticksExpected : 0; }

  /** interpDelay = 2 × snapshot interval + 2 × jitter, clamped to 66–200 ms */
  interpDelay(): number {
    return Math.min(INTERP_DELAY_MAX, Math.max(INTERP_DELAY_MIN, 2 * SNAPSHOT_EVERY_TICKS * DT + 2 * this.jitter));
  }

  snapshotAge(): number { return this.lastSnapAt < 0 ? 0 : this.now() - this.lastSnapAt; }
}

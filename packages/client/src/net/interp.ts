import { DT, MAX_EXTRAPOLATION, q4, qslerp, v3, type Q4, type V3 } from '@orange/shared';

export interface Sample { tick: number; pos: V3; rot: Q4; vel: V3 }

/** Per-entity snapshot buffer: cubic Hermite position (with velocity), slerp rotation, bounded extrapolation. */
export class InterpBuffer {
  samples: Sample[] = [];
  gen = -1;

  push(s: Sample, gen: number): void {
    if (gen !== this.gen) { this.samples = []; this.gen = gen; }
    const last = this.samples[this.samples.length - 1];
    if (last && s.tick <= last.tick) return;
    this.samples.push(s);
    if (this.samples.length > 32) this.samples.shift();
  }

  get latest(): Sample | undefined { return this.samples[this.samples.length - 1]; }

  /** Sample at a fractional tick. Returns false when there is nothing to show. */
  sample(tick: number, outPos: V3, outRot: Q4, outVel: V3): boolean {
    const n = this.samples.length;
    if (!n) return false;
    const first = this.samples[0]!;
    if (tick <= first.tick || n === 1) {
      copyS(first, outPos, outRot, outVel);
      if (n === 1 && tick > first.tick) extrapolate(first, tick, outPos);
      return true;
    }
    for (let i = n - 1; i > 0; i--) {
      const a = this.samples[i - 1]!, b = this.samples[i]!;
      if (tick >= a.tick && tick <= b.tick) {
        const span = (b.tick - a.tick) * DT;
        const t = (tick - a.tick) / (b.tick - a.tick);
        hermite(outPos, a.pos, a.vel, b.pos, b.vel, t, span);
        qslerp(outRot, a.rot, b.rot, t);
        outVel.x = a.vel.x + (b.vel.x - a.vel.x) * t; outVel.y = a.vel.y + (b.vel.y - a.vel.y) * t; outVel.z = a.vel.z + (b.vel.z - a.vel.z) * t;
        // drop samples we no longer need
        if (i > 2) this.samples.splice(0, i - 2);
        return true;
      }
    }
    const last = this.samples[n - 1]!;
    copyS(last, outPos, outRot, outVel);
    extrapolate(last, tick, outPos);
    return true;
  }
}

function copyS(s: Sample, p: V3, r: Q4, v: V3): void {
  p.x = s.pos.x; p.y = s.pos.y; p.z = s.pos.z;
  r.x = s.rot.x; r.y = s.rot.y; r.z = s.rot.z; r.w = s.rot.w;
  v.x = s.vel.x; v.y = s.vel.y; v.z = s.vel.z;
}

function extrapolate(s: Sample, tick: number, out: V3): void {
  const dt = Math.min(MAX_EXTRAPOLATION, (tick - s.tick) * DT);
  out.x = s.pos.x + s.vel.x * dt; out.y = s.pos.y + s.vel.y * dt; out.z = s.pos.z + s.vel.z * dt;
}

function hermite(out: V3, p0: V3, v0: V3, p1: V3, v1: V3, t: number, span: number): void {
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  out.x = h00 * p0.x + h10 * span * v0.x + h01 * p1.x + h11 * span * v1.x;
  out.y = h00 * p0.y + h10 * span * v0.y + h01 * p1.y + h11 * span * v1.y;
  out.z = h00 * p0.z + h10 * span * v0.z + h01 * p1.z + h11 * span * v1.z;
}

export const newSample = (tick: number): Sample => ({ tick, pos: v3(), rot: q4(), vel: v3() });

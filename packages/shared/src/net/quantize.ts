import type { InputCmd } from '../input.js';
import type { Q4 } from '../math.js';

export const qAxis = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 127);
export const dqAxis = (i: number) => i / 127;

/** Quantize then dequantize in place, so the client simulates exactly what the server will receive. */
export function quantizeInput(c: InputCmd): InputCmd {
  c.tFwd = dqAxis(qAxis(c.tFwd)); c.tRight = dqAxis(qAxis(c.tRight)); c.tUp = dqAxis(qAxis(c.tUp));
  c.rPitch = dqAxis(qAxis(c.rPitch)); c.rYaw = dqAxis(qAxis(c.rYaw)); c.rRoll = dqAxis(qAxis(c.rRoll));
  c.flags &= 0xffff; c.seq &= 0xffff; c.tick >>>= 0;
  return c;
}

/** Smallest-three quaternion encoding: header (index of the largest component) and three i16 components. */
export function encodeQuat(q: Q4): [number, number, number, number] {
  const c = [q.x, q.y, q.z, q.w];
  let li = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(c[i]!) > Math.abs(c[li]!)) li = i;
  const sign = c[li]! < 0 ? -1 : 1;
  const rest: number[] = [];
  for (let i = 0; i < 4; i++) if (i !== li) rest.push(clampI16(c[i]! * sign * 32767));
  return [li, rest[0]!, rest[1]!, rest[2]!];
}

export function decodeQuat(out: Q4, hdr: number, a: number, b: number, c: number): Q4 {
  const r = [a / 32767, b / 32767, c / 32767];
  const big = Math.sqrt(Math.max(0, 1 - (r[0]! * r[0]! + r[1]! * r[1]! + r[2]! * r[2]!)));
  const comps: number[] = [];
  let j = 0;
  for (let i = 0; i < 4; i++) comps.push(i === hdr ? big : r[j++]!);
  const l = Math.hypot(comps[0]!, comps[1]!, comps[2]!, comps[3]!) || 1;
  out.x = comps[0]! / l; out.y = comps[1]! / l; out.z = comps[2]! / l; out.w = comps[3]! / l;
  return out;
}

export const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

export interface V3 { x: number; y: number; z: number }
export interface Q4 { x: number; y: number; z: number; w: number }

export const DEG = Math.PI / 180;

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const q4 = (x = 0, y = 0, z = 0, w = 1): Q4 => ({ x, y, z, w });

export function vset(o: V3, x: number, y: number, z: number): V3 { o.x = x; o.y = y; o.z = z; return o; }
export function vcopy(o: V3, a: V3): V3 { o.x = a.x; o.y = a.y; o.z = a.z; return o; }
export function vclone(a: V3): V3 { return { x: a.x, y: a.y, z: a.z }; }
export function vadd(o: V3, a: V3, b: V3): V3 { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; }
export function vsub(o: V3, a: V3, b: V3): V3 { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; }
export function vscale(o: V3, a: V3, s: number): V3 { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; }
export function vaddScaled(o: V3, a: V3, b: V3, s: number): V3 { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; }
export function vdot(a: V3, b: V3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vcross(o: V3, a: V3, b: V3): V3 {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  o.x = x; o.y = y; o.z = z; return o;
}
export function vlen(a: V3): number { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
export function vlenSq(a: V3): number { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function vdist(a: V3, b: V3): number { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
export function vdistSq(a: V3, b: V3): number { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; }
export function vnorm(o: V3, a: V3): V3 { const l = vlen(a); return l > 1e-9 ? vscale(o, a, 1 / l) : vset(o, 0, 0, 0); }
export function vlerp(o: V3, a: V3, b: V3, t: number): V3 {
  o.x = a.x + (b.x - a.x) * t; o.y = a.y + (b.y - a.y) * t; o.z = a.z + (b.z - a.z) * t; return o;
}

export function qcopy(o: Q4, a: Q4): Q4 { o.x = a.x; o.y = a.y; o.z = a.z; o.w = a.w; return o; }
export function qclone(a: Q4): Q4 { return { x: a.x, y: a.y, z: a.z, w: a.w }; }
export function qmul(o: Q4, a: Q4, b: Q4): Q4 {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w; return o;
}
export function qconj(o: Q4, a: Q4): Q4 { o.x = -a.x; o.y = -a.y; o.z = -a.z; o.w = a.w; return o; }
export function qnorm(o: Q4, a: Q4): Q4 {
  const l = Math.hypot(a.x, a.y, a.z, a.w) || 1;
  o.x = a.x / l; o.y = a.y / l; o.z = a.z / l; o.w = a.w / l; return o;
}
export function qfromAxisAngle(o: Q4, axis: V3, angle: number): Q4 {
  const h = angle * 0.5, s = Math.sin(h);
  o.x = axis.x * s; o.y = axis.y * s; o.z = axis.z * s; o.w = Math.cos(h); return o;
}
/** Rotate vector v by quaternion q. */
export function qrot(o: V3, q: Q4, v: V3): V3 {
  const { x, y, z } = v;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o.x = x + qw * tx + qy * tz - qz * ty;
  o.y = y + qw * ty + qz * tx - qx * tz;
  o.z = z + qw * tz + qx * ty - qy * tx;
  return o;
}
/** Rotate vector v by the inverse of q. */
export function qrotInv(o: V3, q: Q4, v: V3): V3 {
  const c = _qi; c.x = -q.x; c.y = -q.y; c.z = -q.z; c.w = q.w;
  return qrot(o, c, v);
}
const _qi = q4();
export function qslerp(o: Q4, a: Q4, b: Q4, t: number): Q4 {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0: number, k1: number;
  if (cos > 0.9995) { k0 = 1 - t; k1 = t; } else {
    const s = Math.sqrt(1 - cos * cos), ang = Math.atan2(s, cos);
    k0 = Math.sin((1 - t) * ang) / s; k1 = Math.sin(t * ang) / s;
  }
  o.x = a.x * k0 + bx * k1; o.y = a.y * k0 + by * k1; o.z = a.z * k0 + bz * k1; o.w = a.w * k0 + bw * k1;
  return qnorm(o, o);
}
export function qangle(a: Q4, b: Q4): number {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d));
}
/** Quaternion that orients local -Z toward `dir` with local +Y near `up`. */
export function qlookDir(o: Q4, dir: V3, up: V3): Q4 {
  const f = vnorm(v3(), dir);
  const zAxis = v3(-f.x, -f.y, -f.z);
  let xAxis = vcross(v3(), up, zAxis);
  if (vlenSq(xAxis) < 1e-8) xAxis = vcross(v3(), Math.abs(zAxis.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0), zAxis);
  vnorm(xAxis, xAxis);
  const yAxis = vcross(v3(), zAxis, xAxis);
  const m00 = xAxis.x, m01 = yAxis.x, m02 = zAxis.x;
  const m10 = xAxis.y, m11 = yAxis.y, m12 = zAxis.y;
  const m20 = xAxis.z, m21 = yAxis.z, m22 = zAxis.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    o.w = 0.25 / s; o.x = (m21 - m12) * s; o.y = (m02 - m20) * s; o.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    o.w = (m21 - m12) / s; o.x = 0.25 * s; o.y = (m01 + m10) / s; o.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    o.w = (m02 - m20) / s; o.x = (m01 + m10) / s; o.y = 0.25 * s; o.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    o.w = (m10 - m01) / s; o.x = (m02 + m20) / s; o.y = (m12 + m21) / s; o.z = 0.25 * s;
  }
  return qnorm(o, o);
}

/** Shortest rotation taking unit vector a to unit vector b. */
export function qfromTo(o: Q4, a: V3, b: V3): Q4 {
  const d = vdot(a, b);
  if (d < -0.999999) {
    let axis = vcross(v3(), v3(1, 0, 0), a);
    if (vlenSq(axis) < 1e-6) axis = vcross(v3(), v3(0, 1, 0), a);
    return qfromAxisAngle(o, vnorm(axis, axis), Math.PI);
  }
  const c = vcross(v3(), a, b);
  o.x = c.x; o.y = c.y; o.z = c.z; o.w = 1 + d;
  return qnorm(o, o);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Distance along segment [a, a+d*len] (d normalized) to first intersection with sphere, or -1. */
export function segmentSphere(a: V3, d: V3, len: number, c: V3, r: number): number {
  const mx = a.x - c.x, my = a.y - c.y, mz = a.z - c.z;
  const b = mx * d.x + my * d.y + mz * d.z;
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc <= 0) return 0;
  if (b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t <= len ? Math.max(0, t) : -1;
}

/** Closest distance between a segment [a,b] and point p. */
export function segmentPointDistSq(a: V3, b: V3, p: V3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const ll = abx * abx + aby * aby + abz * abz;
  let t = ll > 0 ? (apx * abx + apy * aby + apz * abz) / ll : 0;
  t = clamp(t, 0, 1);
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

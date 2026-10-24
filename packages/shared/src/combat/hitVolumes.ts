import { POSE_HISTORY_TICKS } from '../constants.js';
import type { PoseSample, Ship } from '../entities.js';
import { qrot, segmentPointDistSq, segmentSphere, v3, vadd, type Q4, type V3 } from '../math.js';

export function recordPose(ship: Ship, tick: number): void {
  const idx = tick % POSE_HISTORY_TICKS;
  let s = ship.poseHistory[idx];
  if (!s) { s = { tick, pos: v3(), rot: { x: 0, y: 0, z: 0, w: 1 }, alive: false, generation: 0 }; ship.poseHistory[idx] = s; }
  s.tick = tick; s.alive = ship.alive; s.generation = ship.generation;
  s.pos.x = ship.pos.x; s.pos.y = ship.pos.y; s.pos.z = ship.pos.z;
  s.rot.x = ship.rot.x; s.rot.y = ship.rot.y; s.rot.z = ship.rot.z; s.rot.w = ship.rot.w;
}

/** Pose of a ship at a past tick (lag compensation). Falls back to present pose. */
export function poseAt(ship: Ship, tick: number): PoseSample | null {
  const s = ship.poseHistory[((tick % POSE_HISTORY_TICKS) + POSE_HISTORY_TICKS) % POSE_HISTORY_TICKS];
  if (s && s.tick === tick) return s.alive && s.generation === ship.generation ? s : null;
  return null;
}

const _c = v3();
export function hitSphereWorld(out: V3, pos: V3, rot: Q4, local: V3): V3 {
  return vadd(out, pos, qrot(out, rot, local));
}

/**
 * Earliest distance along the segment at which it touches any of the ship's hit spheres
 * at the given pose, inflated by `inflate`. Returns -1 if none.
 */
export function segmentVsShip(ship: Ship, pos: V3, rot: Q4, a: V3, dir: V3, len: number, inflate: number): number {
  const br = ship.def.boundingRadius + inflate;
  // broadphase: segment vs bounding sphere
  const b = v3(a.x + dir.x * len, a.y + dir.y * len, a.z + dir.z * len);
  if (segmentPointDistSq(a, b, pos) > br * br) return -1;
  let best = -1;
  for (const hs of ship.def.hitSpheres) {
    hitSphereWorld(_c, pos, rot, hs.c);
    const t = segmentSphere(a, dir, len, _c, hs.r + inflate);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/** Minimum distance from a point to the ship's hit volume surface (0 if inside). */
export function pointToShipDistance(ship: Ship, p: V3): number {
  let best = Infinity;
  for (const hs of ship.def.hitSpheres) {
    hitSphereWorld(_c, ship.pos, ship.rot, hs.c);
    const d = Math.hypot(p.x - _c.x, p.y - _c.y, p.z - _c.z) - hs.r;
    if (d < best) best = d;
  }
  return Math.max(0, best);
}

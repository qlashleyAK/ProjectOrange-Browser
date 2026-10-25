import * as RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { boxRotation, type Mover, type Prop } from './arena/blueprint.js';
import { crystalPoints, limbCapsules, logStaves, pillarPoints, rockPoints, spikePoints, type Capsule } from './arena/shapes.js';
import { boxContains, boxDistance, doorClearanceBox, getA, type ArenaData, type Axis } from './arena/generate.js';
import { moverPose, posedSpheres } from './arena/movers.js';
import type { ShipClassDef } from './classes/types.js';
import { DT } from './constants.js';
import { DEG, q4, qfromAxisAngle, qfromTo, v3, vdist, vlerp, vnorm, type Q4, type V3 } from './math.js';

export { RAPIER };

let initPromise: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

export const GROUP_STATIC = 1;
export const GROUP_SHIP = 2;
export const GROUP_QUERY = 4;
export const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);
export const STATIC_GROUPS = groups(GROUP_STATIC, GROUP_SHIP | GROUP_QUERY);
export const SHIP_GROUPS = groups(GROUP_SHIP, GROUP_STATIC | GROUP_SHIP | GROUP_QUERY);
export const QUERY_STATIC = groups(GROUP_QUERY, GROUP_STATIC);
export const QUERY_SHIPS = groups(GROUP_QUERY, GROUP_SHIP);

export const SHIP_RESTITUTION = 0.3;
export const SHIP_FRICTION = 0.15;
export const ARENA_FRICTION = 0.3;
export const CONTACT_FORCE_THRESHOLD = 4e5;

const X90 = qfromAxisAngle(q4(), v3(1, 0, 0), Math.PI / 2);
const Z90 = qfromAxisAngle(q4(), v3(0, 0, 1), Math.PI / 2);
const Y_UP = v3(0, 1, 0);

export function createWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = DT;
  return world;
}

const finish = (d: RAPIER.ColliderDesc, x: number, y: number, z: number, rot: Q4) => d.setTranslation(x, y, z).setRotation(rot)
  .setFriction(ARENA_FRICTION).setCollisionGroups(STATIC_GROUPS).setSolverGroups(STATIC_GROUPS);
function capsuleDescs(caps: Capsule[], origin: V3): RAPIER.ColliderDesc[] {
  return caps.map((c) => {
    const dir = v3(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z), len = Math.hypot(dir.x, dir.y, dir.z);
    const rot = qfromTo(q4(), Y_UP, vnorm(dir, dir));
    return finish(RAPIER.ColliderDesc.capsule(len / 2, c.r),
      (c.a.x + c.b.x) / 2 - origin.x, (c.a.y + c.b.y) / 2 - origin.y, (c.a.z + c.b.z) / 2 - origin.z, rot);
  });
}

/** Colliders for a colliding prop, placed relative to `origin` (body space); none for visual-only props. */
function propColliders(p: Prop, origin: V3): RAPIER.ColliderDesc[] {
  if (!p.collides) return [];
  let d: RAPIER.ColliderDesc | null = null;
  const rot = q4();
  switch (p.kind) {
    case 'box':
      d = RAPIER.ColliderDesc.cuboid(p.size.x / 2, p.size.y / 2, p.size.z / 2);
      boxRotation(p, rot);
      break;
    case 'cylinder':
      d = RAPIER.ColliderDesc.cylinder(p.height / 2, p.radius);
      if (p.axis === 'x') Object.assign(rot, Z90); else if (p.axis === 'z') Object.assign(rot, X90);
      break;
    case 'rock':
      d = RAPIER.ColliderDesc.convexHull(new Float32Array(rockPoints(p.radius, p.seed, p.squash ?? 1)));
      break;
    case 'pillar':
      d = RAPIER.ColliderDesc.convexHull(new Float32Array(pillarPoints(p.radius, p.height, p.seed)));
      break;
    case 'crystal':
      d = RAPIER.ColliderDesc.convexHull(new Float32Array(crystalPoints(p.length, p.radius)));
      qfromTo(rot, Y_UP, p.dir);
      break;
    case 'spike':
      d = RAPIER.ColliderDesc.convexHull(new Float32Array(spikePoints(p.length, p.radius, p.seed)));
      qfromTo(rot, Y_UP, p.dir);
      break;
    case 'ring':
      break;
    case 'hull':
      d = RAPIER.ColliderDesc.convexHull(new Float32Array(p.points));
      break;
    case 'limb': return capsuleDescs(limbCapsules(p.points, p.radii), origin);
    case 'log': return capsuleDescs(logStaves(p.center, p.dir, p.length, p.outer, p.inner), origin);
  }
  if (!d) return [];
  return [finish(d, p.center.x - origin.x, p.center.y - origin.y, p.center.z - origin.z, rot)];
}

const ORIGIN = v3();

/** Add every static arena collider in blueprint order (slabs then props). Determinism depends on this order. */
export function addArenaColliders(world: RAPIER.World, arena: ArenaData): RAPIER.RigidBody {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const s of arena.slabs) {
    const d = RAPIER.ColliderDesc.cuboid(s.half.x, s.half.y, s.half.z)
      .setTranslation(s.center.x, s.center.y, s.center.z)
      .setFriction(ARENA_FRICTION).setCollisionGroups(STATIC_GROUPS).setSolverGroups(STATIC_GROUPS);
    world.createCollider(d, body);
  }
  for (const p of arena.blueprint.props) for (const d of propColliders(p, ORIGIN)) world.createCollider(d, body);
  return body;
}

export interface MoverBody { def: Mover; body: RAPIER.RigidBody }

/**
 * Kinematic bodies for the arena's movers, posed at `tick`. They share the static collision groups, so
 * ships bounce off them and every static query (shots, line of sight, feelers) sees them.
 */
export function addMovers(world: RAPIER.World, arena: ArenaData, tick: number): MoverBody[] {
  const pos = v3(), rot = q4();
  return arena.movers.map((m) => {
    moverPose(m, tick, pos, rot);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    for (const p of m.parts) for (const d of propColliders(p, m.origin)) world.createCollider(d, body);
    return { def: m, body };
  });
}

const _mp = v3(), _mr = q4();
/** Target pose for the coming physics step; Rapier derives the velocity that pushes ships. */
export function driveMovers(movers: MoverBody[], tick: number): void {
  for (const m of movers) {
    moverPose(m.def, tick, _mp, _mr);
    m.body.setNextKinematicTranslation(_mp);
    m.body.setNextKinematicRotation(_mr);
  }
}
/** Teleport without imparting velocity (prediction rewinds). */
export function placeMovers(movers: MoverBody[], tick: number): void {
  for (const m of movers) {
    moverPose(m.def, tick, _mp, _mr);
    m.body.setTranslation(_mp, true);
    m.body.setRotation(_mr, true);
  }
}

export function shipColliderDescs(def: ShipClassDef): RAPIER.ColliderDesc[] {
  const out: RAPIER.ColliderDesc[] = [];
  for (const c of def.colliders) {
    let d: RAPIER.ColliderDesc | null = null;
    switch (c.type) {
      case 'capsuleZ':
        d = RAPIER.ColliderDesc.capsule(c.halfHeight, c.radius).setTranslation(c.pos.x, c.pos.y, c.pos.z).setRotation(X90);
        break;
      case 'cuboid':
        d = RAPIER.ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z).setTranslation(c.pos.x, c.pos.y, c.pos.z);
        if (c.yawDeg) d.setRotation(qfromAxisAngle(q4(), Y_UP, c.yawDeg * DEG));
        break;
      case 'ball':
        d = RAPIER.ColliderDesc.ball(c.radius).setTranslation(c.pos.x, c.pos.y, c.pos.z);
        break;
      case 'hull':
        d = RAPIER.ColliderDesc.convexHull(new Float32Array(c.points));
        break;
    }
    if (d) out.push(d);
  }
  return out;
}

export function createShipBody(world: RAPIER.World, def: ShipClassDef, pos: V3, rot: Q4, kinematic = false): RAPIER.RigidBody {
  const L = def.size.z, Wd = def.size.x, H = def.size.y, m = def.mass;
  const desc = (kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
    .setTranslation(pos.x, pos.y, pos.z).setRotation(rot)
    .setGravityScale(0).setLinearDamping(0).setAngularDamping(0).setCanSleep(false);
  if (!kinematic) {
    desc.setCcdEnabled(true).setAdditionalMassProperties(
      m, { x: 0, y: 0, z: 0 },
      { x: (m / 12) * (H * H + L * L), y: (m / 12) * (Wd * Wd + L * L), z: (m / 12) * (Wd * Wd + H * H) },
      { x: 0, y: 0, z: 0, w: 1 },
    );
  }
  const body = world.createRigidBody(desc);
  for (const d of shipColliderDescs(def)) {
    d.setDensity(0).setRestitution(SHIP_RESTITUTION).setFriction(SHIP_FRICTION)
      .setCollisionGroups(SHIP_GROUPS).setSolverGroups(SHIP_GROUPS);
    if (!kinematic) d.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(CONTACT_FORCE_THRESHOLD);
    world.createCollider(d, body);
  }
  // mass props are otherwise only computed at the next step, which would swallow a first-tick impulse
  if (!kinematic) body.recomputeMassPropertiesFromColliders();
  return body;
}

const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
/** Ray-cast against static arena geometry. Returns distance or -1. */
export function castStatic(world: RAPIER.World, from: V3, dir: V3, maxDist: number): number {
  _ray.origin = from; _ray.dir = dir;
  const hit = world.castRay(_ray, maxDist, true, undefined, QUERY_STATIC);
  return hit ? hit.timeOfImpact : -1;
}
export function lineOfSight(world: RAPIER.World, a: V3, b: V3): boolean {
  const d = v3(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-4) return true;
  vnorm(d, d);
  return castStatic(world, a, d, len) < 0;
}

const _balls = new Map<number, RAPIER.Ball>();
function ball(r: number): RAPIER.Ball {
  let b = _balls.get(r);
  if (!b) { b = new RAPIER.Ball(r); _balls.set(r, b); }
  return b;
}
const IDENT = { x: 0, y: 0, z: 0, w: 1 };
export function sphereFree(world: RAPIER.World, pos: V3, r: number): boolean {
  return world.intersectionWithShape(pos, IDENT, ball(r), undefined, QUERY_STATIC) === null;
}
/** Sphere-cast against static geometry; returns time-of-impact distance or -1. */
export function sphereCastStatic(world: RAPIER.World, from: V3, dir: V3, r: number, maxDist: number): number {
  const hit = world.castShape(from, IDENT, dir, ball(r), 0, maxDist, true, undefined, QUERY_STATIC);
  return hit ? hit.time_of_impact : -1;
}

/** Validate and nudge spawn points so a 12 m sphere is free (Section 15.6). */
export function finalizeSpawns(world: RAPIER.World, arena: ArenaData): string[] {
  const errors: string[] = [];
  for (const s of arena.spawns) {
    const room = arena.blueprint.rooms.find((r) => r.id === s.room)!;
    let ok = sphereFree(world, s.pos, 12);
    for (let i = 1; !ok && i <= 20; i++) {
      const p = vlerp(v3(), s.pos, room.center, i * 0.04);
      if (sphereFree(world, p, 12)) { s.pos = p; ok = true; }
    }
    if (!ok) {
      // nearest free point on a 3 m grid around the candidate
      const offs: V3[] = [];
      for (let x = -18; x <= 18; x += 3) for (let y = -18; y <= 18; y += 3) for (let z = -18; z <= 18; z += 3) offs.push(v3(x, y, z));
      offs.sort((a, b) => (a.x * a.x + a.y * a.y + a.z * a.z) - (b.x * b.x + b.y * b.y + b.z * b.z));
      for (const o of offs) {
        const p = v3(s.pos.x + o.x, s.pos.y + o.y, s.pos.z + o.z);
        if (sphereFree(world, p, 12)) { s.pos = p; ok = true; break; }
      }
    }
    if (!ok) errors.push(`spawn in ${s.room} has no 12 m clearance`);
    s.facing = s.aimed ? vnorm(v3(), s.facing) : vnorm(v3(), v3(room.center.x - s.pos.x, 0, room.center.z - s.pos.z));
  }
  return errors;
}

/** Physics-based validations: tunnel traversal sphere-casts and doorway clearance zones. */
export function validateArenaPhysics(world: RAPIER.World, arena: ArenaData, castRadius = 8): string[] {
  const errors: string[] = [];
  for (const t of arena.blueprint.tunnels) {
    for (let i = 0; i < t.path.length - 1; i++) {
      const a = t.path[i]!, b = t.path[i + 1]!;
      const len = vdist(a, b);
      const dir = vnorm(v3(), v3(b.x - a.x, b.y - a.y, b.z - a.z));
      const toi = sphereCastStatic(world, a, dir, castRadius, len);
      if (toi >= 0) errors.push(`sphere-cast blocked in ${t.id} segment ${i} at ${toi.toFixed(1)} m`);
    }
  }
  const cuboids = new Map<string, RAPIER.Cuboid>();
  for (const d of arena.doorways) {
    const box = doorClearanceBox(d, 20, 0.5);
    const half = v3((box.max.x - box.min.x) / 2, (box.max.y - box.min.y) / 2, (box.max.z - box.min.z) / 2);
    const key = `${half.x},${half.y},${half.z}`;
    let shape = cuboids.get(key);
    if (!shape) { shape = new RAPIER.Cuboid(half.x, half.y, half.z); cuboids.set(key, shape); }
    const c = v3((box.max.x + box.min.x) / 2, (box.max.y + box.min.y) / 2, (box.max.z + box.min.z) / 2);
    if (world.intersectionWithShape(c, IDENT, shape, undefined, QUERY_STATIC) !== null) {
      errors.push(`doorway clearance blocked at ${d.id} (${d.room.id}, axis ${'xyz'[d.axis as Axis]}=${getA(d.center, d.axis)})`);
    }
  }
  return errors;
}

/** A moving part never gets closer than this to static geometry, so a ship can't be pinned against a wall. */
export const MOVER_CLEARANCE = 16;

/**
 * Sweep every mover through its cycle against a world holding only the static arena: it keeps
 * MOVER_CLEARANCE from walls and props, stays out of doorway clearance zones and never touches another mover.
 */
export function validateMovers(world: RAPIER.World, arena: ArenaData, samples = 96): string[] {
  const errors: string[] = [];
  for (const m of arena.movers) {
    const rb = arena.roomBoxes.get(m.room);
    const doors = arena.doorways.filter((d) => d.room.id === m.room).map((d) => ({ d, box: doorClearanceBox(d, 20, 0) }));
    const cycle = Math.abs(m.motion.period) / DT;
    let wall = false, outside = false, door = '';
    for (let k = 0; k < samples; k++) {
      for (const s of posedSpheres(m, (k / samples) * cycle)) {
        if (!wall && !sphereFree(world, s.c, s.r + MOVER_CLEARANCE)) wall = true;
        if (rb && !boxContains(rb, s.c)) outside = true;
        if (!door) for (const { d, box } of doors) if (boxDistance(box, s.c) < s.r) door = d.id;
      }
    }
    if (wall) errors.push(`mover ${m.id} comes within ${MOVER_CLEARANCE} m of static geometry`);
    if (outside) errors.push(`mover ${m.id} leaves room ${m.room}`);
    if (door) errors.push(`mover ${m.id} sweeps through doorway ${door}`);
  }
  // kinematic bodies pass through each other, which would look broken
  for (let i = 0; i < arena.movers.length; i++) for (let j = i + 1; j < arena.movers.length; j++) {
    const a = arena.movers[i]!, b = arena.movers[j]!;
    if (a.room !== b.room) continue;
    for (let t = 0; t < 240 / DT; t += 15) {
      const sa = posedSpheres(a, t), sb = posedSpheres(b, t);
      if (sa.some((p) => sb.some((q) => vdist(p.c, q.c) < p.r + q.r))) { errors.push(`movers ${a.id} and ${b.id} collide`); break; }
    }
  }
  return errors;
}

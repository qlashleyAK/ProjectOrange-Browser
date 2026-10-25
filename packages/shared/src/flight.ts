import type * as RAPIER from '@dimforge/rapier3d-deterministic-compat';
import type { ShipClassDef } from './classes/types.js';
import { InputFlag, type InputCmd } from './input.js';
import { clamp, qrot, qrotInv, v3, vlen, type V3 } from './math.js';

export const DODGE_ROLL_TIME = 0.5;
export const DODGE_COST = 0.2;
export const BOOST_REGEN_DELAY = 0.5;
export const BOOST_UNLOCK = 0.2;
export const BRAKE_ACCEL_MULT = 1.6;
export const SOFT_CAP_MULT = 1.25;
export const SOFT_CAP_BLEED = 2;

export interface FlightState {
  boostMeter: number;
  boostLocked: boolean;
  /** seconds since boost was last active */
  sinceBoost: number;
  dodgeCooldown: number;
  dodgeRollTime: number;
  /** +1 roll right, -1 roll left, 0 none */
  dodgeRollDir: number;
  boosting: boolean;
}

export function newFlightState(): FlightState {
  return { boostMeter: 1, boostLocked: false, sinceBoost: 10, dodgeCooldown: 0, dodgeRollTime: 0, dodgeRollDir: 0, boosting: false };
}
export function copyFlightState(o: FlightState, a: FlightState): FlightState {
  o.boostMeter = a.boostMeter; o.boostLocked = a.boostLocked; o.sinceBoost = a.sinceBoost; o.dodgeCooldown = a.dodgeCooldown;
  o.dodgeRollTime = a.dodgeRollTime; o.dodgeRollDir = a.dodgeRollDir; o.boosting = a.boosting; return o;
}

export interface FlightOptions {
  /** Overdrive: boost does not drain */
  noBoostDrain?: boolean;
  /** Bots use a fraction of max turn rate */
  turnScale?: number;
  /** speed powerup: acceleration and top speed multipliers */
  thrustMult?: number;
  speedMult?: number;
}

export interface FlightResult { dodged: boolean; dodgeDir: V3 | null }

const _q = { x: 0, y: 0, z: 0, w: 1 };
const _v = v3(), _w = v3(), _t = v3(), _imp = v3();
const _result: FlightResult = { dodged: false, dodgeDir: null };

/**
 * Turn an input command into physical changes for one fixed tick.
 * Must be called identically on server, offline sim, and client prediction.
 */
export function applyFlightControl(
  body: RAPIER.RigidBody, input: InputCmd, def: ShipClassDef, st: FlightState, dt: number, opts: FlightOptions = {},
): FlightResult {
  const r = body.rotation(); _q.x = r.x; _q.y = r.y; _q.z = r.z; _q.w = r.w;
  const lv = body.linvel(); _v.x = lv.x; _v.y = lv.y; _v.z = lv.z;
  const mass = def.mass;
  const flags = input.flags;
  const assist = (flags & InputFlag.AssistOn) !== 0;
  const brake = (flags & InputFlag.Brake) !== 0;
  const hasThrust = input.tFwd !== 0 || input.tRight !== 0 || input.tUp !== 0;

  // ---- Boost meter (4.5)
  if (st.boostLocked && st.boostMeter > BOOST_UNLOCK) st.boostLocked = false;
  const wantBoost = (flags & InputFlag.Boost) !== 0 && hasThrust && !brake;
  const boost = wantBoost && st.boostMeter > 0 && !st.boostLocked;
  st.boosting = boost;
  if (boost) {
    if (!opts.noBoostDrain) st.boostMeter -= def.boostDrain * dt;
    st.sinceBoost = 0;
    if (st.boostMeter <= 0) { st.boostMeter = 0; st.boostLocked = true; }
  } else {
    st.sinceBoost += dt;
    if (st.sinceBoost >= BOOST_REGEN_DELAY) st.boostMeter = Math.min(1, st.boostMeter + def.boostRegen * dt);
  }

  // ---- Dodge (4.6)
  _result.dodged = false; _result.dodgeDir = null;
  st.dodgeCooldown = Math.max(0, st.dodgeCooldown - dt);
  const dodgeBits = flags & (InputFlag.DodgeL | InputFlag.DodgeR | InputFlag.DodgeU | InputFlag.DodgeD);
  if (dodgeBits && st.dodgeCooldown <= 0 && st.boostMeter >= DODGE_COST) {
    const dir = v3(
      (flags & InputFlag.DodgeR ? 1 : 0) - (flags & InputFlag.DodgeL ? 1 : 0),
      (flags & InputFlag.DodgeU ? 1 : 0) - (flags & InputFlag.DodgeD ? 1 : 0),
      0,
    );
    const l = vlen(dir);
    if (l > 0) {
      dir.x /= l; dir.y /= l;
      st.boostMeter -= DODGE_COST;
      st.dodgeCooldown = def.dodgeCooldown;
      if (dir.x !== 0) { st.dodgeRollTime = DODGE_ROLL_TIME; st.dodgeRollDir = Math.sign(dir.x); }
      qrot(_imp, _q, dir);
      const k = def.dodgeDV * mass;
      body.applyImpulse({ x: _imp.x * k, y: _imp.y * k, z: _imp.z * k }, true);
      _result.dodged = true; _result.dodgeDir = dir;
      const nv = body.linvel(); _v.x = nv.x; _v.y = nv.y; _v.z = nv.z;
    }
  }

  // ---- Translation
  const thr = opts.thrustMult ?? 1, top = opts.speedMult ?? 1;
  let accF = def.accel.fwd * thr, accL = def.accel.lateral * thr, accV = def.accel.vertical * thr;
  let maxF = def.maxSpeed.fwd * top;
  if (boost) { maxF *= def.boostSpeedMult; accF *= def.boostAccelMult; accL *= def.boostAccelMult; accV *= def.boostAccelMult; }
  if (assist || brake) {
    qrotInv(_t, _q, _v); // local velocity
    let tx = input.tRight * def.maxSpeed.strafe * top;
    let ty = input.tUp * def.maxSpeed.vertical * top;
    let tz = -input.tFwd * (input.tFwd >= 0 ? maxF : def.maxSpeed.reverse * top);
    if (brake) { tx = 0; ty = 0; tz = 0; accF *= BRAKE_ACCEL_MULT; accL *= BRAKE_ACCEL_MULT; accV *= BRAKE_ACCEL_MULT; }
    // While dodging, don't fight the lateral impulse.
    if (st.dodgeRollTime > 1e-9 && !brake) { tx = _t.x; ty = _t.y; }
    const dx = clamp(tx - _t.x, -accL * dt, accL * dt);
    const dy = clamp(ty - _t.y, -accV * dt, accV * dt);
    const dz = clamp(tz - _t.z, -accF * dt, accF * dt);
    _w.x = dx * mass; _w.y = dy * mass; _w.z = dz * mass;
    qrot(_imp, _q, _w);
    body.applyImpulse({ x: _imp.x, y: _imp.y, z: _imp.z }, true);
  } else {
    _w.x = input.tRight * accL * mass * dt;
    _w.y = input.tUp * accV * mass * dt;
    _w.z = -input.tFwd * accF * mass * dt;
    qrot(_imp, _q, _w);
    const speed = vlen(_v);
    const cap = SOFT_CAP_MULT * maxF;
    if (speed > cap) {
      const bleed = (SOFT_CAP_BLEED * dt * mass) / speed;
      _imp.x -= _v.x * bleed; _imp.y -= _v.y * bleed; _imp.z -= _v.z * bleed;
    }
    body.applyImpulse({ x: _imp.x, y: _imp.y, z: _imp.z }, true);
  }

  // ---- Rotation (4.4)
  const av = body.angvel(); _v.x = av.x; _v.y = av.y; _v.z = av.z;
  qrotInv(_t, _q, _v);
  const ts = opts.turnScale ?? 1;
  const tp = input.rPitch * def.maxRate.pitch * ts;
  const ty = -input.rYaw * def.maxRate.yaw * ts;
  let tr = -input.rRoll * def.maxRate.roll * ts;
  let rollAcc = def.angAccel.roll;
  if (st.dodgeRollTime > 1e-9) {
    tr = -st.dodgeRollDir * (Math.PI * 2) / DODGE_ROLL_TIME;
    rollAcc = 1e6;
    st.dodgeRollTime = Math.max(0, st.dodgeRollTime - dt);
  } else if (st.dodgeRollDir !== 0) {
    // roll finished: stop the spin exactly at 360°
    st.dodgeRollTime = 0;
    st.dodgeRollDir = 0;
    rollAcc = 1e6;
  }
  _w.x = _t.x + clamp(tp - _t.x, -def.angAccel.pitch * dt, def.angAccel.pitch * dt);
  _w.y = _t.y + clamp(ty - _t.y, -def.angAccel.yaw * dt, def.angAccel.yaw * dt);
  _w.z = _t.z + clamp(tr - _t.z, -rollAcc * dt, rollAcc * dt);
  qrot(_imp, _q, _w);
  body.setAngvel({ x: _imp.x, y: _imp.y, z: _imp.z }, true);
  return _result;
}

import { CLASS_LIST, type PrimaryDef } from '../classes/index.js';
import { MAX_INPUTS_PER_PACKET } from '../constants.js';
import type { EndReason } from '../entities.js';
import type { FlightState } from '../flight.js';
import type { InputCmd } from '../input.js';
import { q4, v3, type Q4, type V3 } from '../math.js';
import { clampI16, decodeQuat, dqAxis, encodeQuat, qAxis } from './quantize.js';

export const enum MsgType { Input = 1, Ping = 2, Snapshot = 10, Pong = 11 }

export class Writer {
  buf: ArrayBuffer;
  dv: DataView;
  off = 0;
  constructor(size = 1024) { this.buf = new ArrayBuffer(size); this.dv = new DataView(this.buf); }
  private ensure(n: number): void {
    if (this.off + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.off + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.off));
    this.buf = nb; this.dv = new DataView(nb);
  }
  u8(v: number) { this.ensure(1); this.dv.setUint8(this.off, v); this.off += 1; }
  i8(v: number) { this.ensure(1); this.dv.setInt8(this.off, v); this.off += 1; }
  u16(v: number) { this.ensure(2); this.dv.setUint16(this.off, v & 0xffff, true); this.off += 2; }
  i16(v: number) { this.ensure(2); this.dv.setInt16(this.off, clampI16(v), true); this.off += 2; }
  u32(v: number) { this.ensure(4); this.dv.setUint32(this.off, v >>> 0, true); this.off += 4; }
  i32(v: number) { this.ensure(4); this.dv.setInt32(this.off, Math.max(-2147483648, Math.min(2147483647, Math.round(v))), true); this.off += 4; }
  f32(v: number) { this.ensure(4); this.dv.setFloat32(this.off, v, true); this.off += 4; }
  f64(v: number) { this.ensure(8); this.dv.setFloat64(this.off, v, true); this.off += 8; }
  posMm(p: V3) { this.i32(p.x * 1000); this.i32(p.y * 1000); this.i32(p.z * 1000); }
  vec16(p: V3, scale: number) { this.i16(p.x * scale); this.i16(p.y * scale); this.i16(p.z * scale); }
  vecF(p: V3) { this.f32(p.x); this.f32(p.y); this.f32(p.z); }
  quat(q: Q4) { const e = encodeQuat(q); this.u8(e[0]); this.i16(e[1]); this.i16(e[2]); this.i16(e[3]); }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.off); }
  reset() { this.off = 0; }
}

export class Reader {
  dv: DataView;
  off = 0;
  constructor(data: ArrayBuffer | Uint8Array) {
    this.dv = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  }
  get remaining() { return this.dv.byteLength - this.off; }
  u8() { const v = this.dv.getUint8(this.off); this.off += 1; return v; }
  i8() { const v = this.dv.getInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.dv.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.dv.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.dv.getUint32(this.off, true); this.off += 4; return v; }
  i32() { const v = this.dv.getInt32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.off, true); this.off += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.off, true); this.off += 8; return v; }
  posMm(): V3 { return v3(this.i32() / 1000, this.i32() / 1000, this.i32() / 1000); }
  vec16(scale: number): V3 { return v3(this.i16() / scale, this.i16() / scale, this.i16() / scale); }
  vecF(): V3 { return v3(this.f32(), this.f32(), this.f32()); }
  quat(): Q4 { const h = this.u8(); return decodeQuat(q4(), h, this.i16(), this.i16(), this.i16()); }
}

// ------------------------------------------------------------------ weapons table
export const PRIMARY_TABLE: PrimaryDef[] = CLASS_LIST.flatMap((c) => [c.primary, c.altPrimary]);
export const primaryIndex = (id: string) => PRIMARY_TABLE.findIndex((w) => w.id === id);
export const END_REASONS: EndReason[] = ['expire', 'world', 'ship', 'bulwark', 'torpedo', 'repel', 'owner', 'proximity'];

// ------------------------------------------------------------------ inputs
export function writeInputCmd(w: Writer, c: InputCmd): void {
  w.u16(c.seq); w.u32(c.tick);
  w.i8(qAxis(c.tFwd)); w.i8(qAxis(c.tRight)); w.i8(qAxis(c.tUp));
  w.i8(qAxis(c.rPitch)); w.i8(qAxis(c.rYaw)); w.i8(qAxis(c.rRoll));
  w.u16(c.flags);
}
export function readInputCmd(r: Reader): InputCmd {
  return {
    seq: r.u16(), tick: r.u32(),
    tFwd: dqAxis(r.i8()), tRight: dqAxis(r.i8()), tUp: dqAxis(r.i8()),
    rPitch: dqAxis(r.i8()), rYaw: dqAxis(r.i8()), rRoll: dqAxis(r.i8()),
    flags: r.u16(),
  };
}

/** One constant bounds both the sender and the decoder so bursts are never silently truncated. */
export function encodeInputPacket(cmds: InputCmd[]): Uint8Array {
  if (cmds.length > MAX_INPUTS_PER_PACKET) throw new Error('too many inputs for one packet');
  const w = new Writer(4 + cmds.length * 14);
  w.u8(MsgType.Input); w.u8(cmds.length);
  for (const c of cmds) writeInputCmd(w, c);
  return w.bytes();
}
export function decodeInputPacket(r: Reader): InputCmd[] {
  const n = Math.min(r.u8(), MAX_INPUTS_PER_PACKET);
  const out: InputCmd[] = [];
  for (let i = 0; i < n && r.remaining >= 14; i++) out.push(readInputCmd(r));
  return out;
}

/** Client → server: send time, current interpolation delay and last measured RTT (seconds). */
export function encodePing(clientTime: number, interpDelay: number, rtt: number): Uint8Array {
  const w = new Writer(24); w.u8(MsgType.Ping); w.f64(clientTime); w.f32(interpDelay); w.f32(rtt); return w.bytes();
}
export function encodePong(clientTime: number, serverTick: number, sinceTick: number): Uint8Array {
  const w = new Writer(24); w.u8(MsgType.Pong); w.f64(clientTime); w.u32(serverTick); w.f32(sinceTick); return w.bytes();
}

// ------------------------------------------------------------------ snapshots
export const enum ShipFlag {
  Cloaked = 1, Bulwark = 2, Overdrive = 4, SpawnProtected = 8, AssistOn = 16, Boosting = 32, Sweeping = 64, DodgeRoll = 128,
  Locking = 256, Shimmer = 512, Safe = 1024,
}

export interface ShipSnap {
  id: number; gen: number; cls: number; pos: V3; rot: Q4; vel: V3; angvel: V3;
  boost: number; flags: number; hull: number; shield: number; power: number;
}

export interface OwnerSnap {
  id: number; gen: number; cls: number; lastSeq: number;
  pos: V3; rot: Q4; vel: V3; angvel: V3;
  flight: FlightState;
  energy: number; ammo: number; abilityCooldown: number; abilityActive: number; repelCooldown: number;
  power: number; hull: number; shield: number; maxShield: number;
  lockTarget: number; lockProgress: number; locked: boolean; lockWarn: number; missileWarn: number;
  bulwarkHp: number; primaryLastFire: number; muzzleIndex: number; spawnProtectedUntil: number; cloaked: boolean;
  safeCharge: number;
}

export interface MissileSnap { id: number; pos: V3; vel: V3 }
export interface ProjSpawnSnap { id: number; owner: number; weapon: number; pos: V3; vel: V3; spawnTick: number; shotId: number; index: number }
export interface ProjEndSnap { id: number; reason: number; pos: V3 }

export interface Snapshot {
  tick: number;
  bufferDepth: number;
  owner: OwnerSnap | null;
  ships: ShipSnap[];
  missiles: MissileSnap[] | null;
  projSpawns: ProjSpawnSnap[];
  projEnds: ProjEndSnap[];
}

export function encodeSnapshot(s: Snapshot, w = new Writer(2048)): Uint8Array {
  w.reset();
  w.u8(MsgType.Snapshot); w.u32(s.tick); w.u8(Math.min(255, s.bufferDepth));
  w.u8((s.owner ? 1 : 0) | (s.missiles ? 2 : 0));
  if (s.owner) {
    const o = s.owner;
    w.u8(o.id); w.u8(o.gen); w.u8(o.cls); w.u16(o.lastSeq);
    w.vecF(o.pos); w.f32(o.rot.x); w.f32(o.rot.y); w.f32(o.rot.z); w.f32(o.rot.w); w.vecF(o.vel); w.vecF(o.angvel);
    const f = o.flight;
    w.f64(f.boostMeter); w.u8((f.boostLocked ? 1 : 0) | (f.boosting ? 2 : 0)); w.f32(f.sinceBoost); w.f32(f.dodgeCooldown);
    w.f32(f.dodgeRollTime); w.i8(f.dodgeRollDir);
    w.f32(o.energy); w.u8(o.ammo); w.f32(o.abilityCooldown); w.f32(o.abilityActive); w.f32(o.repelCooldown);
    w.u8(o.power); w.f32(o.hull); w.f32(o.shield); w.f32(o.maxShield);
    w.u8(o.lockTarget < 0 ? 255 : o.lockTarget); w.f32(o.lockProgress); w.u8(o.locked ? 1 : 0); w.u8(o.lockWarn); w.u8(o.missileWarn);
    w.f32(o.bulwarkHp); w.u32(o.primaryLastFire); w.u16(o.muzzleIndex); w.u32(o.spawnProtectedUntil); w.u8(o.cloaked ? 1 : 0);
    w.f32(o.safeCharge);
  }
  w.u8(s.ships.length);
  for (const sh of s.ships) {
    w.u8(sh.id); w.u8(sh.gen); w.u8(sh.cls); w.posMm(sh.pos); w.quat(sh.rot); w.vec16(sh.vel, 100); w.vec16(sh.angvel, 1000);
    w.u8(Math.round(sh.boost * 255)); w.u16(sh.flags); w.u8(Math.round(sh.hull * 255)); w.u8(Math.round(sh.shield * 255)); w.u8(sh.power);
  }
  if (s.missiles) {
    w.u8(s.missiles.length);
    for (const m of s.missiles) { w.u16(m.id); w.posMm(m.pos); w.vec16(m.vel, 100); }
  }
  w.u16(s.projSpawns.length);
  for (const p of s.projSpawns) {
    w.u16(p.id); w.u8(p.owner); w.u8(p.weapon); w.posMm(p.pos); w.vec16(p.vel, 10); w.u32(p.spawnTick); w.u32(p.shotId); w.u8(p.index);
  }
  w.u16(s.projEnds.length);
  for (const p of s.projEnds) { w.u16(p.id); w.u8(p.reason); w.posMm(p.pos); }
  return w.bytes().slice();
}

export function decodeSnapshot(r: Reader): Snapshot {
  const tick = r.u32(), bufferDepth = r.u8(), hdr = r.u8();
  let owner: OwnerSnap | null = null;
  if (hdr & 1) {
    const id = r.u8(), gen = r.u8(), cls = r.u8(), lastSeq = r.u16();
    const pos = r.vecF(); const rot = q4(r.f32(), r.f32(), r.f32(), r.f32()); const vel = r.vecF(); const angvel = r.vecF();
    const boostMeter = r.f64(); const fb = r.u8(); const sinceBoost = r.f32(); const dodgeCooldown = r.f32();
    const dodgeRollTime = r.f32(); const dodgeRollDir = r.i8();
    const flight: FlightState = { boostMeter, boostLocked: (fb & 1) !== 0, boosting: (fb & 2) !== 0, sinceBoost, dodgeCooldown, dodgeRollTime, dodgeRollDir };
    const energy = r.f32(), ammo = r.u8(), abilityCooldown = r.f32(), abilityActive = r.f32(), repelCooldown = r.f32();
    const power = r.u8(), hull = r.f32(), shield = r.f32(), maxShield = r.f32();
    const lt = r.u8(), lockProgress = r.f32(), locked = r.u8() === 1, lockWarn = r.u8(), missileWarn = r.u8();
    const bulwarkHp = r.f32(), primaryLastFire = r.u32(), muzzleIndex = r.u16(), spawnProtectedUntil = r.u32(), cloaked = r.u8() === 1;
    const safeCharge = r.f32();
    owner = {
      id, gen, cls, lastSeq, pos, rot, vel, angvel, flight, energy, ammo, abilityCooldown, abilityActive, repelCooldown,
      power, hull, shield, maxShield, lockTarget: lt === 255 ? -1 : lt, lockProgress, locked, lockWarn, missileWarn,
      bulwarkHp, primaryLastFire, muzzleIndex, spawnProtectedUntil, cloaked, safeCharge,
    };
  }
  const ships: ShipSnap[] = [];
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    ships.push({
      id: r.u8(), gen: r.u8(), cls: r.u8(), pos: r.posMm(), rot: r.quat(), vel: r.vec16(100), angvel: r.vec16(1000),
      boost: r.u8() / 255, flags: r.u16(), hull: r.u8() / 255, shield: r.u8() / 255, power: r.u8(),
    });
  }
  let missiles: MissileSnap[] | null = null;
  if (hdr & 2) {
    missiles = [];
    const nm = r.u8();
    for (let i = 0; i < nm; i++) missiles.push({ id: r.u16(), pos: r.posMm(), vel: r.vec16(100) });
  }
  const projSpawns: ProjSpawnSnap[] = [];
  const ns = r.u16();
  for (let i = 0; i < ns; i++) {
    projSpawns.push({ id: r.u16(), owner: r.u8(), weapon: r.u8(), pos: r.posMm(), vel: r.vec16(10), spawnTick: r.u32(), shotId: r.u32(), index: r.u8() });
  }
  const projEnds: ProjEndSnap[] = [];
  const ne = r.u16();
  for (let i = 0; i < ne; i++) projEnds.push({ id: r.u16(), reason: r.u8(), pos: r.posMm() });
  return { tick, bufferDepth, owner, ships, missiles, projSpawns, projEnds };
}

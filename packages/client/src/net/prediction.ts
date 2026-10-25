import {
  activePrimary, addArenaColliders, addMovers, applyFlightControl, applyPrimarySeek, cadenceTicks, classByIndex, copyFlightState,
  createShipBody, createWorld, CORRECTION_TAU, driveMovers, DT, HARD_SNAP_ANGLE, HARD_SNAP_DIST, InputFlag, newFlightState,
  OVERDRIVE_CADENCE, placeMovers, PREDICTION_HISTORY, projectileCount, q4, qangle, qconj, qmul, qnorm, qslerp, resolveTier,
  SAFE_ZONE_CHARGE_S, safeZoneAt, shotIdFor, stepSafeCharge, v3, volleyShots,
  type ArenaData, type FlightState, type InputCmd, type MoverBody, type MuzzleShot, type OwnerSnap, type PrimaryDef, type Q4,
  type RAPIER, type ShipClassDef, type V3,
} from '@orange/shared';

/** Locally-predicted, non-physical state that affects flight or firing. */
interface PredState {
  flight: FlightState;
  energy: number;
  abilityActive: number;
  abilityCooldown: number;
  muzzleIndex: number;
  sinceFire: number;
  prevFlags: number;
  safeCharge: number;
  safe: boolean;
}

interface HistoryEntry {
  cmd: InputCmd;
  /** local input counter: the server consumes one input per tick, so this tracks the tick it lands on */
  n: number;
  pos: V3; rot: Q4; vel: V3; angvel: V3;
  st: PredState;
}

export interface PredictedVolley { shotId: number; weapon: PrimaryDef; shots: MuzzleShot[] }

const POS_TOL = 0.05, ROT_TOL = 1.0 * Math.PI / 180, VEL_TOL = 0.35;
const IDENT = q4();

const cloneSt = (s: PredState): PredState => ({ ...s, flight: copyFlightState(newFlightState(), s.flight) });

/**
 * Client-side prediction of the local ship: its own Rapier world with static arena geometry plus kinematic
 * proxies of nearby ships. Replays unacknowledged inputs when the server disagrees and smooths the visual error.
 */
export class Predictor {
  readonly world: RAPIER.World;
  private body: RAPIER.RigidBody | null = null;
  def: ShipClassDef | null = null;
  gen = -1;
  shipId = -1;
  power = 0;
  weaponsEnabled = true;
  private st: PredState = {
    flight: newFlightState(), energy: 0, abilityActive: 0, abilityCooldown: 0, muzzleIndex: 0, sinceFire: 999, prevFlags: 0,
    safeCharge: SAFE_ZONE_CHARGE_S, safe: false,
  };
  private history = new Map<number, HistoryEntry>();
  private lastSeq = -1;
  private proxies = new Map<number, { body: RAPIER.RigidBody; cls: number }>();
  private movers: MoverBody[];
  private moverTick = -1;
  /** server tick minus input counter for recently acknowledged inputs (a repeated input only inflates it, so take the min) */
  private tickOffsets: number[] = [];
  private tickOffset = 0;

  readonly pos = v3(); readonly rot = q4(); readonly vel = v3(); readonly angvel = v3();
  readonly prevPos = v3(); readonly prevRot = q4();
  private offPos = v3();
  private offRot = q4();
  corrections = 0;

  constructor(readonly arena: ArenaData) {
    this.world = createWorld();
    addArenaColliders(this.world, arena);
    this.movers = addMovers(this.world, arena, 0);
    this.world.step();
  }

  get active(): boolean { return this.body !== null; }
  get flight(): FlightState { return this.st.flight; }
  get energy(): number { return this.st.energy; }
  get safe(): boolean { return this.st.safe; }
  get safeCharge(): number { return this.st.safeCharge; }

  /** (Re)create the predicted body from an authoritative owner snapshot. */
  private respawn(o: OwnerSnap): void {
    if (this.body) this.world.removeRigidBody(this.body);
    this.def = classByIndex(o.cls);
    this.body = createShipBody(this.world, this.def, o.pos, o.rot);
    this.gen = o.gen;
    this.history.clear();
    this.setFromSnap(o, 0);
    this.copyPose(this.prevPos, this.prevRot);
    this.offPos.x = this.offPos.y = this.offPos.z = 0;
    this.offRot.x = this.offRot.y = this.offRot.z = 0; this.offRot.w = 1;
  }

  private setFromSnap(o: OwnerSnap, snapTick: number): void {
    const b = this.body!;
    b.setTranslation(o.pos, true); b.setRotation(o.rot, true); b.setLinvel(o.vel, true); b.setAngvel(o.angvel, true);
    this.readBody();
    copyFlightState(this.st.flight, o.flight);
    this.st.energy = o.energy;
    this.st.abilityActive = o.abilityActive;
    this.st.abilityCooldown = o.abilityCooldown;
    this.st.muzzleIndex = o.muzzleIndex;
    if (snapTick) this.st.sinceFire = Math.max(0, snapTick - o.primaryLastFire);
    this.st.safeCharge = o.safeCharge;
    this.st.safe = o.safeCharge > 0 && safeZoneAt(this.arena, o.pos) !== null;
    this.power = o.power;
  }

  kill(): void {
    if (this.body) this.world.removeRigidBody(this.body);
    this.body = null;
    this.history.clear();
  }

  /** Mirror other ships as kinematic colliders so collisions predict reasonably. */
  syncProxies(others: { id: number; cls: number; alive: boolean; pos: V3; rot: Q4 }[]): void {
    const seen = new Set<number>();
    for (const o of others) {
      if (!o.alive || o.id === this.shipId) continue;
      seen.add(o.id);
      let p = this.proxies.get(o.id);
      if (p && p.cls !== o.cls) { this.world.removeRigidBody(p.body); p = undefined; }
      if (!p) { p = { body: createShipBody(this.world, classByIndex(o.cls), o.pos, o.rot, true), cls: o.cls }; this.proxies.set(o.id, p); }
      p.body.setNextKinematicTranslation(o.pos);
      p.body.setNextKinematicRotation(o.rot);
    }
    for (const [id, p] of this.proxies) if (!seen.has(id)) { this.world.removeRigidBody(p.body); this.proxies.delete(id); }
  }

  /**
   * Server tick that input number `n` is applied on. `cmd.tick` is re-derived from the clock every step and can
   * repeat or skip a tick, so it is only the fallback until an acknowledgement calibrates the counter.
   */
  envTickFor(cmd: InputCmd, n: number): number {
    return this.tickOffsets.length ? n + this.tickOffset : cmd.tick;
  }

  /** Forget the calibration; a new connection gets a fresh server-side input buffer. */
  resetEnvClock(): void { this.tickOffsets = []; }

  /** Advance one predicted tick for input number `n`. Returns a volley if the primary fired. */
  step(cmd: InputCmd, n: number, record = true): PredictedVolley | null {
    if (!this.body || !this.def) return null;
    this.copyPose(this.prevPos, this.prevRot);
    const volley = this.handleInput(cmd);
    applyFlightControl(this.body, cmd, this.def, this.st.flight, DT, { noBoostDrain: this.overdrive() });
    this.driveEnv(this.envTickFor(cmd, n));
    this.world.step();
    this.readBody();
    this.tickTimers();
    if (record) {
      this.history.set(cmd.seq, {
        cmd: { ...cmd }, n, pos: { ...this.pos }, rot: { ...this.rot }, vel: { ...this.vel }, angvel: { ...this.angvel }, st: cloneSt(this.st),
      });
      this.history.delete((cmd.seq - PREDICTION_HISTORY) & 0xffff);
      this.lastSeq = cmd.seq;
    }
    return volley;
  }

  private overdrive(): boolean { return this.def?.ability.id === 'overdrive' && this.st.abilityActive > 0; }

  /** Movers are posed by tick; replays and clock adjustments jump the tick, so those teleport instead of sweeping. */
  private driveEnv(tick: number): void {
    if (!this.movers.length) return;
    if (tick !== this.moverTick + 1) placeMovers(this.movers, tick - 1);
    driveMovers(this.movers, tick);
    this.moverTick = tick;
  }

  private handleInput(cmd: InputCmd): PredictedVolley | null {
    const def = this.def!, st = this.st;
    const f = cmd.flags;
    const pressed = (b: number) => (f & b) !== 0 && (st.prevFlags & b) === 0;
    st.prevFlags = f;
    const tier = resolveTier(def, this.power);
    const armed = this.weaponsEnabled && !st.safe;
    if (armed && def.ability.id === 'overdrive' && pressed(InputFlag.Ability) && st.abilityCooldown <= 0 && st.abilityActive <= 0) {
      st.abilityActive = def.ability.duration;
      st.abilityCooldown = def.ability.cooldown * tier.abilityCooldown;
    }
    if (!armed || !(f & InputFlag.Primary)) return null;
    const w = activePrimary(def, tier);
    const cad = tier.cadence * (this.overdrive() ? OVERDRIVE_CADENCE : 1);
    if (st.sinceFire < cadenceTicks(w, cad) || st.energy < w.energy) return null;
    st.energy -= w.energy;
    st.sinceFire = 0;
    const shotId = shotIdFor(this.shipId, cmd.seq, 0);
    const shots = volleyShots(def, w, projectileCount(w, def, tier), this.pos, this.rot, st.muzzleIndex, shotId);
    if (w.seekConeDeg) {
      const candidates = Array.from(this.proxies.values(), (p) => { const t = p.body.translation(); return v3(t.x, t.y, t.z); });
      applyPrimarySeek(this.world, w, shots, candidates);
    }
    if (w.muzzle === 'alternate') st.muzzleIndex++;
    return { shotId, weapon: w, shots };
  }

  private tickTimers(): void {
    const st = this.st, def = this.def!;
    st.sinceFire++;
    st.abilityCooldown = Math.max(0, st.abilityCooldown - DT);
    st.abilityActive = Math.max(0, st.abilityActive - DT);
    st.energy = Math.min(def.energyMax, st.energy + def.energyRegen * DT);
    const inZone = safeZoneAt(this.arena, this.pos) !== null;
    st.safeCharge = stepSafeCharge(st.safeCharge, inZone);
    st.safe = inZone && st.safeCharge > 0;
  }

  /**
   * Reconcile with the server's authoritative state for `o.lastSeq`.
   * `pending` are inputs sent after lastSeq, in order.
   */
  reconcile(o: OwnerSnap, snapTick: number): void {
    if (!this.body || o.gen !== this.gen || classByIndex(o.cls) !== this.def) {
      this.respawn(o);
      this.st.sinceFire = Math.max(0, snapTick - o.primaryLastFire);
      this.lastSeq = o.lastSeq;
      return;
    }
    this.power = o.power;
    const h = this.history.get(o.lastSeq);
    if (h) {
      this.tickOffsets.push(snapTick - h.n);
      if (this.tickOffsets.length > 15) this.tickOffsets.shift();
      this.tickOffset = Math.min(...this.tickOffsets);
    }
    // drop acknowledged history
    for (const k of this.history.keys()) if (((o.lastSeq - k) & 0xffff) < 0x8000 && k !== o.lastSeq) this.history.delete(k);
    if (h) {
      const dp = Math.hypot(h.pos.x - o.pos.x, h.pos.y - o.pos.y, h.pos.z - o.pos.z);
      const dv = Math.hypot(h.vel.x - o.vel.x, h.vel.y - o.vel.y, h.vel.z - o.vel.z);
      const dr = qangle(h.rot, o.rot);
      const boostErr = Math.abs(h.st.flight.boostMeter - o.flight.boostMeter);
      if (dp < POS_TOL && dv < VEL_TOL && dr < ROT_TOL && boostErr < 0.05) {
        const de = o.energy - h.st.energy;
        if (Math.abs(de) > 0.5) this.st.energy = Math.max(0, Math.min(this.def.energyMax, this.st.energy + de));
        const da = o.abilityActive - h.st.abilityActive;
        if (Math.abs(da) > 0.1) this.st.abilityActive = Math.max(0, this.st.abilityActive + da);
        const dc = o.abilityCooldown - h.st.abilityCooldown;
        if (Math.abs(dc) > 0.1) this.st.abilityCooldown = Math.max(0, this.st.abilityCooldown + dc);
        const ds = o.safeCharge - h.st.safeCharge;
        if (Math.abs(ds) > 0.25) {
          this.st.safeCharge = Math.max(0, Math.min(SAFE_ZONE_CHARGE_S, this.st.safeCharge + ds));
          this.st.safe = this.st.safeCharge > 0 && safeZoneAt(this.arena, this.pos) !== null;
        }
        return;
      }
    }
    // mismatch → rewind to server state and replay pending inputs
    const oldPos = { ...this.pos }, oldRot = { ...this.rot };
    this.setFromSnap(o, snapTick);
    const pending: HistoryEntry[] = [];
    for (let s = (o.lastSeq + 1) & 0xffff; s !== ((this.lastSeq + 1) & 0xffff); s = (s + 1) & 0xffff) {
      const e = this.history.get(s);
      if (e) pending.push(e);
      if (pending.length > PREDICTION_HISTORY) break;
    }
    if (h) this.st.prevFlags = h.cmd.flags;
    for (const e of pending) {
      this.step(e.cmd, e.n, false);
      e.pos = { ...this.pos }; e.rot = { ...this.rot }; e.vel = { ...this.vel }; e.angvel = { ...this.angvel }; e.st = cloneSt(this.st);
    }
    this.corrections++;
    // visual error offset (render = physics + offset), decays with τ
    this.offPos.x += oldPos.x - this.pos.x; this.offPos.y += oldPos.y - this.pos.y; this.offPos.z += oldPos.z - this.pos.z;
    const inv = qconj(q4(), this.rot);
    const delta = qmul(q4(), oldRot, inv);
    qnorm(this.offRot, qmul(this.offRot, delta, this.offRot));
    if (Math.hypot(this.offPos.x, this.offPos.y, this.offPos.z) > HARD_SNAP_DIST || qangle(this.offRot, IDENT) > HARD_SNAP_ANGLE) {
      this.offPos.x = this.offPos.y = this.offPos.z = 0;
      this.offRot.x = this.offRot.y = this.offRot.z = 0; this.offRot.w = 1;
    }
    this.copyPose(this.prevPos, this.prevRot);
  }

  decay(dt: number): void {
    const k = Math.exp(-dt / CORRECTION_TAU);
    this.offPos.x *= k; this.offPos.y *= k; this.offPos.z *= k;
    qslerp(this.offRot, this.offRot, IDENT, 1 - k);
  }

  /** Render pose: tick interpolation plus decaying correction offset. */
  renderPose(alpha: number, outPos: V3, outRot: Q4): void {
    outPos.x = this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha + this.offPos.x;
    outPos.y = this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha + this.offPos.y;
    outPos.z = this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha + this.offPos.z;
    qslerp(outRot, this.prevRot, this.rot, alpha);
    qnorm(outRot, qmul(outRot, this.offRot, outRot));
  }

  private readBody(): void {
    const b = this.body!;
    const t = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel();
    this.pos.x = t.x; this.pos.y = t.y; this.pos.z = t.z;
    this.rot.x = r.x; this.rot.y = r.y; this.rot.z = r.z; this.rot.w = r.w;
    this.vel.x = lv.x; this.vel.y = lv.y; this.vel.z = lv.z;
    this.angvel.x = av.x; this.angvel.y = av.y; this.angvel.z = av.z;
  }

  private copyPose(p: V3, r: Q4): void {
    p.x = this.pos.x; p.y = this.pos.y; p.z = this.pos.z;
    r.x = this.rot.x; r.y = this.rot.y; r.z = this.rot.z; r.w = this.rot.w;
  }

  dispose(): void { this.world.free(); }
}

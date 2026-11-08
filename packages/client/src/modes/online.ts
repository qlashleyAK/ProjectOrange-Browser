import {
  BUILD_VERSION, castStatic, CHECKPOINT_RADIUS, CLASS_LIST, classByIndex, DT, encodeInputPacket, encodePing, END_REASONS, INPUT_SEND_HZ,
  INPUT_BUFFER_TARGET_MAX, MAX_INPUTS_PER_PACKET, MsgType, PRIMARY_TABLE, quantizeInput, Reader, decodeSnapshot, resolveTier,
  RESPAWN_DELAY_S, RESPAWN_HOLD_MAX_S, SAFE_ZONE_CHARGE_S, safeZoneAt, ShipFlag, TIME_DILATION, activePrimary, powerupFromFlags, v3, q4,
  type ArenaData, type ClassId, type ClientMsg, type GameEvent, type GameMode, type InputCmd, type MatchPhase, type OwnerSnap, type PickupInfo,
  type PowerupInfo, type PrimaryDef, type Q4, type RAPIER, type RosterEntry, type ServerMsg, type ShipSnap, type Snapshot, type V3,
} from '@orange/shared';
import { ClockSync } from '../net/clock';
import { InterpBuffer } from '../net/interp';
import { Predictor, type PredictedVolley } from '../net/prediction';
import type { Transport } from '../net/transport';
import type { LocalState, MatchView, MissileView, NetStats, PickupView, PowerupView, ProjView, ShipView, ViewSource } from '../view';
import type { InputSampler } from './offline';

export type NetStatus = 'connecting' | 'live' | 'reconnecting' | 'lost' | 'full' | 'reload';

interface RemoteShip { buf: InterpBuffer; snap: ShipSnap; view: ShipView; missingSince: number }
interface RemoteProj { id: number; ownerId: number; weapon: PrimaryDef; pos: V3; vel: V3; spawnTick: number; endTick: number }
interface CosmeticProj {
  shotId: number; index: number; weapon: PrimaryDef; origin: V3; vel: V3; born: number; maxAge: number;
  serverId: number; confirmed: boolean; view: ProjView;
}
interface RemoteMissile { id: number; ownerId: number; kind: string; color: number; buf: InterpBuffer; spawnTick: number; life: number }

const SECONDARY_BY_ID = new Map(CLASS_LIST.map((c) => [c.secondary.id, c.secondary]));
const PING_INTERVAL = 0.5;
const RECONNECT_EVERY = 2;
const RECONNECT_GIVE_UP = 20;

export interface OnlineOptions {
  makeTransport: () => Transport;
  /** offline worker: no reconnection, pause allowed */
  offline: boolean;
  /** persisted identity token from a previous session, sent with hello */
  token?: string;
  /** called with the (possibly new) token on welcome — persist it */
  onToken?: (token: string) => void;
  onStatus?: (s: NetStatus, detail?: string) => void;
  /** map id from the welcome → arena; without it the client stays on the arena it was built with */
  resolveArena?: (id: string) => ArenaData;
}

/** Mirrors GameSim.weaponsEnabled: weapons are live in a match (except the mine-run time trial) and while waiting. */
const weaponsLive = (phase: MatchPhase, mode: GameMode) => (phase === 'inProgress' && mode !== 'mine-run') || phase === 'waiting';

/** Networked view: predicted local ship, interpolated remote entities, delayed positional events. */
export class OnlineSource implements ViewSource {
  readonly online: boolean;
  private transport: Transport;
  private clock = new ClockSync();
  private predictor: Predictor;
  status: NetStatus = 'connecting';
  roomId = '';
  shipId = -1;
  private token = '';
  private welcomed = false;
  private disposed = false;
  private lostAt = 0;
  private retryAt = 0;

  private seq = 0;
  private acc = 0;
  private alpha = 0;
  private sendAcc = 0;
  private pingAcc = 0;
  private pingsSent = 0;
  private pending: InputCmd[] = [];
  private bufferDepth = 0;
  /** server input-buffer depth over the last ~0.5 s of snapshots */
  private depthWindow: number[] = [];
  private dilation = 0;
  private lastSnapTick = 0;
  private bwIn = 0; private bwOut = 0; private bwT = 0; private bwInLast = 0; private bwOutLast = 0;
  private corrRate = 0; private corrLast = 0;

  private remotes = new Map<number, RemoteShip>();
  private remoteProj = new Map<number, RemoteProj>();
  private cosmetic: CosmeticProj[] = [];
  private missilesById = new Map<number, RemoteMissile>();
  private pickupMap = new Map<number, PickupInfo>();
  private powerupState: PowerupInfo = { live: null, next: null };
  private rosterList: RosterEntry[] = [];
  /** mine-run: last checkpoint index claimed this match (-1 = none); claims are one-shot per ring */
  private cpClaimed = -1;
  private matchState = { phase: 'waiting' as MatchPhase, phaseEndTick: 0, winnerId: -1, startTick: 0 };
  private nextArena: string | null = null;
  private mode: GameMode = 'ffa';
  private wave = 0;
  private course: V3[] = [];
  private owner: OwnerSnap | null = null;
  private ownerTick = 0;
  private deathTick = -1;
  private killerId = -1;
  private holdSpawn = false;
  private pendingClass: ClassId;
  private queued: { tick: number; e: GameEvent }[] = [];
  private out: GameEvent[] = [];
  private localView: ShipView;
  private timeBase = performance.now() / 1000;
  private inputN = 0;
  private envBase = 0;

  constructor(
    public arena: ArenaData, private input: InputSampler, private name: string, cls: ClassId, private opts: OnlineOptions,
  ) {
    this.online = !opts.offline;
    this.pendingClass = cls;
    this.token = opts.token ?? '';
    this.predictor = new Predictor(arena);
    this.localView = this.blankView(-1, true);
    this.transport = this.open();
  }

  get world(): RAPIER.World { return this.predictor.world; }

  private switchArena(id: string): void {
    if (id === this.arena.blueprint.id || !this.opts.resolveArena) return;
    const a = this.opts.resolveArena(id);
    if (a.blueprint.id === this.arena.blueprint.id) return;
    const weapons = this.predictor.weaponsEnabled;
    this.predictor.dispose();
    this.predictor = new Predictor(a);
    this.predictor.weaponsEnabled = weapons;
    this.predictor.shipId = this.shipId;
    this.arena = a;
    this.owner = null;
    this.cosmetic = [];
    // between matches (rotation), everything still tracked belongs to the old map
    this.remotes.clear();
    this.remoteProj.clear();
    this.missilesById.clear();
    this.pickupMap.clear();
    this.powerupState = { live: null, next: null };
    this.queued = [];
  }

  // ------------------------------------------------------------------ connection
  private open(): Transport {
    const t = this.opts.makeTransport();
    t.onopen = () => this.sendJson({ t: 'hello', name: this.name, classId: this.pendingClass, version: BUILD_VERSION, token: this.token || undefined });
    t.onmessage = (d) => this.onMessage(d);
    t.onclose = (reason) => this.onClose(reason);
    return t;
  }

  private setStatus(s: NetStatus, detail?: string): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }

  private onClose(reason: string): void {
    if (this.disposed || this.status === 'full' || this.status === 'reload') return;
    if (this.opts.offline || !this.welcomed) { this.setStatus('lost', reason); return; }
    if (this.status !== 'reconnecting') { this.lostAt = this.clock.now(); this.setStatus('reconnecting', reason); }
    this.retryAt = this.clock.now() + RECONNECT_EVERY;
  }

  private sendJson(m: ClientMsg | { t: 'pause'; on: boolean }): void { this.transport.send(JSON.stringify(m)); }

  private onMessage(d: ArrayBuffer | string): void {
    if (typeof d === 'string') { this.onJson(JSON.parse(d) as ServerMsg); return; }
    const r = new Reader(new Uint8Array(d));
    const type = r.u8();
    if (type === MsgType.Snapshot) this.onSnapshot(decodeSnapshot(r));
    else if (type === MsgType.Pong) this.clock.onPong(r.f64(), r.u32(), r.f32());
  }

  private onJson(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        if (m.arena) this.switchArena(m.arena);
        this.welcomed = true;
        this.shipId = m.shipId;
        this.predictor.shipId = m.shipId;
        this.predictor.resetEnvClock();
        this.token = m.token;
        this.opts.onToken?.(m.token);
        this.roomId = m.roomId;
        this.clock.seed(m.tick);
        this.pingsSent = 0;
        this.setStatus('live');
        break;
      case 'reload': this.setStatus('reload', m.version); break;
      case 'full': this.setStatus('full'); break;
      case 'roster':
        this.rosterList = m.players;
        { const me = this.rosterList.find((e) => e.id === this.shipId); if (me && me.checkpoint > this.cpClaimed) this.cpClaimed = me.checkpoint; }
        break;
      case 'match': {
        if (m.arena) this.switchArena(m.arena);
        this.nextArena = m.nextArena ?? null;
        if (m.phase === 'inProgress' && this.matchState.phase !== 'inProgress') this.matchState.startTick = m.tick;
        this.matchState.phase = m.phase; this.matchState.phaseEndTick = m.phaseEndTick; this.matchState.winnerId = m.winnerId;
        this.mode = m.mode ?? 'ffa'; this.wave = m.wave ?? 0; this.course = m.course ?? [];
        this.predictor.weaponsEnabled = weaponsLive(m.phase, this.mode);
        break;
      }
      case 'pickups':
        this.pickupMap.clear();
        for (const p of m.list) this.pickupMap.set(p.id, p);
        if (m.powerup) this.powerupState = m.powerup;
        break;
      case 'ev':
        for (const e of m.list) {
          // the missile has to exist before its snapshots arrive; the launch effect waits for render time
          if (e.t === 'missileSpawn') this.ensureMissile(e, m.tick);
          if (this.isImmediate(e)) this.release(e, m.tick);
          else this.queued.push({ tick: m.tick, e });
        }
        break;
      case 'vanish': {
        const r = this.remotes.get(m.shipId);
        if (r) r.missingSince = this.lastSnapTick;
        break;
      }
    }
  }

  private isImmediate(e: GameEvent): boolean {
    const me = this.shipId;
    switch (e.t) {
      case 'hit': return e.targetId === me || e.attackerId === me;
      case 'death': return e.victimId === me || e.killerId === me;
      case 'pickupTake': case 'powerupTake': case 'powerupEnd': return e.shipId === me;
      case 'tier': case 'ability': case 'dodge': case 'repel': case 'sweep': case 'bulwarkHit': case 'spawn': case 'scrape':
        return e.shipId === me;
      case 'lockOn': return e.targetId === me || e.shipId === me;
      case 'phase': case 'matchEnd': return true;
      default: return false;
    }
  }

  /** Apply an event to local state and hand it to the presentation layer. */
  private release(e: GameEvent, tick: number): void {
    switch (e.t) {
      case 'death':
        if (e.victimId === this.shipId) { this.killerId = e.killerId; this.deathTick = tick; this.predictor.kill(); this.owner = null; }
        break;
      case 'spawn':
        if (e.shipId === this.shipId) this.deathTick = -1;
        break;
      case 'missileSpawn': this.ensureMissile(e, tick); break;
      case 'missileEnd': this.missilesById.delete(e.id); break;
      case 'pickupSpawn':
        this.pickupMap.set(e.id, { id: e.id, pos: e.pos, units: e.units, drop: e.drop, expireTick: e.expireTick, killerId: e.killerId });
        break;
      case 'pickupTake': case 'pickupExpire': this.pickupMap.delete(e.id); break;
      case 'powerupSpawn': this.powerupState = { live: { id: e.id, kind: e.kind, pos: e.pos }, next: null }; break;
      case 'powerupTake': this.powerupState = { live: null, next: { tick: e.nextTick, pos: e.nextPos } }; break;
      case 'powerupClear': this.powerupState = { live: null, next: null }; break;
      case 'phase':
        if (e.phase === 'inProgress') this.matchState.startTick = tick;
        this.matchState.phase = e.phase;
        this.predictor.weaponsEnabled = weaponsLive(e.phase, this.mode);
        break;
      case 'matchEnd': this.matchState.winnerId = e.winnerId; break;
      case 'wave': this.wave = e.wave; break;
    }
    this.out.push(e);
  }

  private onSnapshot(s: Snapshot): void {
    this.clock.onSnapshot(s.tick);
    this.bufferDepth = s.bufferDepth;
    this.depthWindow.push(s.bufferDepth);
    if (this.depthWindow.length > 15) this.depthWindow.shift();
    if (s.tick <= this.lastSnapTick && this.lastSnapTick - s.tick < 1e6) return;
    this.lastSnapTick = s.tick;

    const seen = new Set<number>();
    for (const sh of s.ships) {
      if (sh.id === this.shipId) continue;
      seen.add(sh.id);
      let r = this.remotes.get(sh.id);
      if (!r) { r = { buf: new InterpBuffer(), snap: sh, view: this.blankView(sh.id, false), missingSince: -1 }; this.remotes.set(sh.id, r); }
      if (r.missingSince >= 0) { r.buf = new InterpBuffer(); r.missingSince = -1; }
      r.snap = sh;
      r.buf.push({ tick: s.tick, pos: sh.pos, rot: sh.rot, vel: sh.vel }, sh.gen);
    }
    for (const [id, r] of this.remotes) if (!seen.has(id) && r.missingSince < 0) r.missingSince = s.tick;

    if (s.owner && !(this.deathTick >= 0 && s.tick <= this.deathTick)) {
      this.owner = s.owner;
      this.ownerTick = s.tick;
      this.deathTick = -1;
      this.predictor.reconcile(s.owner, s.tick);
    } else if (this.predictor.active) {
      this.predictor.kill();
      if (this.deathTick < 0) this.deathTick = s.tick;
    }

    if (s.missiles) {
      for (const m of s.missiles) {
        const rm = this.missilesById.get(m.id);
        if (rm) rm.buf.push({ tick: s.tick, pos: m.pos, rot: q4(), vel: m.vel }, 0);
      }
    }

    for (const p of s.projSpawns) {
      const weapon = PRIMARY_TABLE[p.weapon]!;
      if (p.owner === this.shipId) {
        const c = this.cosmetic.find((c) => !c.confirmed && c.shotId === p.shotId && c.index === p.index);
        if (c) { c.confirmed = true; c.serverId = p.id; continue; }
      }
      this.remoteProj.set(p.id, { id: p.id, ownerId: p.owner, weapon, pos: p.pos, vel: p.vel, spawnTick: p.spawnTick, endTick: -1 });
      if (p.index === 0 && p.owner !== this.shipId) {
        const len = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
        this.queued.push({ tick: p.spawnTick, e: { t: 'shot', ownerId: p.owner, weapon: weapon.id, shotId: p.shotId, pos: p.pos, dir: v3(p.vel.x / len, p.vel.y / len, p.vel.z / len) } });
      }
    }
    for (const p of s.projEnds) {
      const ev: GameEvent = { t: 'projEnd', id: p.id, reason: END_REASONS[p.reason] ?? 'expire', pos: p.pos };
      const ci = this.cosmetic.findIndex((c) => c.serverId === p.id);
      if (ci >= 0) { this.cosmetic.splice(ci, 1); this.out.push(ev); continue; }
      const rp = this.remoteProj.get(p.id);
      if (rp) rp.endTick = s.tick;
      this.queued.push({ tick: s.tick, e: ev });
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt: number): void {
    if (this.disposed) return;
    const now = this.clock.now();
    if (this.status === 'reconnecting') {
      if (now - this.lostAt > RECONNECT_GIVE_UP) { this.setStatus('lost', 'connection lost'); return; }
      if (now >= this.retryAt) { this.retryAt = now + RECONNECT_EVERY; this.transport.close(); this.transport = this.open(); }
    }
    if (!this.welcomed || this.paused) return;
    this.trackBandwidth(dt);

    const serverNow = this.clock.serverTick();
    const interp = this.clock.interpDelay();
    const renderTick = serverNow - interp / DT;

    // time dilation keeps the server's input buffer shallow but non-empty
    const target = this.dilation;
    // inputs arrive in 30 Hz bursts, so judge the buffer by its trough: never empty, but not padded either
    const trough = this.depthWindow.length ? Math.min(...this.depthWindow) : 1;
    const want = trough < 1 ? TIME_DILATION : trough > 1 || this.bufferDepth > INPUT_BUFFER_TARGET_MAX ? -TIME_DILATION : 0;
    this.dilation = target + (want - target) * Math.min(1, dt * 4);

    this.acc = Math.min(0.25, this.acc + dt * (1 + this.dilation));
    const ticks = Math.floor(this.acc / DT);
    if (ticks) this.syncProxies(serverNow);
    this.input.beginFrame(ticks);
    for (let i = 0; i < ticks; i++) {
      this.seq = (this.seq + 1) & 0xffff;
      const cmd = { ...this.input.sample(Math.round(serverNow) + i) };
      cmd.seq = this.seq;
      cmd.tick = Math.round(serverNow + (this.clock.rtt / 2) / DT) + i;
      quantizeInput(cmd);
      this.pending.push(cmd);
      this.inputN++;
      this.envBase = this.predictor.envTickFor(cmd, this.inputN);
      if (this.predictor.active) {
        const v = this.predictor.step(cmd, this.inputN);
        if (v) this.spawnCosmetic(v);
      }
      this.acc -= DT;
    }
    this.alpha = Math.min(1, this.acc / DT);
    this.predictor.decay(dt);

    // mine-run: ring pass seen from OUR predicted position — the server may
    // have replayed a different line at this ping, so tell it what we saw
    // (it validates proximity before accepting; claims are one-shot per ring)
    if (this.mode === 'mine-run' && this.course.length) {
      const me = this.rosterList.find((e) => e.id === this.shipId);
      if (me && me.checkpoint < this.course.length && me.checkpoint !== this.cpClaimed) {
        const cp = this.course[me.checkpoint]!;
        const p = this.predictor.pos;
        if ((p.x - cp.x) ** 2 + (p.y - cp.y) ** 2 + (p.z - cp.z) ** 2 <= CHECKPOINT_RADIUS * CHECKPOINT_RADIUS) {
          this.cpClaimed = me.checkpoint;
          this.sendJson({ t: 'cp', index: me.checkpoint });
        }
      }
    }

    this.sendAcc += dt;
    if (this.sendAcc >= 1 / INPUT_SEND_HZ || this.pending.length >= MAX_INPUTS_PER_PACKET) {
      this.sendAcc = 0;
      while (this.pending.length) this.transport.send(encodeInputPacket(this.pending.splice(0, MAX_INPUTS_PER_PACKET)));
    }

    this.pingAcc += dt;
    const pingEvery = this.pingsSent < 8 ? 0.1 : PING_INTERVAL;
    if (this.pingAcc >= pingEvery) {
      this.pingAcc = 0; this.pingsSent++;
      this.transport.send(encodePing(performance.now(), interp, this.clock.rtt));
    }

    // release delayed events in tick order
    if (this.queued.length) {
      this.queued.sort((a, b) => a.tick - b.tick);
      let n = 0;
      while (n < this.queued.length && this.queued[n]!.tick <= renderTick) n++;
      // never let the queue hold events for more than a second
      while (n < this.queued.length && this.queued[n]!.tick < serverNow - 60) n++;
      for (const q of this.queued.splice(0, n)) this.release(q.e, q.tick);
    }

    this.updateRemotes(renderTick);
    this.updateCosmetic(now);
    const c = this.predictor.corrections;
    this.corrRate += ((c - this.corrLast) / Math.max(dt, 1e-3) - this.corrRate) * Math.min(1, dt * 2);
    this.corrLast = c;
    this.renderTick = renderTick;
    this.serverNow = serverNow;
  }

  private renderTick = 0;
  private serverNow = 0;

  private syncProxies(serverNow: number): void {
    const list: { id: number; cls: number; alive: boolean; pos: V3; rot: Q4 }[] = [];
    for (const [id, r] of this.remotes) {
      const l = r.buf.latest;
      if (!l || r.missingSince >= 0) continue;
      const ahead = Math.min(0.3, Math.max(0, (serverNow - l.tick) * DT + this.clock.rtt / 2));
      list.push({ id, cls: r.snap.cls, alive: true, pos: v3(l.pos.x + l.vel.x * ahead, l.pos.y + l.vel.y * ahead, l.pos.z + l.vel.z * ahead), rot: l.rot });
    }
    this.predictor.syncProxies(list);
  }

  private spawnCosmetic(v: PredictedVolley): void {
    const t = this.clock.now();
    v.shots.forEach((sh, i) => {
      const vel = v3(sh.dir.x * v.weapon.speed, sh.dir.y * v.weapon.speed, sh.dir.z * v.weapon.speed);
      const range = v.weapon.speed * v.weapon.life;
      const hit = castStatic(this.world, sh.origin, sh.dir, range);
      const maxAge = hit < 0 ? v.weapon.life : hit / v.weapon.speed;
      this.cosmetic.push({
        shotId: v.shotId, index: i, weapon: v.weapon, origin: sh.origin, vel, born: t, maxAge, serverId: -1, confirmed: false,
        view: { id: -1 - (this.cosmetic.length + i), ownerId: this.shipId, weapon: v.weapon, pos: { ...sh.origin }, vel, age: 0 },
      });
    });
    this.out.push({ t: 'shot', ownerId: this.shipId, weapon: v.weapon.id, shotId: v.shotId, pos: v.shots[0]!.origin, dir: v.shots[0]!.dir });
  }

  private updateCosmetic(now: number): void {
    const timeout = this.clock.rtt + 0.35;
    this.cosmetic = this.cosmetic.filter((c) => {
      const age = now - c.born;
      if (age > c.weapon.life + 0.1) return false;
      if (!c.confirmed && age > timeout) return false;
      return true;
    });
  }

  private updateRemotes(renderTick: number): void {
    for (const [id, r] of this.remotes) {
      const v = r.view;
      const visible = r.missingSince < 0 || renderTick < r.missingSince;
      const ok = visible && r.buf.sample(renderTick, v.pos, v.rot, v.vel);
      v.alive = ok;
      if (!ok && r.missingSince >= 0 && renderTick - r.missingSince > 600) this.remotes.delete(id);
      const sh = r.snap;
      const def = classByIndex(sh.cls);
      const ro = this.rosterList.find((e) => e.id === id);
      v.name = ro?.name ?? `Pilot ${id}`; v.isBot = ro?.isBot ?? false; v.accent = ro?.accent ?? id % 10;
      v.classId = def.id; v.gen = sh.gen;
      v.hullFrac = sh.hull; v.shieldFrac = sh.shield; v.power = sh.power; v.tierIndex = resolveTier(def, sh.power).index;
      v.cloaked = false;
      v.shimmer = (sh.flags & (ShipFlag.Cloaked | ShipFlag.Shimmer)) !== 0;
      v.bulwark = (sh.flags & ShipFlag.Bulwark) !== 0;
      v.overdrive = (sh.flags & ShipFlag.Overdrive) !== 0;
      v.spawnProtected = (sh.flags & ShipFlag.SpawnProtected) !== 0;
      v.safe = (sh.flags & ShipFlag.Safe) !== 0;
      v.boosting = (sh.flags & ShipFlag.Boosting) !== 0;
      v.powerup = powerupFromFlags(sh.flags);
    }
  }

  private trackBandwidth(dt: number): void {
    this.bwT += dt;
    if (this.bwT >= 1) {
      this.bwIn = (this.transport.bytesIn - this.bwInLast) / this.bwT;
      this.bwOut = (this.transport.bytesOut - this.bwOutLast) / this.bwT;
      this.bwInLast = this.transport.bytesIn; this.bwOutLast = this.transport.bytesOut; this.bwT = 0;
    }
  }

  private blankView(id: number, isLocal: boolean): ShipView {
    return {
      id, name: '', isBot: false, classId: 'dart', accent: 0, alive: false, gen: 0, pos: v3(), rot: q4(), vel: v3(),
      hullFrac: 1, shieldFrac: 1, power: 0, tierIndex: -1, cloaked: false, shimmer: false, bulwark: false, overdrive: false,
      spawnProtected: false, safe: false, boosting: false, isLocal, powerup: null,
    };
  }

  // ------------------------------------------------------------------ ViewSource
  ships(): ShipView[] {
    const out: ShipView[] = [];
    for (const r of this.remotes.values()) if (r.view.alive) out.push(r.view);
    const o = this.owner;
    if (o && this.predictor.active && this.predictor.def) {
      const v = this.localView;
      const ro = this.rosterList.find((e) => e.id === this.shipId);
      v.id = this.shipId; v.alive = true; v.gen = o.gen; v.classId = this.predictor.def.id;
      v.name = ro?.name ?? this.name; v.accent = ro?.accent ?? 0;
      this.predictor.renderPose(this.alpha, v.pos, v.rot);
      v.vel.x = this.predictor.vel.x; v.vel.y = this.predictor.vel.y; v.vel.z = this.predictor.vel.z;
      v.hullFrac = o.hull / this.predictor.def.hull; v.shieldFrac = o.maxShield > 0 ? o.shield / o.maxShield : 0;
      v.power = o.power; v.tierIndex = resolveTier(this.predictor.def, o.power).index;
      v.shimmer = o.cloaked; v.cloaked = false;
      v.bulwark = o.bulwarkHp > 0 && o.abilityActive > 0 && this.predictor.def.ability.id === 'bulwark';
      v.overdrive = o.abilityActive > 0 && this.predictor.def.ability.id === 'overdrive';
      v.spawnProtected = this.ownerTick < o.spawnProtectedUntil;
      v.safe = this.predictor.safe;
      v.boosting = this.predictor.flight.boosting;
      v.powerup = this.predictor.powerup;
      out.push(v);
    }
    return out;
  }

  local(): LocalState | null {
    if (this.shipId < 0) return null;
    const ro = this.rosterList.find((e) => e.id === this.shipId);
    const o = this.owner;
    const alive = !!o && this.predictor.active;
    const def = alive ? this.predictor.def! : classByIndex(o?.cls ?? CLASS_LIST.findIndex((c) => c.id === (ro?.classId ?? this.pendingClass)));
    const power = o?.power ?? 0;
    const tier = resolveTier(def, alive ? power : 0);
    const dead = this.deathTick >= 0 ? this.deathTick : this.serverNow;
    const fl = this.predictor.flight;
    return {
      shipId: this.shipId, alive, def, pendingClass: this.pendingClass,
      hull: o?.hull ?? def.hull, shield: o?.shield ?? def.shield, maxShield: o?.maxShield ?? def.shield,
      energy: alive ? this.predictor.energy : def.energyMax, ammo: o?.ammo ?? def.secondary.ammo,
      abilityCooldown: o?.abilityCooldown ?? 0, abilityActive: o?.abilityActive ?? 0, repelCooldown: o?.repelCooldown ?? 0,
      power: alive ? power : 0, tier, boostMeter: fl.boostMeter, boostLocked: fl.boostLocked, dodgeCooldown: fl.dodgeCooldown,
      lockTarget: o?.lockTarget ?? -1, lockProgress: o?.lockProgress ?? 0, locked: o?.locked ?? false,
      lockWarn: o?.lockWarn ?? 0, missileWarn: o?.missileWarn ?? 0,
      spawnProtected: !!o && this.ownerTick < o.spawnProtectedUntil,
      safe: alive && this.predictor.safe, safeCharge: alive ? this.predictor.safeCharge : SAFE_ZONE_CHARGE_S,
      inSafeZone: alive && safeZoneAt(this.arena, this.predictor.pos) !== null,
      cloaked: o?.cloaked ?? false, bulwarkHp: o?.bulwarkHp ?? 0,
      respawnIn: alive ? 0 : Math.max(0, (dead + RESPAWN_DELAY_S / DT - this.serverNow) * DT),
      holdSpawn: this.holdSpawn,
      holdLeft: alive ? 0 : Math.max(0, (dead + RESPAWN_HOLD_MAX_S / DT - this.serverNow) * DT),
      killerId: this.killerId, primary: activePrimary(def, tier), secondary: def.secondary,
      powerup: alive ? this.predictor.powerup : null, powerupLeft: alive ? this.predictor.powerupLeft : 0,
    };
  }

  projectiles(): ProjView[] {
    const out: ProjView[] = [];
    const rt = this.renderTick;
    for (const [id, p] of this.remoteProj) {
      if (p.endTick >= 0 && rt >= p.endTick) { this.remoteProj.delete(id); continue; }
      const age = (rt - p.spawnTick) * DT;
      if (age > p.weapon.life + 0.5) { this.remoteProj.delete(id); continue; }
      if (age < 0) continue;
      out.push({ id, ownerId: p.ownerId, weapon: p.weapon, pos: v3(p.pos.x + p.vel.x * age, p.pos.y + p.vel.y * age, p.pos.z + p.vel.z * age), vel: p.vel, age });
    }
    const now = this.clock.now();
    for (const c of this.cosmetic) {
      const age = now - c.born;
      if (age > c.maxAge) continue;
      const v = c.view;
      v.pos.x = c.origin.x + c.vel.x * age; v.pos.y = c.origin.y + c.vel.y * age; v.pos.z = c.origin.z + c.vel.z * age;
      v.age = age;
      out.push(v);
    }
    return out;
  }

  /** Create the interpolation entry once. Later releases of the same launch must not rewind it. */
  private ensureMissile(e: Extract<GameEvent, { t: 'missileSpawn' }>, tick: number): void {
    if (this.missilesById.has(e.id)) return;
    const sec = SECONDARY_BY_ID.get(e.kind);
    const buf = new InterpBuffer();
    buf.push({ tick, pos: { ...e.pos }, rot: q4(), vel: { ...e.vel } }, 0);
    this.missilesById.set(e.id, {
      id: e.id, ownerId: e.ownerId, kind: sec?.kind ?? 'missile', color: sec?.color ?? 0xffffff,
      buf, spawnTick: tick, life: sec?.life ?? 5,
    });
  }

  missiles(): MissileView[] {
    const out: MissileView[] = [];
    const rt = this.renderTick;
    for (const [id, m] of this.missilesById) {
      // a missed end event must not leave a smoker parked in the arena
      if ((rt - m.spawnTick) * DT > m.life + 0.75) { this.missilesById.delete(id); continue; }
      if (rt < m.spawnTick) continue;
      const pos = v3(), vel = v3();
      if (!m.buf.sample(rt, pos, q4(), vel)) continue;
      out.push({ id: m.id, ownerId: m.ownerId, kind: m.kind, color: m.color, pos, vel });
    }
    return out;
  }

  pickups(): PickupView[] {
    const out: PickupView[] = [];
    for (const p of this.pickupMap.values()) {
      out.push({ id: p.id, pos: p.pos, units: p.units, drop: p.drop, expireIn: (p.expireTick - this.serverNow) * DT, killerId: p.killerId });
    }
    return out;
  }

  powerup(): PowerupView {
    const { live, next } = this.powerupState;
    return { live, next: next ? { pos: next.pos, in: Math.max(0, (next.tick - this.serverNow) * DT) } : null };
  }

  roster(): RosterEntry[] { return this.rosterList; }

  match(): MatchView {
    const m = this.matchState;
    return {
      phase: m.phase, timeLeft: Math.max(0, (m.phaseEndTick - this.serverNow) * DT), winnerId: m.winnerId,
      elapsed: m.phase === 'inProgress' ? Math.max(0, (this.serverNow - m.startTick) * DT) : 0,
      nextArena: this.nextArena, mode: this.mode, wave: this.wave, course: this.course,
    };
  }

  drainEvents(): GameEvent[] { const e = this.out; this.out = []; return e; }
  time(): number { return performance.now() / 1000 - this.timeBase; }
  envTick(): number { return this.inputN > 0 ? this.envBase - 1 + this.alpha : this.serverNow; }
  setClass(c: ClassId): void { this.pendingClass = c; this.sendJson({ t: 'class', classId: c }); }
  setHold(hold: boolean): void { this.holdSpawn = hold; this.sendJson({ t: 'hold', hold }); }
  setPaused(p: boolean): void {
    if (!this.opts.offline || p === this.paused) return;
    this.paused = p;
    this.sendJson({ t: 'pause', on: p });
    if (p) this.pausedAt = this.clock.now();
    else this.clock.shift(-(this.clock.now() - this.pausedAt) / DT);
  }
  private paused = false;
  private pausedAt = 0;

  netStats(): NetStats {
    return {
      ping: Math.round(this.clock.rtt * 1000), loss: this.clock.loss, jitter: this.clock.jitter * 1000,
      interpDelay: this.clock.interpDelay() * 1000, snapshotAge: this.clock.snapshotAge() * 1000, corrections: this.corrRate,
      bufferDepth: this.bufferDepth, serverTick: Math.round(this.serverNow), bandwidthIn: this.bwIn, bandwidthOut: this.bwOut,
    };
  }

  warning(): string | null {
    switch (this.status) {
      case 'connecting': return 'Connecting…';
      case 'reconnecting': return `Connection lost — reconnecting (${Math.max(0, Math.ceil(RECONNECT_GIVE_UP - (this.clock.now() - this.lostAt)))}s)`;
      case 'lost': return 'Disconnected';
      case 'full': return 'Room is full';
      case 'reload': return 'New version available — reloading';
    }
    if (this.paused) return null;
    if (this.welcomed && this.clock.snapshotAge() > 0.5) return 'Network stall…';
    if (this.clock.loss > 0.05) return `Packet loss ${(this.clock.loss * 100).toFixed(0)}%`;
    return null;
  }

  dispose(): void {
    this.disposed = true;
    this.transport.close();
    this.predictor.dispose();
  }
}

import { arenaById, DEFAULT_ARENA, nextInRotation } from '../arena/registry.js';
import { CLASS_IDS, type ClassId } from '../classes/index.js';
import {
  BOT_BACKFILL_TARGET, BUILD_VERSION, DT, LAG_COMP_MAX_TICKS, MAX_INPUTS_PER_SECOND, MAX_PARTICIPANTS,
  MISSED_INPUT_REPEAT_LIMIT, MISSILE_STREAM_EVERY_SNAPSHOTS, RECONNECT_GRACE_S, SNAPSHOT_EVERY_TICKS,
} from '../constants.js';
import { cloakVisible } from '../bots/perception.js';
import type { BotSkill } from '../bots/brain.js';
import type { GameEvent, Ship } from '../entities.js';
import { GameSim } from '../game.js';
import { InputFlag, neutralInput, seqDiff, type InputCmd } from '../input.js';
import {
  decodeInputPacket, encodePong, encodeSnapshot, END_REASONS, MsgType, primaryIndex, Reader, ShipFlag, Writer,
  type OwnerSnap, type ProjEndSnap, type ProjSpawnSnap, type ShipSnap,
} from '../net/codec.js';
import type { ClientMsg, PickupInfo, RosterEntry, ServerMsg } from '../net/messages.js';
import { powerupFlags, powerupIndex, powerupInfo, powerupLeft } from '../powerups.js';
import { buildMatchReport, type MatchSink } from '../report.js';
import { hash32 } from '../rng.js';

/** Transport-agnostic connection (WebSocket on the server, MessagePort in the offline worker). */
export interface ClientLink {
  send(data: Uint8Array | string): void;
  close(): void;
}

interface Conn {
  link: ClientLink;
  shipId: number;
  playerId: string;
  token: string;
  buffer: InputCmd[];
  lastSeq: number;
  lastInput: InputCmd;
  missed: number;
  rtt: number;
  interpDelay: number;
  inputWindowStart: number;
  inputCount: number;
  hidden: Set<number>;
  connected: boolean;
  disconnectedAt: number;
  welcomed: boolean;
}

export interface RoomOptions {
  id: string;
  isPrivate?: boolean;
  offline?: boolean;
  botSkill?: BotSkill;
  seed?: number;
  /** arena id from the registry (defaults to DEFAULT_ARENA): the first map of the rotation */
  arena?: string;
  /** move to the next map after every match (default true) */
  rotation?: boolean;
  /** receives the MatchReport of every finished match (server-side persistence) */
  sink?: MatchSink;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Anonymous identity tokens are minted by rooms as base36; accept that shape back from clients and nothing else. */
export function isIdentityToken(t: unknown): t is string {
  return typeof t === 'string' && /^[a-z0-9]{8,32}$/.test(t);
}

const REPEAT_CLEAR =InputFlag.Primary | InputFlag.Ability | InputFlag.Repel | InputFlag.DodgeL | InputFlag.DodgeR | InputFlag.DodgeU | InputFlag.DodgeD;
/** events never sent over JSON (they travel in the binary snapshot) */
const BINARY_EVENTS = new Set(['projSpawn', 'projEnd', 'shot']);

export class GameRoom {
  readonly id: string;
  readonly isPrivate: boolean;
  readonly offline: boolean;
  readonly sim: GameSim;
  private conns = new Map<ClientLink, Conn>();
  private byToken = new Map<string, Conn>();
  private now: () => number;
  private log: (msg: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;
  private tickStartedAt = 0;
  private snapCount = 0;
  private projSpawns: ProjSpawnSnap[] = [];
  private projEnds: ProjEndSnap[] = [];
  private pendingEvents: { tick: number; list: GameEvent[] }[] = [];
  private lastRosterAt = 0;
  private lastMatchAt = 0;
  private lastPickupsAt = 0;
  private lastPhase = '';
  private sink?: MatchSink;
  private writer = new Writer(4096);
  paused = false;
  lastHumanAt: number;
  tickMs = 0;

  constructor(o: RoomOptions) {
    this.id = o.id;
    this.isPrivate = !!o.isPrivate;
    this.offline = !!o.offline;
    this.now = o.now ?? (() => performance.now());
    this.log = o.log ?? (() => {});
    this.sink = o.sink;
    this.sim = new GameSim({
      seed: o.seed ?? hash32(...[...o.id].map((c) => c.charCodeAt(0)), Date.now() & 0xffff), offline: this.offline,
      botSkill: o.botSkill ?? 'normal', arena: arenaById(o.arena ?? DEFAULT_ARENA),
      nextArena: o.rotation === false ? undefined : nextInRotation,
    });
    this.lastHumanAt = this.now();
    this.backfill();
  }

  // ------------------------------------------------------------------ occupancy
  get humans(): number { return this.sim.shipList.filter((s) => !s.isBot).length; }
  /** humans with a live connection (excludes slots held for a reconnect) — the presence counter's "in matches" */
  get connectedHumans(): number { return this.sim.shipList.filter((s) => !s.isBot && s.connected).length; }
  get participants(): number { return this.sim.shipList.filter((s) => !s.removeAtDeath).length; }
  get hasFreeSlot(): boolean { return this.humans < MAX_PARTICIPANTS; }

  private backfill(): void {
    // keep at least BOT_BACKFILL_TARGET participants; un-flag pending removals first
    let n = this.participants;
    for (const s of this.sim.shipList) {
      if (n >= BOT_BACKFILL_TARGET) break;
      if (s.isBot && s.removeAtDeath) { s.removeAtDeath = false; n++; }
    }
    while (n < BOT_BACKFILL_TARGET && this.sim.shipList.length < MAX_PARTICIPANTS) { this.sim.addBot(); n++; }
  }

  private makeRoomForHuman(): void {
    if (this.participants < BOT_BACKFILL_TARGET && this.sim.shipList.length < MAX_PARTICIPANTS) return;
    const bots = this.sim.shipList.filter((s) => s.isBot && !s.removeAtDeath);
    if (!bots.length) return;
    const dead = bots.find((b) => !b.alive);
    if (dead) { this.sim.removePlayer(dead.id); return; }
    bots[bots.length - 1]!.removeAtDeath = true;
  }

  // ------------------------------------------------------------------ connections
  connect(link: ClientLink): void {
    this.conns.set(link, {
      link, shipId: -1, playerId: '', token: '', buffer: [], lastSeq: -1, lastInput: neutralInput(), missed: 0,
      rtt: 0.1, interpDelay: 0.1, inputWindowStart: this.now(), inputCount: 0, hidden: new Set(), connected: true,
      disconnectedAt: 0, welcomed: false,
    });
  }

  private sendJson(c: Conn, m: ServerMsg): void { if (c.connected) c.link.send(JSON.stringify(m)); }

  message(link: ClientLink, data: Uint8Array | string): void {
    const c = this.conns.get(link);
    if (!c) return;
    if (typeof data === 'string') {
      let m: ClientMsg | { t: 'pause'; on: boolean };
      try { m = JSON.parse(data); } catch { return; }
      this.onJson(c, m);
      return;
    }
    if (data.byteLength < 1) return;
    const r = new Reader(data);
    const type = r.u8();
    if (type === MsgType.Input) { if (c.shipId >= 0) this.onInputs(c, decodeInputPacket(r)); }
    else if (type === MsgType.Ping && r.remaining >= 16) {
      const clientTime = r.f64(), interpDelay = r.f32(), rtt = r.f32();
      if (Number.isFinite(rtt) && rtt >= 0 && rtt < 5) c.rtt = rtt;
      if (Number.isFinite(interpDelay) && interpDelay >= 0 && interpDelay < 1) c.interpDelay = interpDelay;
      const ship = this.sim.ship(c.shipId);
      if (ship) ship.lagTicks = Math.max(0, Math.min(LAG_COMP_MAX_TICKS, Math.round((c.rtt / 2 + c.interpDelay) / DT)));
      const since = (this.now() - this.tickStartedAt) / 1000 / DT;
      link.send(encodePong(clientTime, this.sim.tick, Math.max(0, Math.min(1, since))).slice());
    }
  }

  private onJson(c: Conn, m: ClientMsg | { t: 'pause'; on: boolean }): void {
    switch (m.t) {
      case 'hello': {
        if (c.welcomed) return;
        if (m.version !== BUILD_VERSION) { this.sendJson(c, { t: 'reload', version: BUILD_VERSION }); c.link.close(); return; }
        const cls: ClassId = CLASS_IDS.includes(m.classId) ? m.classId : 'dart';
        const name = String(m.name ?? '').replace(/[^\w \-.]/g, '').slice(0, 16).trim() || 'Pilot';
        const prev = m.token ? this.byToken.get(m.token) : undefined;
        if (prev && !prev.connected && this.sim.ship(prev.shipId)) {
          // reconnection: take over the held slot
          this.conns.delete(prev.link);
          c.shipId = prev.shipId; c.playerId = prev.playerId; c.token = prev.token;
          this.byToken.set(c.token, c);
          this.sim.reconnect(c.shipId);
          this.log(`room ${this.id}: ${name} reconnected`);
        } else {
          if (!this.hasFreeSlot) { this.sendJson(c, { t: 'full' }); c.link.close(); return; }
          this.makeRoomForHuman();
          // the token is the pilot's identity across rooms and visits (stats, profile): keep the one the client
          // brings, unless it's malformed or already flying in this room (a second tab gets its own)
          c.token = isIdentityToken(m.token) && !prev
            ? m.token
            : `${hash32(this.sim.tick, this.now() | 0, Math.random() * 1e9).toString(36).padStart(7, '0')}${hash32(Math.random() * 1e9).toString(36).padStart(7, '0')}`;
          c.playerId = `p:${c.token.slice(0, 8)}`;
          const ship = this.sim.addPlayer(c.playerId, name, cls);
          c.shipId = ship.id;
          this.byToken.set(c.token, c);
          this.log(`room ${this.id}: ${name} joined (${this.humans} humans, ${this.participants} participants)`);
        }
        c.welcomed = true;
        this.lastHumanAt = this.now();
        this.sendJson(c, {
          t: 'welcome', shipId: c.shipId, token: c.token, tick: this.sim.tick, roomId: this.id, version: BUILD_VERSION,
          arena: this.sim.arena.blueprint.id,
        });
        this.sendJson(c, { t: 'roster', players: this.roster() });
        this.sendJson(c, this.matchMsg());
        this.sendJson(c, { t: 'pickups', list: this.pickupList(), powerup: powerupInfo(this.sim) });
        this.broadcastRoster();
        break;
      }
      case 'class':
        if (c.shipId >= 0 && CLASS_IDS.includes(m.classId)) this.sim.setClass(c.shipId, m.classId);
        break;
      case 'hold':
        if (c.shipId >= 0) this.sim.setSpawnHold(c.shipId, !!m.hold);
        break;
      case 'pause':
        if (this.offline) this.paused = !!m.on;
        break;
    }
  }

  private onInputs(c: Conn, cmds: InputCmd[]): void {
    const t = this.now();
    if (t - c.inputWindowStart > 1000) { c.inputWindowStart = t; c.inputCount = 0; }
    for (const cmd of cmds) {
      const d = c.lastSeq < 0 ? 1 : seqDiff(cmd.seq, c.lastSeq);
      if (d <= 0) continue; // duplicate (redundancy) or stale
      if (c.inputCount >= MAX_INPUTS_PER_SECOND) break;
      if (d > 64) c.buffer.length = 0; // resync
      else if (c.buffer.some((b) => b.seq === cmd.seq)) continue;
      c.inputCount++;
      const flags = cmd.flags & 0x7ff;
      c.buffer.push({ ...cmd, flags });
      c.lastSeq = cmd.seq;
    }
    if (c.buffer.length > 32) c.buffer.splice(0, c.buffer.length - 32);
  }

  disconnect(link: ClientLink): void {
    const c = this.conns.get(link);
    if (!c) return;
    c.connected = false;
    if (c.shipId < 0 || !c.welcomed) { this.conns.delete(link); return; }
    c.disconnectedAt = this.now();
    this.sim.disconnect(c.shipId);
    this.log(`room ${this.id}: ship ${c.shipId} disconnected (holding ${RECONNECT_GRACE_S}s)`);
    this.broadcastRoster();
  }

  // ------------------------------------------------------------------ loop
  start(): void {
    if (this.timer) return;
    this.nextTickAt = this.now();
    const loop = () => {
      const t = this.now();
      let n = 0;
      while (t >= this.nextTickAt && n < 5) {
        try { this.tick(); } catch (e) { this.log(`room ${this.id}: tick ${this.sim.tick} failed: ${(e as Error)?.stack ?? e}`); }
        this.nextTickAt += DT * 1000;
        n++;
      }
      if (t - this.nextTickAt > 250) this.nextTickAt = t; // fell far behind: drop time rather than spiral
      this.timer = setTimeout(loop, Math.max(0, this.nextTickAt - this.now()));
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const c of this.conns.values()) if (c.connected) c.link.close();
    this.conns.clear();
    this.sim.world.free();
  }

  /** One authoritative 60 Hz step. */
  tick(): void {
    const t0 = this.now();
    this.tickStartedAt = t0;
    // expire held slots
    for (const c of [...this.conns.values()]) {
      if (!c.connected && c.welcomed && t0 - c.disconnectedAt > RECONNECT_GRACE_S * 1000) {
        this.sim.removePlayer(c.shipId);
        this.byToken.delete(c.token);
        this.conns.delete(c.link);
        this.backfill();
        this.broadcastRoster();
      }
    }
    if (this.humans > 0 && [...this.conns.values()].some((c) => c.connected)) this.lastHumanAt = t0;
    if (this.paused) return;

    // pop exactly one input per client ship
    for (const c of this.conns.values()) {
      const s = this.sim.ship(c.shipId);
      if (!s || !c.connected) continue;
      const next = c.buffer.shift();
      if (next) { s.input = next; c.lastInput = next; c.missed = 0; }
      else if (c.missed < MISSED_INPUT_REPEAT_LIMIT) {
        c.missed++;
        s.input = { ...c.lastInput, flags: c.lastInput.flags & ~REPEAT_CLEAR };
      } else {
        s.input = neutralInput(c.lastInput.seq, this.sim.tick, (c.lastInput.flags & InputFlag.AssistOn) !== 0);
      }
    }

    const botsBefore = this.sim.shipList.length;
    this.sim.step();
    if (this.sim.shipList.length !== botsBefore) { this.backfill(); this.broadcastRoster(); }

    const events = this.sim.drainEvents();
    const json: GameEvent[] = [];
    for (const e of events) {
      if (e.t === 'matchEnd') this.reportMatch();
      else if (e.t === 'projSpawn') {
        this.projSpawns.push({ id: e.id, owner: e.ownerId, weapon: primaryIndex(e.weapon), pos: e.pos, vel: e.vel, spawnTick: e.spawnTick, shotId: e.shotId, index: e.index });
      } else if (e.t === 'projEnd') {
        this.projEnds.push({ id: e.id, reason: END_REASONS.indexOf(e.reason), pos: e.pos });
      } else if (!BINARY_EVENTS.has(e.t)) json.push(e);
    }
    if (json.length) this.pendingEvents.push({ tick: this.sim.tick, list: json });

    const phase = this.sim.match.phase;
    if (phase !== this.lastPhase) { this.lastPhase = phase; this.broadcastMatch(); this.broadcastRoster(); }

    if (this.sim.tick % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots();
    if (t0 - this.lastRosterAt > 1000) this.broadcastRoster();
    if (t0 - this.lastMatchAt > 2000) this.broadcastMatch();
    if (t0 - this.lastPickupsAt > 5000) {
      this.lastPickupsAt = t0;
      const msg = JSON.stringify({ t: 'pickups', list: this.pickupList(), powerup: powerupInfo(this.sim) } satisfies ServerMsg);
      for (const c of this.conns.values()) if (c.connected && c.welcomed) c.link.send(msg);
    }
    this.tickMs = this.now() - t0;
  }

  // ------------------------------------------------------------------ outgoing state
  private roster(): RosterEntry[] {
    const pingOf = (s: Ship) => {
      for (const c of this.conns.values()) if (c.shipId === s.id) return Math.round(c.rtt * 1000);
      return 0;
    };
    return this.sim.shipList.map((s) => ({
      id: s.id, name: s.name, isBot: s.isBot, classId: s.alive ? s.def.id : s.pendingClass, accent: s.accent,
      kills: s.stats.kills, deaths: s.stats.deaths, assists: s.stats.assists, power: s.power, ping: s.isBot ? 0 : pingOf(s),
      alive: s.alive, connected: s.connected, damage: Math.round(s.stats.damageDealt), shotsFired: s.stats.shotsFired,
      shotsHit: s.stats.shotsHit, oranges: s.stats.orangesCollected, peakPower: s.stats.peakPower, tier: s.tier.index,
      maxShield: s.maxShield,
    }));
  }

  private broadcastRoster(): void {
    this.lastRosterAt = this.now();
    const msg = JSON.stringify({ t: 'roster', players: this.roster() } satisfies ServerMsg);
    for (const c of this.conns.values()) if (c.connected && c.welcomed) c.link.send(msg);
  }

  private matchMsg(): ServerMsg {
    const m = this.sim.match;
    return {
      t: 'match', phase: m.phase, phaseEndTick: m.phaseEndTick, winnerId: m.winnerId, tick: this.sim.tick,
      arena: this.sim.arena.blueprint.id, nextArena: this.sim.upcomingArena().blueprint.id,
    };
  }
  private broadcastMatch(): void {
    this.lastMatchAt = this.now();
    const msg = JSON.stringify(this.matchMsg());
    for (const c of this.conns.values()) if (c.connected && c.welcomed) c.link.send(msg);
  }

  private pickupList(): PickupInfo[] {
    return this.sim.pickups.map((p) => ({ id: p.id, pos: p.pos, units: p.units, drop: p.drop, expireTick: p.expireTick, killerId: p.killerId }));
  }

  private shipFlags(s: Ship, visibleToObserver: boolean): number {
    let f = 0;
    if (s.cloaked) f |= ShipFlag.Cloaked;
    if (s.cloaked && visibleToObserver) f |= ShipFlag.Shimmer;
    if (s.def.ability.id === 'bulwark' && s.abilityActive > 0 && s.bulwarkHp > 0) f |= ShipFlag.Bulwark;
    if (s.def.ability.id === 'overdrive' && s.abilityActive > 0) f |= ShipFlag.Overdrive;
    if (this.sim.tick < s.spawnProtectedUntil) f |= ShipFlag.SpawnProtected;
    if (s.safe) f |= ShipFlag.Safe;
    if (s.input.flags & InputFlag.AssistOn) f |= ShipFlag.AssistOn;
    if (s.flight.boosting) f |= ShipFlag.Boosting;
    if (s.sweepUntil > this.sim.tick) f |= ShipFlag.Sweeping;
    if (s.flight.dodgeRollTime > 0) f |= ShipFlag.DodgeRoll;
    if (s.lock.targetId >= 0 && s.lock.progress > 0) f |= ShipFlag.Locking;
    return f | powerupFlags(s.powerup);
  }

  private sendSnapshots(): void {
    this.snapCount++;
    const withMissiles = this.snapCount % MISSILE_STREAM_EVERY_SNAPSHOTS === 0;
    const missiles = withMissiles ? this.sim.missiles.map((m) => ({ id: m.id, pos: m.pos, vel: m.vel })) : null;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const c of this.conns.values()) {
      if (!c.connected || !c.welcomed) continue;
      const me = this.sim.ship(c.shipId);
      const ships: ShipSnap[] = [];
      const nowHidden = new Set<number>();
      for (const s of this.sim.shipList) {
        if (!s.alive || s.id === c.shipId) continue;
        const visible = !me || cloakVisible(me, s);
        if (!visible) { nowHidden.add(s.id); continue; }
        ships.push({
          id: s.id, gen: s.generation, cls: s.def.index, pos: s.pos, rot: s.rot, vel: s.vel, angvel: s.angvel, boost: s.flight.boostMeter,
          flags: this.shipFlags(s, true), hull: s.hull / s.def.hull, shield: s.maxShield > 0 ? s.shield / s.maxShield : 0, power: s.power,
        });
      }
      // interest management: cloaked enemies beyond reveal range are omitted entirely
      for (const id of nowHidden) if (!c.hidden.has(id)) this.sendJson(c, { t: 'vanish', shipId: id });
      c.hidden = nowHidden;

      let owner: OwnerSnap | null = null;
      if (me && me.alive) {
        owner = {
          id: me.id, gen: me.generation, cls: me.def.index, lastSeq: c.lastInput.seq,
          pos: me.pos, rot: me.rot, vel: me.vel, angvel: me.angvel, flight: me.flight,
          energy: me.energy, ammo: me.ammo, abilityCooldown: me.abilityCooldown, abilityActive: me.abilityActive, repelCooldown: me.repelCooldown,
          power: me.power, hull: me.hull, shield: me.shield, maxShield: me.maxShield,
          lockTarget: me.lock.targetId, lockProgress: me.lock.progress, locked: me.lock.locked, lockWarn: me.lockWarn, missileWarn: me.missileWarn,
          bulwarkHp: me.bulwarkHp, primaryLastFire: Math.max(0, me.primaryLastFire), muzzleIndex: me.muzzleIndex & 0xffff,
          spawnProtectedUntil: me.spawnProtectedUntil, cloaked: me.cloaked, safeCharge: me.safeCharge,
          powerup: powerupIndex(me.powerup), powerupLeft: powerupLeft(this.sim, me),
        };
      }
      const bytes = encodeSnapshot({
        tick: this.sim.tick, bufferDepth: c.buffer.length, owner, ships, missiles,
        projSpawns: this.projSpawns, projEnds: this.projEnds,
      }, this.writer);
      c.link.send(bytes);

      for (const batch of events) {
        const list = batch.list.filter((e) => !this.hiddenEvent(e, c.hidden));
        if (list.length) this.sendJson(c, { t: 'ev', tick: batch.tick, list });
      }
    }
    this.projSpawns = [];
    this.projEnds = [];
  }

  /** Events that would leak a hidden (cloaked, out-of-range) ship's position. */
  private hiddenEvent(e: GameEvent, hidden: Set<number>): boolean {
    if (!hidden.size) return false;
    switch (e.t) {
      case 'dodge': case 'scrape': case 'spawn': return hidden.has(e.shipId);
      case 'lockOn': return hidden.has(e.shipId);
      default: return false;
    }
  }

  /** Owner-side stats for monitoring. */
  stats() {
    return {
      id: this.id, arena: this.sim.arena.blueprint.id, humans: this.humans, participants: this.participants, tick: this.sim.tick,
      tickMs: this.tickMs, private: this.isPrivate,
    };
  }

  /** Hand the finished match to the sink (persistence). A failing sink must never kill the room. */
  private reportMatch(): void {
    if (!this.sink) return;
    try {
      const tokenOf = (shipId: number): string | null => {
        for (const c of this.byToken.values()) if (c.shipId === shipId && c.connected) return c.token;
        return null;
      };
      this.sink.onMatchEnd(buildMatchReport(this.sim, { roomId: this.id, mode: this.offline ? 'offline' : 'ffa', tokenOf }));
    } catch (e) {
      this.log(`room ${this.id}: match sink failed (${String(e)})`);
    }
  }
}

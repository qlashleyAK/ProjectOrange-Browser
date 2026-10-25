import {
  activePrimary, cloakVisible, DT, GameSim, nextInRotation, powerupInfo, powerupLeft, qslerp, q4, RESPAWN_HOLD_MAX_S, safeZoneAt, v3,
  vlerp, type ArenaData, type BotSkill, type ClassId, type GameEvent, type InputCmd, type RosterEntry, type Ship,
} from '@orange/shared';
import type { LocalState, MatchView, MissileView, PickupView, PowerupView, ProjView, ShipView, ViewSource } from '../view';

export interface InputSampler {
  beginFrame(ticks: number): void;
  sample(tick: number): InputCmd;
}

const MAX_STEPS_PER_FRAME = 6;

export function rosterOf(sim: GameSim, pingOf: (s: Ship) => number = () => 0): RosterEntry[] {
  return sim.shipList.map((s) => ({
    id: s.id, name: s.name, isBot: s.isBot, classId: s.alive ? s.def.id : s.pendingClass, accent: s.accent,
    kills: s.stats.kills, deaths: s.stats.deaths, assists: s.stats.assists, power: s.power, ping: pingOf(s),
    alive: s.alive, connected: s.connected, damage: Math.round(s.stats.damageDealt), shotsFired: s.stats.shotsFired,
    shotsHit: s.stats.shotsHit, oranges: s.stats.orangesCollected, peakPower: s.stats.peakPower, tier: s.tier.index,
    maxShield: s.maxShield,
  }));
}

export function matchViewOf(sim: GameSim): MatchView {
  const m = sim.match;
  return {
    phase: m.phase,
    timeLeft: Math.max(0, (m.phaseEndTick - sim.tick) * DT),
    winnerId: m.winnerId,
    elapsed: m.phase === 'inProgress' ? (sim.tick - m.startTick) * DT : 0,
    nextArena: sim.upcomingArena().blueprint.id,
  };
}

export function localStateOf(sim: GameSim, s: Ship, killerId: number): LocalState {
  return {
    shipId: s.id, alive: s.alive, def: s.def, pendingClass: s.pendingClass,
    hull: s.hull, shield: s.shield, maxShield: s.maxShield, energy: s.energy, ammo: s.ammo,
    abilityCooldown: s.abilityCooldown, abilityActive: s.abilityActive, repelCooldown: s.repelCooldown,
    power: s.power, tier: s.tier, boostMeter: s.flight.boostMeter, boostLocked: s.flight.boostLocked,
    dodgeCooldown: s.flight.dodgeCooldown, lockTarget: s.lock.targetId, lockProgress: s.lock.progress, locked: s.lock.locked,
    lockWarn: s.lockWarn, missileWarn: s.missileWarn, spawnProtected: sim.tick < s.spawnProtectedUntil,
    safe: s.safe, safeCharge: s.safeCharge, inSafeZone: s.alive && safeZoneAt(sim.arena, s.pos) !== null,
    cloaked: s.cloaked, bulwarkHp: s.bulwarkHp,
    respawnIn: s.alive ? 0 : Math.max(0, (s.respawnAt - sim.tick) * DT),
    holdSpawn: s.holdSpawn,
    holdLeft: s.alive ? 0 : Math.max(0, (s.deathTick + RESPAWN_HOLD_MAX_S / DT - sim.tick) * DT),
    killerId, primary: activePrimary(s.def, s.tier), secondary: s.def.secondary,
    powerup: s.alive ? s.powerup : null, powerupLeft: powerupLeft(sim, s),
  };
}

export function powerupViewOf(sim: GameSim, back = 0): PowerupView {
  const info = powerupInfo(sim);
  return { live: info.live, next: info.next ? { pos: info.next.pos, in: Math.max(0, (info.next.tick - sim.tick) * DT - back) } : null };
}

/** Single-player practice: the full simulation runs locally against bots. */
export class OfflineSource implements ViewSource {
  readonly online = false;
  readonly sim: GameSim;
  readonly localId: number;
  private acc = 0;
  private alpha = 0;
  private paused = false;
  private events: GameEvent[] = [];
  private killerId = -1;
  private shipViews = new Map<number, ShipView>();

  constructor(private input: InputSampler, name: string, cls: ClassId, botSkill: BotSkill, arena?: ArenaData, bots = 5) {
    this.sim = new GameSim({ seed: (Math.random() * 1e9) | 0, offline: true, botSkill, arena, nextArena: nextInRotation });
    const me = this.sim.addPlayer('local', name || 'Pilot', cls);
    this.localId = me.id;
    for (let i = 0; i < bots; i++) this.sim.addBot();
  }

  get arena() { return this.sim.arena; }
  get world() { return this.sim.world; }

  update(dt: number): void {
    if (this.paused) return;
    this.acc += Math.min(dt, 0.25);
    this.input.beginFrame(Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.acc / DT)));
    let steps = 0;
    while (this.acc >= DT && steps < MAX_STEPS_PER_FRAME) {
      const me = this.sim.ship(this.localId);
      const cmd = this.input.sample(this.sim.tick + 1);
      if (me) { me.input = cmd; }
      this.sim.step();
      for (const e of this.sim.drainEvents()) {
        if (e.t === 'death' && e.victimId === this.localId) this.killerId = e.killerId;
        this.events.push(e);
      }
      this.acc -= DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.acc = Math.min(this.acc, DT);
    this.alpha = this.acc / DT;
  }

  ships(): ShipView[] {
    const me = this.sim.ship(this.localId);
    const out: ShipView[] = [];
    for (const s of this.sim.shipList) {
      let v = this.shipViews.get(s.id);
      if (!v) {
        v = {
          id: s.id, name: s.name, isBot: s.isBot, classId: s.def.id, accent: s.accent, alive: false, gen: 0,
          pos: v3(), rot: q4(), vel: v3(), hullFrac: 1, shieldFrac: 1, power: 0, tierIndex: -1, cloaked: false,
          shimmer: false, bulwark: false, overdrive: false, spawnProtected: false, safe: false, boosting: false,
          isLocal: s.id === this.localId, powerup: null,
        };
        this.shipViews.set(s.id, v);
      }
      v.name = s.name; v.classId = s.def.id; v.accent = s.accent; v.alive = s.alive; v.gen = s.generation;
      vlerp(v.pos, s.prevPos, s.pos, this.alpha);
      qslerp(v.rot, s.prevRot, s.rot, this.alpha);
      v.vel.x = s.vel.x; v.vel.y = s.vel.y; v.vel.z = s.vel.z;
      v.hullFrac = s.hull / s.def.hull; v.shieldFrac = s.maxShield > 0 ? s.shield / s.maxShield : 0;
      v.power = s.power; v.tierIndex = s.tier.index;
      const visible = !me || s.id === me.id || cloakVisible(me, s);
      v.cloaked = s.cloaked && !visible;
      v.shimmer = s.cloaked && visible;
      v.bulwark = s.bulwarkHp > 0 && s.abilityActive > 0 && s.def.ability.id === 'bulwark';
      v.overdrive = s.abilityActive > 0 && s.def.ability.id === 'overdrive';
      v.spawnProtected = this.sim.tick < s.spawnProtectedUntil;
      v.safe = s.safe;
      v.boosting = s.flight.boosting;
      v.powerup = s.powerup;
      out.push(v);
    }
    for (const id of this.shipViews.keys()) if (!this.sim.ships.has(id)) this.shipViews.delete(id);
    return out;
  }

  local(): LocalState | null {
    const s = this.sim.ship(this.localId);
    return s ? localStateOf(this.sim, s, this.killerId) : null;
  }

  projectiles(): ProjView[] {
    const back = (1 - this.alpha) * DT;
    return this.sim.projectiles.map((p) => ({
      id: p.id, ownerId: p.ownerId, weapon: p.weapon,
      pos: v3(p.pos.x - p.vel.x * back, p.pos.y - p.vel.y * back, p.pos.z - p.vel.z * back),
      vel: p.vel, age: (this.sim.tick - p.spawnTick) * DT - back,
    }));
  }

  missiles(): MissileView[] {
    const back = (1 - this.alpha) * DT;
    return this.sim.missiles.map((m) => ({
      id: m.id, ownerId: m.ownerId, kind: m.def.kind, color: m.def.color,
      pos: v3(m.pos.x - m.vel.x * back, m.pos.y - m.vel.y * back, m.pos.z - m.vel.z * back), vel: m.vel,
    }));
  }

  pickups(): PickupView[] {
    return this.sim.pickups.map((p) => ({
      id: p.id, pos: p.pos, units: p.units, drop: p.drop, expireIn: (p.expireTick - this.sim.tick) * DT, killerId: p.killerId,
    }));
  }

  powerup(): PowerupView { return powerupViewOf(this.sim, this.alpha * DT); }
  roster(): RosterEntry[] { return rosterOf(this.sim); }
  match(): MatchView { return matchViewOf(this.sim); }
  drainEvents(): GameEvent[] { const e = this.events; this.events = []; return e; }
  time(): number { return (this.sim.tick + this.alpha) * DT; }
  envTick(): number { return this.sim.tick - 1 + this.alpha; }
  setClass(c: ClassId): void { this.sim.setClass(this.localId, c); }
  setHold(hold: boolean): void { this.sim.setSpawnHold(this.localId, hold); }
  setPaused(p: boolean): void { this.paused = p; }
  netStats() { return null; }
  warning(): string | null { return null; }
  dispose(): void { this.sim.world.free(); }
}

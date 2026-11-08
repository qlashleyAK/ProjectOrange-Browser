import type * as RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { hollowdeep } from './arena/blueprint.js';
import { generateArena, placeAt, safeZoneAt, type ArenaData } from './arena/generate.js';
import { absorbBulwark, activateBulwark, bulwarkIntersect, endBulwark } from './abilities/bulwark.js';
import { activateCloak, breakCloak } from './abilities/cloak.js';
import { activateOverdrive, overdriveActive } from './abilities/overdrive.js';
import { activateRepel } from './abilities/repel.js';
import { activateSweep, updateSweepReveal } from './abilities/sensorSweep.js';
import { BOT_NAMES, BotBrain, type BotSkill } from './bots/brain.js';
import { NavGraph } from './bots/nav.js';
import { botCanSee, cloakVisible } from './bots/perception.js';
import { CLASSES, CLASS_IDS, type ClassId, type PrimaryDef } from './classes/index.js';
import {
  CHECKPOINT_RADIUS, DT, MAX_PARTICIPANTS, MAX_POWER, MINE_RUN_CHECKPOINTS, RESPAWN_DELAY_S, SURVIVAL_WAVE_BASE, RESPAWN_HOLD_MAX_S, SAFE_ZONE_CHARGE_S, SPAWN_PROTECTION_S, WARMUP_OFFLINE_S, WARMUP_S,
  stepSafeCharge,
} from './constants.js';
import { recordPose } from './combat/hitVolumes.js';
import { endMissile, launchSecondary, updateLock, updateMissiles } from './combat/missiles.js';
import { endProjectile, updateProjectiles } from './combat/projectiles.js';
import { firePrimary } from './combat/weapons.js';
import type { GameEvent, GameMode, Missile, Pickup, Projectile, Ship } from './entities.js';
import { applyFlightControl, newFlightState } from './flight.js';
import { InputFlag, neutralInput } from './input.js';
import { chooseSpawn, newMatch, updateMatch, type MatchState } from './match.js';
import { q4, qlookDir, v3, type V3 } from './math.js';
import {
  addArenaColliders, addMovers, createShipBody, createWorld, driveMovers, finalizeSpawns, RAPIER as R, type MoverBody,
} from './physicsWorld.js';
import { dropOnDeath, populate, updatePickups } from './pickups.js';
import { applyTierToVitals, resolveTier } from './power.js';
import { findPowerupSpots, losePowerup, newPowerupState, powerupFlight, resetPowerups, updatePowerups, type PowerupState } from './powerups.js';
import { Rng } from './rng.js';

export interface GameSimOptions {
  seed?: number;
  offline?: boolean;
  botSkill?: BotSkill;
  arena?: ArenaData;
  /** the map to load once a match's results have been shown; without it every match replays the same one */
  nextArena?: (current: ArenaData) => ArenaData;
  /** match mode: classic FFA (default) or one of the rotating daily challenge modes */
  mode?: GameMode;
}

export const ACCENT_COUNT = 10;

export class GameSim {
  // the arena and everything built from it change between matches when maps rotate
  world!: RAPIER.World;
  arena!: ArenaData;
  nav!: NavGraph;
  movers!: MoverBody[];
  readonly rng: Rng;
  readonly warmupSeconds: number;
  readonly eventQueue: RAPIER.EventQueue;
  private readonly nextArena?: (current: ArenaData) => ArenaData;
  botSkill: BotSkill;
  tick = 0;
  ships = new Map<number, Ship>();
  shipList: Ship[] = [];
  projectiles: Projectile[] = [];
  missiles: Missile[] = [];
  pickups: Pickup[] = [];
  powerups: PowerupState = newPowerupState();
  events: GameEvent[] = [];
  match: MatchState = newMatch();
  /** active match mode (ffa default; daily modes change win conditions + scoring) */
  mode: GameMode = 'ffa';
  /** survival: current wave (0 before the first spawns) */
  wave = 0;
  /** survival: tick the next wave spawns at (-1 = idle) */
  waveNextAtTick = -1;
  /** mine-run: the checkpoint course for the current match */
  course: V3[] = [];
  bots = new Map<number, BotBrain>();
  combatLog: { pos: V3; tick: number; place: string | undefined }[] = [];
  lastOrangeRegion = '';
  private colliderShip = new Map<number, number>();
  private projId = 0;
  private missileId = 0;
  private pickupId = 0;
  private projCount = new Map<number, number>();
  /** set to true to stop the match from advancing (offline pause) */
  paused = false;

  constructor(opts: GameSimOptions = {}) {
    this.rng = new Rng(opts.seed ?? 12345);
    this.warmupSeconds = opts.offline ? WARMUP_OFFLINE_S : WARMUP_S;
    this.botSkill = opts.botSkill ?? 'normal';
    this.nextArena = opts.nextArena;
    this.mode = opts.mode ?? 'ffa';
    this.loadArena(opts.arena ?? generateArena(hollowdeep()));
    this.eventQueue = new R.EventQueue(true);
  }

  private loadArena(arena: ArenaData): void {
    this.arena = arena;
    this.world = createWorld();
    addArenaColliders(this.world, arena);
    this.world.step(); // build broadphase for queries
    finalizeSpawns(this.world, arena);
    if (!arena.powerupSpots.length) arena.powerupSpots = findPowerupSpots(this.world, arena);
    this.nav = new NavGraph(this.world, arena);
    // after the nav graph, which routes around movers' swept volumes rather than their current poses
    this.movers = addMovers(this.world, arena, this.tick);
    if (this.movers.length) this.world.step();
  }

  /** The map the next match will be played on. */
  upcomingArena(): ArenaData { return this.nextArena ? this.nextArena(this.arena) : this.arena; }

  /** Between matches: move to the next map. Everyone leaves the old world here; resetRound spawns them into the new one. */
  rotateArena(): void {
    const next = this.upcomingArena();
    if (next === this.arena) return;
    for (const p of this.projectiles.slice()) endProjectile(this, p, 'owner', p.pos);
    for (const m of this.missiles.slice()) endMissile(this, m, 'owner', m.pos, false);
    for (const s of this.shipList) if (s.alive) this.despawn(s);
    this.colliderShip.clear();
    this.world.free();
    this.loadArena(next);
    this.lastOrangeRegion = '';
    // brains hold routes and memories of the old map
    for (const id of this.bots.keys()) this.bots.set(id, new BotBrain(id, this.botSkill, this.rng.int(1, 1e9)));
  }

  // ---------------------------------------------------------------- utility
  emit(e: GameEvent): void { this.events.push(e); }
  drainEvents(): GameEvent[] { const e = this.events; this.events = []; return e; }
  ship(id: number): Ship | undefined { return this.ships.get(id); }
  nextMissileId(): number { this.missileId = (this.missileId + 1) & 0xffff; return this.missileId; }
  nextPickupId(): number { this.pickupId = (this.pickupId + 1) & 0xffff; return this.pickupId; }
  damageEnabled(): boolean { return this.match.phase === 'inProgress'; }
  weaponsEnabled(): boolean { return this.match.phase === 'inProgress' && this.mode !== 'mine-run' || this.match.phase === 'waiting'; }
  liveProjectilesOf(id: number): number { return this.projCount.get(id) ?? 0; }
  noteCombat(pos: V3): void {
    this.combatLog.push({ pos: { ...pos }, tick: this.tick, place: placeAt(this.arena, pos)?.id });
    if (this.combatLog.length > 200) this.combatLog.splice(0, this.combatLog.length - 200);
  }
  canSee(obs: Ship, t: Ship): boolean {
    return obs.isBot ? botCanSee(this, obs, t) : cloakVisible(obs, t);
  }
  breakCloak(s: Ship): void { breakCloak(this, s); }
  bulwarkIntersect(s: Ship, shooter: number, a: V3, dir: V3, len: number): number { return bulwarkIntersect(s, shooter, a, dir, len); }
  absorbBulwark(s: Ship, dmg: number, pos: V3): void { absorbBulwark(this, s, dmg, pos); }
  endSpawnProtection(s: Ship): void { if (this.tick < s.spawnProtectedUntil) s.spawnProtectedUntil = this.tick; }

  // ---------------------------------------------------------------- players
  private freeId(): number {
    for (let i = 0; i < 255; i++) if (!this.ships.has(i)) return i;
    throw new Error('no free ship ids');
  }

  private freeAccent(): number {
    const used = new Set(this.shipList.map((s) => s.accent));
    for (let i = 0; i < ACCENT_COUNT; i++) if (!used.has(i)) return i;
    return this.shipList.length % ACCENT_COUNT;
  }

  addPlayer(playerId: string, name: string, classId: ClassId, isBot = false, botSkill?: BotSkill): Ship {
    const id = this.freeId();
    const def = CLASSES[classId];
    const s: Ship = {
      id, playerId, name, isBot, accent: this.freeAccent(), def, pendingClass: classId,
      body: null, alive: false, generation: 0, connected: true,
      pos: v3(), rot: q4(), vel: v3(), angvel: v3(), prevPos: v3(), prevRot: q4(),
      flight: newFlightState(),
      hull: def.hull, shield: def.shield, maxShield: def.shield, energy: def.energyMax, ammo: def.secondary.ammo,
      bonusAmmoGranted: 0, power: 0, tier: resolveTier(def, 0), lastDamageTick: -9999, lastFireTick: -9999,
      primaryLastFire: -9999, secondaryLastFire: -9999, muzzleIndex: 0,
      abilityCooldown: 0, abilityActive: 0, repelCooldown: 0, cloaked: false, ambushReady: false, bulwarkHp: 0,
      sweepUntil: 0, sweepRevealed: new Set(), lock: { targetId: -1, progress: 0, locked: false }, secondaryHeld: false,
      spawnProtectedUntil: 0, safe: false, safeCharge: SAFE_ZONE_CHARGE_S, powerup: null, powerupUntil: 0,
      deathTick: this.tick - RESPAWN_DELAY_S / DT, respawnAt: this.tick, holdSpawn: false, removeAtDeath: false,
      checkpoint: 0, courseDoneTick: 0,
      stats: { kills: 0, deaths: 0, assists: 0, damageDealt: 0, shotsFired: 0, shotsHit: 0, orangesCollected: 0, peakPower: 0 },
      damagers: new Set(), input: neutralInput(), prevFlags: 0, lagTicks: 0, lockWarn: 0, missileWarn: 0, poseHistory: [],
    };
    this.ships.set(id, s);
    this.rebuildList();
    if (isBot) this.bots.set(id, new BotBrain(id, botSkill ?? this.botSkill, this.rng.int(1, 1e9)));
    this.spawnShip(s);
    return s;
  }

  addBot(skill?: BotSkill): Ship {
    const used = new Set(this.shipList.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot${this.shipList.length}`;
    const counts = new Map<ClassId, number>(CLASS_IDS.map((c) => [c, 0]));
    for (const s of this.shipList) counts.set(s.pendingClass, (counts.get(s.pendingClass) ?? 0) + 1);
    const min = Math.min(...counts.values());
    const pool = CLASS_IDS.filter((c) => counts.get(c) === min);
    return this.addPlayer(`bot:${name}`, name, this.rng.pick(pool), true, skill);
  }

  removePlayer(id: number): void {
    const s = this.ships.get(id);
    if (!s) return;
    if (s.alive) this.despawn(s);
    this.destroyOwned(s.id);
    this.ships.delete(id);
    this.bots.delete(id);
    this.rebuildList();
  }

  private rebuildList(): void {
    this.shipList = [...this.ships.values()].sort((a, b) => a.id - b.id);
  }

  /** Network drop: despawn without a death, keep the slot and score. */
  disconnect(id: number): void {
    const s = this.ships.get(id);
    if (!s) return;
    if (s.alive) { this.destroyOwned(s.id); this.despawn(s); }
    s.connected = false;
    s.deathTick = this.tick;
  }
  reconnect(id: number): void {
    const s = this.ships.get(id);
    if (!s) return;
    s.connected = true;
    s.respawnAt = this.tick;
    s.holdSpawn = false;
  }

  setClass(id: number, cls: ClassId): void {
    const s = this.ships.get(id);
    if (s) s.pendingClass = cls;
  }
  setSpawnHold(id: number, hold: boolean): void {
    const s = this.ships.get(id);
    if (s) s.holdSpawn = hold;
  }

  private destroyOwned(ownerId: number): void {
    for (const p of this.projectiles.slice()) if (p.ownerId === ownerId) endProjectile(this, p, 'owner', p.pos);
    for (const m of this.missiles.slice()) if (m.ownerId === ownerId) endMissile(this, m, 'owner', m.pos, false);
  }

  /** Remove a ship from the world (death, round reset, or removal). */
  despawn(s: Ship): void {
    losePowerup(this, s, 'reset');
    if (s.body) {
      const b = s.body;
      for (let i = 0; i < b.numColliders(); i++) this.colliderShip.delete(b.collider(i).handle);
      this.world.removeRigidBody(b);
      s.body = null;
    }
    s.alive = false;
    s.safe = false;
  }

  spawnShip(s: Ship): void {
    if (s.body) this.despawn(s);
    s.def = CLASSES[s.pendingClass];
    const sp = chooseSpawn(this, s);
    const rot = qlookDir(q4(), sp.facing, v3(0, 1, 0));
    s.body = createShipBody(this.world, s.def, sp.pos, rot);
    for (let i = 0; i < s.body.numColliders(); i++) this.colliderShip.set(s.body.collider(i).handle, s.id);
    s.alive = true;
    s.generation = (s.generation + 1) & 0xff;
    s.pos = { ...sp.pos }; s.prevPos = { ...sp.pos }; s.rot = { ...rot }; s.prevRot = { ...rot };
    s.vel = v3(); s.angvel = v3();
    s.flight = newFlightState();
    s.power = 0; s.tier = resolveTier(s.def, 0); s.bonusAmmoGranted = 0;
    s.hull = s.def.hull; s.maxShield = s.def.shield; s.shield = s.maxShield;
    s.energy = s.def.energyMax; s.ammo = s.def.secondary.ammo;
    s.abilityCooldown = 0; s.abilityActive = 0; s.repelCooldown = 0; s.cloaked = false; s.ambushReady = false; s.bulwarkHp = 0;
    s.sweepUntil = 0; s.sweepRevealed.clear(); s.lock = { targetId: -1, progress: 0, locked: false };
    s.lastDamageTick = -9999; s.primaryLastFire = -9999; s.secondaryLastFire = -9999;
    s.spawnProtectedUntil = this.tick + Math.round(SPAWN_PROTECTION_S / DT);
    s.safeCharge = SAFE_ZONE_CHARGE_S;
    s.safe = safeZoneAt(this.arena, s.pos) !== null;
    s.damagers.clear();
    s.holdSpawn = false;
    s.poseHistory = [];
    this.emit({ t: 'spawn', shipId: s.id, pos: { ...s.pos } });
  }

  /** Teleport a live ship (tests, debug). */
  placeShip(s: Ship, pos: V3, rot = q4(), vel = v3()): void {
    if (!s.body) return;
    s.body.setTranslation(pos, true); s.body.setRotation(rot, true);
    s.body.setLinvel(vel, true); s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    s.pos = { ...pos }; s.prevPos = { ...pos }; s.rot = { ...rot }; s.prevRot = { ...rot }; s.vel = { ...vel }; s.angvel = v3();
    s.poseHistory = [];
    this.updateSafe(s, false);
  }

  private updateSafe(s: Ship, advance = true): void {
    const inZone = safeZoneAt(this.arena, s.pos) !== null;
    if (advance) s.safeCharge = stepSafeCharge(s.safeCharge, inZone);
    s.safe = inZone && s.safeCharge > 0;
  }

  /** Force the match into progress (tests, debug). */
  forceInProgress(): void {
    this.match.phase = 'inProgress';
    this.match.phaseEndTick = this.tick + 1e7;
    this.match.startTick = this.tick;
  }

  // ---------------------------------------------------------------- combat hooks
  spawnProjectile(owner: Ship, w: PrimaryDef, pos: V3, vel: V3, damage: number, shotId: number, index: number): void {
    this.projId = (this.projId + 1) & 0xffff;
    const p: Projectile = {
      id: this.projId, ownerId: owner.id, ownerGen: owner.generation, weapon: w, pos: { ...pos }, vel: { ...vel },
      spawnTick: this.tick, endTick: this.tick + Math.round(w.life / DT), damage, lagTicks: owner.lagTicks, shotId, index,
    };
    this.projectiles.push(p);
    this.projCount.set(owner.id, (this.projCount.get(owner.id) ?? 0) + 1);
    this.emit({ t: 'projSpawn', id: p.id, ownerId: owner.id, weapon: w.id, pos: { ...pos }, vel: { ...vel }, spawnTick: this.tick, shotId, index });
  }

  removeProjectile(p: Projectile): void {
    if (p.dead) return;
    p.dead = true;
    const i = this.projectiles.indexOf(p);
    if (i >= 0) this.projectiles.splice(i, 1);
    this.projCount.set(p.ownerId, Math.max(0, (this.projCount.get(p.ownerId) ?? 1) - 1));
  }

  killShip(victim: Ship, killerId: number, weapon: string): void {
    if (!victim.alive) return;
    const killer = killerId !== victim.id ? this.ships.get(killerId) : undefined;
    victim.stats.deaths++;
    if (killer) killer.stats.kills++;
    const assists: number[] = [];
    for (const d of victim.damagers) {
      if (d === killerId || d === victim.id) continue;
      const a = this.ships.get(d);
      if (a) { a.stats.assists++; assists.push(d); }
    }
    const pos = { ...victim.pos }, vel = { ...victim.vel };
    const dropped = dropOnDeath(this, victim, killer ? killer.id : -1);
    losePowerup(this, victim, 'death');
    this.destroyOwned(victim.id);
    if (victim.cloaked) victim.cloaked = false;
    this.despawn(victim);
    victim.deathTick = this.tick;
    victim.respawnAt = this.tick + Math.round(RESPAWN_DELAY_S / DT);
    victim.power = 0;
    for (const o of this.shipList) if (o.lock.targetId === victim.id) { o.lock.targetId = -1; o.lock.progress = 0; o.lock.locked = false; }
    this.noteCombat(pos);
    this.emit({ t: 'death', victimId: victim.id, killerId: killer ? killer.id : -1, weapon, pos, vel, classId: victim.def.id, dropped, assists });
  }

  grantPower(s: Ship, units: number): void {
    const before = s.tier.index;
    s.power = Math.min(MAX_POWER, s.power + units);
    s.stats.peakPower = Math.max(s.stats.peakPower, s.power);
    this.refreshTier(s, before);
  }

  private refreshTier(s: Ship, before: number): void {
    s.tier = resolveTier(s.def, s.power);
    applyTierToVitals(s.def, s.tier, s);
    if (s.tier.index !== before) this.emit({ t: 'tier', shipId: s.id, index: s.tier.index, name: s.tier.name, gained: s.tier.index > before });
  }

  /** Called at the start of a match/after post-match: reset scores, clear world, respawn everyone. */
  resetRound(): void {
    for (const p of this.projectiles.slice()) endProjectile(this, p, 'owner', p.pos);
    for (const m of this.missiles.slice()) endMissile(this, m, 'owner', m.pos, false);
    for (const p of this.pickups) this.emit({ t: 'pickupExpire', id: p.id });
    this.pickups = [];
    this.combatLog = [];
    this.wave = 0;
    this.waveNextAtTick = -1;
    this.course = this.mode === 'mine-run' ? this.buildCourse() : [];
    for (const s of this.shipList) {
      s.stats = { kills: 0, deaths: 0, assists: 0, damageDealt: 0, shotsFired: 0, shotsHit: 0, orangesCollected: 0, peakPower: 0 };
      s.checkpoint = 0;
      s.courseDoneTick = 0;
      if (s.alive) this.despawn(s);
    }
    resetPowerups(this);
    for (const s of this.shipList) this.spawnShip(s);
  }

  /** mine-run: seeded course over the arena's spawn points (every pilot flies the same line). */
  private buildCourse(): V3[] {
    const spawns = this.arena.spawns.map((sp) => ({ ...sp.pos }));
    const course: V3[] = [];
    while (course.length < MINE_RUN_CHECKPOINTS && spawns.length) {
      course.push(spawns.splice(this.rng.int(0, spawns.length - 1), 1)[0]!);
    }
    return course;
  }

  /** survival: spawn the next wave — bots die for good, skill ramps with the wave count. */
  spawnWave(): void {
    this.wave++;
    const count = SURVIVAL_WAVE_BASE + this.wave - 1;
    const skills: BotSkill[] = ['easy', 'normal', 'hard'];
    for (let i = 0; i < count; i++) {
      if (this.shipList.length >= MAX_PARTICIPANTS) break;
      const bot = this.addBot(skills[Math.min(skills.length - 1, Math.floor((this.wave - 1) / 2))]);
      bot.removeAtDeath = true;
    }
    this.emit({ t: 'wave', wave: this.wave, count });
  }

  // ---------------------------------------------------------------- tick
  private handleInput(s: Ship): void {
    const f = s.input.flags, pf = s.prevFlags;
    const pressed = (b: number) => (f & b) !== 0 && (pf & b) === 0;
    const armed = this.weaponsEnabled() && !s.safe;

    if (armed && pressed(InputFlag.Ability) && s.abilityCooldown <= 0 && s.abilityActive <= 0) {
      const ab = s.def.ability;
      const cd = ab.cooldown * s.tier.abilityCooldown;
      switch (ab.id) {
        case 'overdrive': activateOverdrive(s); s.abilityCooldown = cd; break;
        case 'sweep': activateSweep(this, s); s.abilityCooldown = cd; break;
        case 'cloak': activateCloak(s); break;
        case 'bulwark': activateBulwark(s); s.abilityCooldown = cd; break;
      }
      this.endSpawnProtection(s);
      this.emit({ t: 'ability', shipId: s.id, ability: ab.id, on: true, pos: { ...s.pos } });
    }
    if (armed && pressed(InputFlag.Repel)) activateRepel(this, s);

    if (armed && (f & InputFlag.Primary)) firePrimary(this, s);

    const held = armed && (f & InputFlag.Secondary) !== 0;
    if (armed && !held && s.secondaryHeld) launchSecondary(this, s);
    updateLock(this, s, held);
    s.secondaryHeld = held;
  }

  private updateTimers(s: Ship): void {
    s.abilityCooldown = Math.max(0, s.abilityCooldown - DT);
    s.repelCooldown = Math.max(0, s.repelCooldown - DT);
    if (s.abilityActive > 0) {
      s.abilityActive = Math.max(0, s.abilityActive - DT);
      if (s.abilityActive <= 0) {
        if (s.def.ability.id === 'cloak') breakCloak(this, s);
        else if (s.def.ability.id === 'bulwark') endBulwark(this, s);
        else this.emit({ t: 'ability', shipId: s.id, ability: s.def.ability.id, on: false, pos: { ...s.pos } });
      }
    }
    if (s.def.ability.id === 'sweep') updateSweepReveal(this, s);
    s.energy = Math.min(s.def.energyMax, s.energy + s.def.energyRegen * DT);
    if (!s.cloaked && (this.tick - s.lastDamageTick) * DT >= s.def.shieldRegenDelay) {
      s.shield = Math.min(s.maxShield, s.shield + s.def.shieldRegenRate * DT);
    }
  }

  step(): void {
    if (this.paused) return;
    this.tick++;
    updateMatch(this);

    // respawns (survival: dead humans stay dead — the run ends when the last pilot falls)
    for (const s of this.shipList) {
      if (s.alive || !s.connected) continue;
      if (this.mode === 'survival' && !s.isBot) continue;
      // dead-for-good ships must not resurrect before the removal sweep collects them
      if (s.removeAtDeath) continue;
      const holdOver = this.tick >= s.deathTick + Math.round(RESPAWN_HOLD_MAX_S / DT);
      if (this.tick >= s.respawnAt && (!s.holdSpawn || holdOver)) this.spawnShip(s);
    }

    // mine-run: checkpoint pass-through
    if (this.mode === 'mine-run' && this.course.length) {
      for (const s of this.shipList) {
        if (!s.alive || s.checkpoint >= this.course.length) continue;
        const cp = this.course[s.checkpoint]!;
        const dx = s.pos.x - cp.x, dy = s.pos.y - cp.y, dz = s.pos.z - cp.z;
        if (dx * dx + dy * dy + dz * dz <= CHECKPOINT_RADIUS * CHECKPOINT_RADIUS) {
          s.checkpoint++;
          this.emit({ t: 'checkpoint', shipId: s.id, index: s.checkpoint, total: this.course.length, pos: { ...cp } });
          if (s.checkpoint >= this.course.length) s.courseDoneTick = this.tick;
        }
      }
    }

    // bots think
    for (const [id, brain] of this.bots) {
      const s = this.ships.get(id);
      if (s) { brain.think(this, s, s.input); s.input.seq = (s.input.seq + 1) & 0xffff; s.input.tick = this.tick; }
    }

    // inputs + flight, in entity-id order
    for (const s of this.shipList) {
      if (!s.alive || !s.body) { s.prevFlags = s.input.flags; continue; }
      s.prevPos.x = s.pos.x; s.prevPos.y = s.pos.y; s.prevPos.z = s.pos.z;
      s.prevRot.x = s.rot.x; s.prevRot.y = s.rot.y; s.prevRot.z = s.rot.z; s.prevRot.w = s.rot.w;
      this.handleInput(s);
      const res = applyFlightControl(s.body, s.input, s.def, s.flight, DT, powerupFlight(overdriveActive(s), s.powerup));
      if (res.dodged) {
        for (const o of this.shipList) if (o.lock.targetId === s.id) { o.lock.progress = 0; o.lock.locked = false; o.lock.targetId = -1; }
        this.emit({ t: 'dodge', shipId: s.id });
      }
      s.prevFlags = s.input.flags;
    }

    driveMovers(this.movers, this.tick);
    this.world.step(this.eventQueue);
    this.eventQueue.drainContactForceEvents((e) => {
      const a = this.colliderShip.get(e.collider1()), b = this.colliderShip.get(e.collider2());
      const sid = a ?? b;
      if (sid === undefined) return;
      const s = this.ships.get(sid);
      if (s) this.emit({ t: 'scrape', shipId: sid, pos: { ...s.pos }, force: e.maxForceMagnitude() });
    });

    for (const s of this.shipList) {
      if (s.alive && s.body) {
        const t = s.body.translation(), r = s.body.rotation(), lv = s.body.linvel(), av = s.body.angvel();
        s.pos.x = t.x; s.pos.y = t.y; s.pos.z = t.z;
        s.rot.x = r.x; s.rot.y = r.y; s.rot.z = r.z; s.rot.w = r.w;
        s.vel.x = lv.x; s.vel.y = lv.y; s.vel.z = lv.z;
        s.angvel.x = av.x; s.angvel.y = av.y; s.angvel.z = av.z;
        this.updateSafe(s);
      }
      recordPose(s, this.tick);
    }

    updateProjectiles(this);
    updateMissiles(this);
    for (const s of this.shipList) if (s.alive) this.updateTimers(s);
    updatePickups(this);
    updatePowerups(this);
    populate(this);

    for (const s of this.shipList) { s.lockWarn = 0; s.missileWarn = 0; }
    for (const s of this.shipList) {
      if (s.lock.targetId >= 0 && s.lock.progress > 0) {
        const t = this.ships.get(s.lock.targetId);
        if (t) t.lockWarn++;
      }
    }
    for (const m of this.missiles) {
      if (!m.tracking) continue;
      const t = this.ships.get(m.targetId);
      if (t) t.missileWarn++;
    }

    // remove bots flagged for removal at their death
    for (const s of this.shipList.slice()) if (s.removeAtDeath && !s.alive) this.removePlayer(s.id);
  }
}

export type { Ship };

import { DT, MAX_POWER } from '../constants.js';
import type { Pickup, Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { InputFlag, type InputCmd } from '../input.js';
import { DEG, clamp, qrot, qrotInv, v3, vdist, vdot, vlen, vnorm, type V3 } from '../math.js';
import { castStatic } from '../physicsWorld.js';
import { Rng } from '../rng.js';
import { activePrimary } from '../combat/weapons.js';
import { botCanSee } from './perception.js';

export type BotSkill = 'easy' | 'normal' | 'hard';
export interface SkillDef {
  reaction: number;
  /** meters beyond the target's hull the aim point wanders at first sight, and after `focusTime` s of steady tracking */
  scatter: number; minScatter: number; focusTime: number;
  /** fraction of the true lead used, re-rolled with each aim point: most bots trail a moving target */
  lead: [number, number];
  /** seconds between missile launches */
  missileGap: number;
  /** chance of waiting out the lock on a human; otherwise the bot fires early and the missile flies straight */
  lockPatience: number;
  turn: number; dodge: number;
}
/** Bots shoot like stormtroopers: lots of fire, mostly near misses, and the only way to get tagged is to fly straight and slow. */
export const SKILLS: Record<BotSkill, SkillDef> = {
  easy: { reaction: 0.7, scatter: 24, minScatter: 13, focusTime: 10, lead: [0.1, 1.1], missileGap: 22, lockPatience: 0.25, turn: 0.6, dodge: 0.1 },
  normal: { reaction: 0.45, scatter: 13, minScatter: 6, focusTime: 7, lead: [0.3, 1.15], missileGap: 15, lockPatience: 0.4, turn: 0.8, dodge: 0.35 },
  hard: { reaction: 0.25, scatter: 9, minScatter: 3, focusTime: 4, lead: [0.55, 1.1], missileGap: 9, lockPatience: 0.65, turn: 0.95, dodge: 0.7 },
};
/** Bots fighting each other scatter and mis-lead this much less, so the kill feed and orange drops keep moving between your fights. */
const VS_BOT_SLOPPINESS = 0.25;

export const BOT_NAMES = [
  'Vex', 'Kestrel', 'Nyx', 'Talon', 'Rook', 'Ember', 'Quill', 'Moth', 'Sable', 'Jinx', 'Halcyon', 'Pike',
  'Wren', 'Brisk', 'Cinder', 'Gale', 'Onyx', 'Spindle', 'Torque', 'Lumen', 'Piston', 'Rivet', 'Flint', 'Hex',
];

type Goal = 'hunt' | 'engage' | 'collect' | 'evade' | 'retreat' | 'powerup';

export class BotBrain {
  goal: Goal = 'hunt';
  targetId = -1;
  pickupId = -1;
  private path: V3[] = [];
  private pathIdx = 0;
  private pathGoal = v3();
  private repathTick = 0;
  private seenSince = new Map<number, number>();
  private aimNoise = v3();
  private aimGoal = v3();
  private leadK = 1;
  private noiseTick = 0;
  private focus = 0;
  private focusId = -1;
  private nextMissileTick = 0;
  private holdingSecondary = false;
  private snapTicks = Infinity;
  private strafe = v3(1, 0, 0);
  private strafeTick = 0;
  private secondaryHoldTicks = 0;
  private damageLog: { tick: number; hull: number }[] = [];
  private lastVitals = 0;
  private lastKills = 0;
  private chaseDropsUntil = 0;
  private stuckTicks = 0;
  private rng: Rng;
  private wander: V3 | null = null;

  constructor(public shipId: number, public skill: BotSkill, seed: number) {
    this.rng = new Rng(seed);
  }

  private visibleEnemies(sim: GameSim, me: Ship): Ship[] {
    const out: Ship[] = [];
    for (const s of sim.shipList) {
      if (s.id === me.id || !s.alive) continue;
      if (botCanSee(sim, me, s)) {
        if (!this.seenSince.has(s.id)) this.seenSince.set(s.id, sim.tick);
        out.push(s);
      } else this.seenSince.delete(s.id);
    }
    return out;
  }

  private evaluate(sim: GameSim, me: Ship): void {
    const visible = this.visibleEnemies(sim, me);
    const hullFrac = me.hull / me.def.hull;
    if (me.stats.kills > this.lastKills) { this.chaseDropsUntil = sim.tick + 8 * 60; this.lastKills = me.stats.kills; }

    // target choice: distance, low health, high power (bounty)
    let best: Ship | null = null, bestScore = -Infinity;
    for (const s of visible) {
      // shooting a reflector only hurts the shooter
      if (s.safe || s.powerup === 'reflect') continue;
      const d = vdist(me.pos, s.pos);
      const health = (s.hull + s.shield) / (s.def.hull + s.def.shield);
      const score = -d / 150 + (1 - health) * 1.5 + s.power * 0.25 + (s.id === this.targetId ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = s; }
    }

    // nearest pickup
    let pick: Pickup | null = null, pickD = Infinity;
    if (me.power < MAX_POWER) {
      for (const p of sim.pickups) {
        const d = vdist(me.pos, p.pos) * (p.killerId === me.id && sim.tick < this.chaseDropsUntil ? 0.3 : 1) / p.units;
        if (d < pickD) { pickD = d; pick = p; }
      }
    }
    const enemyD = best ? vdist(me.pos, best.pos) : Infinity;
    const live = sim.powerups.live, powerD = live && !me.powerup ? vdist(me.pos, live.pos) : Infinity;

    if (me.missileWarn > 0) this.goal = 'evade';
    else if (hullFrac < 0.3 && me.power === 0 && best && enemyD < 250) this.goal = 'retreat';
    else if (powerD < 140 || (powerD < 700 && enemyD > 220)) this.goal = 'powerup';
    else if (pick && (sim.tick < this.chaseDropsUntil && pick.killerId === me.id)) this.goal = 'collect';
    else if (best && enemyD < me.def.preferredRange[1] * 1.6) this.goal = 'engage';
    else if (pick && (pickD < 150 || pickD * 2.5 < enemyD)) this.goal = 'collect';
    else this.goal = 'hunt';

    this.targetId = best ? best.id : -1;
    this.pickupId = pick ? pick.id : -1;
  }

  think(sim: GameSim, me: Ship, out: InputCmd): void {
    const sk = SKILLS[this.skill];
    out.tFwd = out.tRight = out.tUp = out.rPitch = out.rYaw = out.rRoll = 0;
    out.flags = InputFlag.AssistOn;
    if (!me.alive) return;
    if (sim.tick % 15 === me.id % 15) this.evaluate(sim, me);

    // track damage for Brute bulwark habit
    const vit = me.hull + me.shield;
    if (vit < this.lastVitals) {
      this.damageLog.push({ tick: sim.tick, hull: this.lastVitals - vit });
      this.focus = Math.max(0, this.focus - 0.2);
    }
    this.lastVitals = vit;
    if (this.goal !== 'engage') this.focus = Math.max(0, this.focus - DT / 3);
    this.damageLog = this.damageLog.filter((d) => sim.tick - d.tick < 60);
    const recentDamage = this.damageLog.reduce((s, d) => s + d.hull, 0);

    const target = this.targetId >= 0 ? sim.ship(this.targetId) : undefined;
    let face: V3 | null = null;
    let move: V3 | null = null; // world-space desired movement direction
    let boost = false;
    const fwd = qrot(v3(), me.rot, v3(0, 0, -1));

    const goTo = (dest: V3) => {
      if (vdist(dest, this.pathGoal) > 30 || sim.tick >= this.repathTick || this.pathIdx >= this.path.length) {
        this.path = sim.nav.path(me.pos, dest);
        this.pathIdx = 0;
        this.pathGoal = { ...dest };
        this.repathTick = sim.tick + 60;
      }
      let wp = this.path[this.pathIdx] ?? dest;
      while (this.pathIdx < this.path.length - 1 && vdist(me.pos, wp) < 18) { this.pathIdx++; wp = this.path[this.pathIdx]!; }
      const d = v3(wp.x - me.pos.x, wp.y - me.pos.y, wp.z - me.pos.z);
      move = vnorm(v3(), d);
      face = move;
      boost = vlen(d) > 120 && vdot(fwd, move) > 0.9;
    };

    switch (this.goal) {
      case 'engage': {
        if (!target || !target.alive) { this.goal = 'hunt'; break; }
        const w = activePrimary(me.def, me.tier);
        const dist = vdist(me.pos, target.pos);
        const tof = dist / w.speed;
        const toT = vnorm(v3(), v3(target.pos.x - me.pos.x, target.pos.y - me.pos.y, target.pos.z - me.pos.z));
        if (target.id !== this.focusId) { this.focusId = target.id; this.focus = 0; }
        this.focus = Math.min(1, this.focus + DT / sk.focusTime);
        if (target.flight.dodgeRollTime > 0 || target.flight.boosting) this.focus = Math.max(0, this.focus - DT * 1.5);
        if (sim.tick >= this.noiseTick) {
          // a fresh aim point in the disc around the target, across the line of sight
          const sloppy = target.isBot ? VS_BOT_SLOPPINESS : 1;
          const spread = (target.def.boundingRadius + sk.scatter + (sk.minScatter - sk.scatter) * this.focus) * sloppy;
          const u = vnorm(v3(), Math.abs(toT.y) < 0.9 ? v3(-toT.z, 0, toT.x) : v3(1, 0, 0));
          const v = v3(toT.y * u.z - toT.z * u.y, toT.z * u.x - toT.x * u.z, toT.x * u.y - toT.y * u.x);
          const a = this.rng.range(0, Math.PI * 2), r = spread * Math.sqrt(this.rng.next());
          const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
          this.aimGoal = v3(u.x * ca + v.x * sa, u.y * ca + v.y * sa, u.z * ca + v.z * sa);
          this.leadK = 1 + (this.rng.range(sk.lead[0], sk.lead[1]) - 1) * sloppy;
          this.noiseTick = sim.tick + this.rng.int(24, 54);
        }
        // the aim point slides rather than jumps, so a burst stitches across and past the target
        const slide = 1 - Math.exp(-DT * 5);
        this.aimNoise = v3(
          this.aimNoise.x + (this.aimGoal.x - this.aimNoise.x) * slide,
          this.aimNoise.y + (this.aimGoal.y - this.aimNoise.y) * slide,
          this.aimNoise.z + (this.aimGoal.z - this.aimNoise.z) * slide,
        );
        const lk = tof * this.leadK;
        const lead = v3(target.pos.x + target.vel.x * lk - me.vel.x * tof * 0.3, target.pos.y + target.vel.y * lk - me.vel.y * tof * 0.3, target.pos.z + target.vel.z * lk - me.vel.z * tof * 0.3);
        face = vnorm(v3(), v3(lead.x + this.aimNoise.x - me.pos.x, lead.y + this.aimNoise.y - me.pos.y, lead.z + this.aimNoise.z - me.pos.z));
        const [lo, hi] = me.def.preferredRange;
        if (sim.tick >= this.strafeTick) {
          const side = vnorm(v3(), v3(this.rng.range(-1, 1), this.rng.range(-0.6, 0.6), this.rng.range(-1, 1)));
          const d = vdot(side, toT);
          this.strafe = vnorm(v3(), v3(side.x - toT.x * d, side.y - toT.y * d, side.z - toT.z * d));
          this.strafeTick = sim.tick + this.rng.int(50, 120);
        }
        const radial = dist > hi ? 1 : dist < lo ? -1 : 0;
        move = vnorm(v3(), v3(toT.x * radial + this.strafe.x * 0.8, toT.y * radial + this.strafe.y * 0.8, toT.z * radial + this.strafe.z * 0.8));
        boost = dist > hi * 1.3;
        const reacted = sim.tick - (this.seenSince.get(target.id) ?? sim.tick) >= sk.reaction / DT;
        // fire wherever it means to aim (mostly not at you); the seeker only cares where the target really is
        const aimErr = Math.acos(clamp(vdot(fwd, face), -1, 1));
        const seekErr = Math.acos(clamp(vdot(fwd, toT), -1, 1));
        const cone = Math.max(6 * DEG, Math.atan2(target.def.boundingRadius + 3, dist));
        if (reacted && aimErr < cone && dist < w.speed * w.life) out.flags |= InputFlag.Primary;
        // secondary: hold to lock, release when locked or after a while
        if (sim.tick >= this.nextMissileTick && (me.ammo > 0 || me.powerup === 'haste') && dist < me.def.secondary.lockRange && seekErr < me.def.secondary.lockConeDeg * DEG) {
          if (this.secondaryHoldTicks === 0) {
            const early = !target.isBot && !this.rng.chance(sk.lockPatience);
            this.snapTicks = early ? this.rng.int(12, Math.max(13, Math.round(me.def.secondary.lockTime * 0.8 / DT))) : Infinity;
          }
          if ((me.lock.locked || this.secondaryHoldTicks >= this.snapTicks) && this.secondaryHoldTicks > 0) this.secondaryHoldTicks = 0;
          else { out.flags |= InputFlag.Secondary; this.secondaryHoldTicks++; }
          if (this.secondaryHoldTicks > 150) this.secondaryHoldTicks = 0;
        } else this.secondaryHoldTicks = 0;
        // class habits
        if (me.abilityCooldown <= 0 && me.abilityActive <= 0) {
          if (me.def.id === 'dart' && dist < 150) out.flags |= InputFlag.Ability;
          if (me.def.id === 'scythe' && dist > 200 && dist < 500) out.flags |= InputFlag.Ability;
          if (me.def.id === 'brute' && recentDamage > 40) out.flags |= InputFlag.Ability;
          if (me.def.id === 'mule') out.flags |= InputFlag.Ability;
        }
        if (me.tier.repel && me.repelCooldown <= 0 && dist < 25) out.flags |= InputFlag.Repel;
        // Scythe ambush: while cloaked, close in and wait to fire from behind
        if (me.cloaked && dist > 60) out.flags &= ~InputFlag.Primary;
        break;
      }
      case 'collect': {
        const p = sim.pickups.find((q) => q.id === this.pickupId);
        if (!p) { this.goal = 'hunt'; break; }
        goTo(p.pos);
        if (vdist(me.pos, p.pos) < 40) boost = false;
        break;
      }
      case 'powerup': {
        const live = sim.powerups.live;
        if (!live || me.powerup) { this.goal = 'hunt'; break; }
        goTo(live.pos);
        if (vdist(me.pos, live.pos) < 50) boost = false;
        break;
      }
      case 'evade': {
        boost = true;
        const threat = sim.missiles.find((m) => m.targetId === me.id && m.tracking);
        if (threat) {
          const away = vnorm(v3(), v3(me.pos.x - threat.pos.x, me.pos.y - threat.pos.y, me.pos.z - threat.pos.z));
          const side = vnorm(v3(), v3(-away.z, 0.3, away.x));
          move = vnorm(v3(), v3(away.x * 0.4 + side.x, away.y * 0.4 + side.y, away.z * 0.4 + side.z));
          face = move;
          if (vdist(threat.pos, me.pos) < 60 && me.flight.dodgeCooldown <= 0 && this.rng.chance(sk.dodge * 0.2)) {
            out.flags |= this.rng.chance(0.5) ? InputFlag.DodgeL : InputFlag.DodgeR;
          }
        } else this.goal = 'hunt';
        if (me.abilityCooldown <= 0 && me.abilityActive <= 0 && (me.def.id === 'mule' || me.def.id === 'brute')) out.flags |= InputFlag.Ability;
        break;
      }
      case 'retreat': {
        const zone = me.safeCharge > 2
          ? sim.arena.safeZones.reduce<{ c: V3; d: number } | null>((best, z) => {
            const d = vdist(me.pos, z.center);
            return !best || d < best.d ? { c: z.center, d } : best;
          }, null)
          : null;
        if (zone && zone.d < 400) this.wander = { ...zone.c };
        else if (!this.wander || vdist(me.pos, this.wander) < 25) {
          const rooms = sim.arena.blueprint.rooms.map((r) => ({
            r, n: sim.shipList.filter((s) => s.alive && s.id !== me.id && vdist(s.pos, r.center) < 120).length,
          })).sort((a, b) => a.n - b.n);
          this.wander = { ...rooms[0]!.r.center };
        }
        goTo(this.wander);
        boost = true;
        break;
      }
      case 'hunt': {
        let dest: V3 | null = null;
        let nearest = Infinity;
        for (const s of sim.shipList) {
          if (s.id === me.id || !s.alive || s.safe || s.powerup === 'reflect') continue;
          const d = vdist(s.pos, me.pos) - s.power * 30;
          if (d < nearest) { nearest = d; dest = s.pos; }
        }
        if (!dest) {
          if (!this.wander || vdist(me.pos, this.wander) < 25) this.wander = sim.nav.randomRoomNode(this.rng);
          dest = this.wander;
        }
        goTo(dest);
        if (me.def.id === 'mule' && me.abilityCooldown <= 0 && me.abilityActive <= 0) out.flags |= InputFlag.Ability;
        if (me.def.id === 'scythe' && nearest < 450 && me.abilityCooldown <= 0 && me.abilityActive <= 0) out.flags |= InputFlag.Ability;
        break;
      }
    }

    // projectile dodge
    if (me.flight.dodgeCooldown <= 0 && sim.tick % 6 === me.id % 6) {
      for (const p of sim.projectiles) {
        if (p.ownerId === me.id) continue;
        const rel = v3(me.pos.x - p.pos.x, me.pos.y - p.pos.y, me.pos.z - p.pos.z);
        const sp = vlen(p.vel);
        const along = vdot(rel, p.vel) / sp;
        if (along < 0 || along > sp * 0.35) continue;
        const perp2 = vdot(rel, rel) - along * along;
        if (perp2 < (me.def.boundingRadius + 1) ** 2 && this.rng.chance(sk.dodge)) {
          out.flags |= this.rng.chance(0.5) ? InputFlag.DodgeL : InputFlag.DodgeR;
          break;
        }
      }
    }

    // feelers: local avoidance against arena geometry, weighted by time to collision
    const speed = vlen(me.vel);
    const look = 8 + speed * 1.1;
    const velDir = speed > 5 ? vnorm(v3(), me.vel) : (move ?? fwd);
    const perp1 = vnorm(v3(), Math.abs(velDir.y) < 0.9 ? v3(-velDir.z, 0, velDir.x) : v3(1, 0, 0));
    const perp2 = vnorm(v3(), v3(velDir.y * perp1.z - velDir.z * perp1.y, velDir.z * perp1.x - velDir.x * perp1.z, velDir.x * perp1.y - velDir.y * perp1.x));
    const avoid = v3();
    let closest = Infinity;
    const feel = (f: V3, weight: number, len: number) => {
      const hit = castStatic(sim.world, me.pos, f, len);
      if (hit < 0) return;
      const k = (1 - hit / len) ** 2 * weight;
      avoid.x -= f.x * k; avoid.y -= f.y * k; avoid.z -= f.z * k;
      if (weight > 1) closest = Math.min(closest, hit);
    };
    feel(velDir, 2.5, look);
    for (const [a, b] of [[perp1, 1], [perp1, -1], [perp2, 1], [perp2, -1]] as const) {
      feel(vnorm(v3(), v3(velDir.x + a.x * b * 0.35, velDir.y + a.y * b * 0.35, velDir.z + a.z * b * 0.35)), 0.8, look * 0.8);
    }
    if (move) {
      const m = move as V3;
      const blended = vnorm(v3(), v3(m.x + avoid.x, m.y + avoid.y, m.z + avoid.z));
      // never fully reverse the goal direction; slide along the obstacle instead
      const d = vdot(blended, m);
      move = d < 0.1 ? vnorm(v3(), v3(blended.x + m.x * (0.1 - d), blended.y + m.y * (0.1 - d), blended.z + m.z * (0.1 - d))) : blended;
    } else if (vlen(avoid) > 0) move = vnorm(v3(), avoid);
    if (closest < 6 + speed * 0.5) { boost = false; if (closest < 4 + speed * 0.25) out.flags |= InputFlag.Brake; }
    if (speed < 3 && this.goal !== 'engage') this.stuckTicks++; else this.stuckTicks = 0;
    if (this.stuckTicks > 120) { this.repathTick = 0; this.stuckTicks = 0; out.flags |= InputFlag.DodgeU; }

    // steering → intents
    if (face) {
      const l = qrotInv(v3(), me.rot, face);
      const yawErr = Math.atan2(l.x, -l.z);
      const pitchErr = Math.atan2(l.y, Math.hypot(l.x, l.z));
      out.rYaw = clamp(yawErr * 3.5, -1, 1) * sk.turn;
      out.rPitch = clamp(pitchErr * 3.5, -1, 1) * sk.turn;
    }
    const wu = qrotInv(v3(), me.rot, v3(0, 1, 0));
    out.rRoll = clamp(Math.atan2(wu.x, wu.y) * 1.5, -1, 1) * 0.7;
    if (move) {
      const lm = qrotInv(v3(), me.rot, move as V3);
      out.tFwd = clamp(-lm.z * 1.5, -1, 1);
      out.tRight = clamp(lm.x * 1.5, -1, 1);
      out.tUp = clamp(lm.y * 1.5, -1, 1);
    }
    if (boost) out.flags |= InputFlag.Boost;
    // letting go of secondary launches, locked or not
    const holding = (out.flags & InputFlag.Secondary) !== 0;
    if (this.holdingSecondary && !holding) this.nextMissileTick = sim.tick + Math.round(sk.missileGap * this.rng.range(0.7, 1.3) / DT);
    this.holdingSecondary = holding;
  }
}

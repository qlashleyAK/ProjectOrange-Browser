import * as THREE from 'three';
import { CLASS_LIST, ORANGE_HEX, POWERUPS, PRIMARY_TABLE, type GameEvent, type PrimaryDef } from '@orange/shared';
import { audio } from '../audio/audio';
import type { SoundName } from '../audio/sounds';
import type { CameraRig } from '../render/camera';
import type { Effects } from '../render/effects';
import type { ShipRenderer } from '../render/ships';
import { settings } from '../settings';
import type { ShipView } from '../view';

const WEAPONS = new Map<string, PrimaryDef>(PRIMARY_TABLE.map((w) => [w.id, w]));
const SECONDARIES = new Map(CLASS_LIST.map((c) => [c.secondary.id, c.secondary]));

const SHOT_SOUND: Record<string, SoundName> = { bolt: 'zap', pellet: 'shotgun', spine: 'shriek', flak: 'thump', slug: 'slug' };
const LAUNCH_SOUND: Record<string, SoundName> = { missile: 'missileLaunch', swarm: 'swarmLaunch', torpedo: 'torpedoLaunch' };

const WHITE = 0xffffff, CYAN = 0x9fe8ff, VIOLET = 0xb48cff, SHIELD = 0x7fc4ff;

const v = (p: { x: number; y: number; z: number }, out = new THREE.Vector3()) => out.set(p.x, p.y, p.z);

/** Maps gameplay events to visual effects, camera trauma and positional audio. Purely cosmetic. */
export class Presenter {
  private scrapeAt = 0;
  private lastLock = 0;
  private tmp = new THREE.Vector3();

  constructor(
    private effects: Effects, private ships: ShipRenderer, private cam: CameraRig, private camera: THREE.Camera,
  ) {}

  present(e: GameEvent, localId: number, views: Map<number, ShipView>, now: number): void {
    const fx = this.effects;
    const flashScale = settings.reduceFlashing ? 0.45 : 1;
    switch (e.t) {
      case 'shot': {
        const w = WEAPONS.get(e.weapon);
        if (!w) return;
        const p = v(e.pos);
        fx.flash(p, w.color, 0.4, w.visual === 'flak' || w.visual === 'pellet' ? 2.2 : 1.4, 0.06, { light: w.visual === 'bolt' ? 0 : 0.5, follow: this.ships.rootOf(e.ownerId) ?? undefined });
        const mine = e.ownerId === localId;
        audio.play(w.id === 'flakStorm' ? 'flakStorm' : SHOT_SOUND[w.visual] ?? 'zap', mine ? { gain: 0.55, bus: 'sfx' } : { pos: e.pos, gain: 0.8 });
        break;
      }
      case 'projEnd': {
        if (e.reason === 'world') {
          const p = v(e.pos);
          fx.sparksAt(p, null, CYAN, 6, 14, 0.25);
          if (this.camera.position.distanceTo(p) < 120) audio.play('worldPing', { pos: e.pos, gain: 0.25 });
        } else if (e.reason === 'proximity' || e.reason === 'repel') {
          fx.flash(v(e.pos), WHITE, 0.5, 3, 0.15, { tell: true, intensity: flashScale });
        }
        break;
      }
      case 'missileSpawn': {
        const sec = SECONDARIES.get(e.kind);
        audio.play(LAUNCH_SOUND[sec?.kind ?? 'missile'] ?? 'missileLaunch', e.ownerId === localId ? { gain: 0.7 } : { pos: e.pos });
        fx.smokeAt(v(e.pos), v(e.vel).multiplyScalar(0.1), 1.2, 0.8);
        break;
      }
      case 'missileEnd': {
        const p = v(e.pos);
        if (e.reason === 'expire') { fx.flash(p, WHITE, 0.5, 2, 0.15, { intensity: flashScale }); break; }
        const big = e.reason === 'torpedo';
        fx.flash(p, big ? VIOLET : WHITE, 1, big ? 22 : 9, big ? 0.5 : 0.3, { tell: true, intensity: flashScale, light: big ? 4 : 2 });
        fx.sphere(p, big ? VIOLET : CYAN, 1, big ? 18 : 7, big ? 0.45 : 0.3, 0.5, { tell: true });
        fx.sparksAt(p, null, WHITE, big ? 40 : 18, big ? 40 : 25, 0.5);
        fx.smokeAt(p, new THREE.Vector3(), big ? 6 : 3, 1.6);
        audio.play(big ? 'bigExplosion' : 'explosion', { pos: e.pos });
        this.shakeFrom(p, big ? 0.6 : 0.3, big ? 60 : 30);
        break;
      }
      case 'hit': {
        const p = v(e.pos);
        const target = views.get(e.targetId);
        if (e.weapon === 'reflect') {
          const g = POWERUPS.reflect.color;
          fx.flash(p, g, 1, 7, 0.25, { tell: true, intensity: flashScale, light: 2 });
          fx.sparksAt(p, null, g, 18, 30, 0.4);
          const holder = views.get(e.attackerId);
          if (holder) fx.ring(v(holder.pos), null, g, 3, 9, 0.3, 0.8, { tell: true });
          audio.play('reflectZap', e.targetId === localId || e.attackerId === localId ? { gain: 0.8 } : { pos: e.pos, gain: 0.8 });
        } else if (views.get(e.attackerId)?.powerup === 'quad' && e.shield + e.hull > 0) fx.sparksAt(p, null, POWERUPS.quad.color, 10, 26, 0.35);
        if (e.shield > 0 && target) {
          const root = this.ships.rootOf(e.targetId);
          const dir = target ? this.tmp.copy(p).sub(v(target.pos)).normalize().clone() : new THREE.Vector3(0, 0, 1);
          fx.shieldHit(() => (root ? root.position : null), 4, dir, Math.min(1, (e.shield + e.hull) / 30) * flashScale + 0.2);
        }
        if (e.hull > 0) {
          fx.sparksAt(p, null, WHITE, 8, 18, 0.3);
          if (e.hull > 15) fx.debrisAt(p, target ? v(target.vel) : new THREE.Vector3(), 0x555a60, 2, 6, 0.5);
        }
        if (e.targetId === localId) {
          audio.play(e.hull > 0 ? 'hullHit' : 'shieldHit', { gain: 0.9 });
          this.cam.addTrauma(0.25);
        } else if (e.attackerId === localId) {
          audio.play('hitMarker', { bus: 'ui', gain: 0.5 });
        } else {
          audio.play(e.hull > 0 ? 'hullHit' : 'shieldHit', { pos: e.pos, gain: 0.5 });
        }
        break;
      }
      case 'splash': {
        const w = WEAPONS.get(e.weapon);
        const p = v(e.pos);
        const color = w?.color ?? WHITE;
        fx.flash(p, color, 1, e.radius * 0.9, 0.25, { tell: true, intensity: flashScale, light: 1.5 });
        fx.sphere(p, color, 0.5, e.radius, 0.3, 0.35, { tell: true });
        audio.play('splash', { pos: e.pos });
        this.shakeFrom(p, 0.2, e.radius * 3);
        break;
      }
      case 'death': {
        const p = v(e.pos);
        const vel = v(e.vel);
        const big = e.classId === 'brute';
        fx.flash(p, WHITE, 2, big ? 30 : 20, 0.55, { tell: true, intensity: flashScale, light: 5 });
        fx.sphere(p, CYAN, 1, big ? 22 : 15, 0.5, 0.55, { tell: true });
        fx.ring(p, null, VIOLET, 2, big ? 40 : 28, 0.6, 0.8, { tell: true });
        fx.sparksAt(p, null, WHITE, 50, 45, 0.7);
        fx.debrisAt(p, vel, 0x4a4f58, big ? 18 : 12, 18, big ? 1.4 : 1);
        fx.smokeAt(p, vel.multiplyScalar(0.3), big ? 8 : 5, 2.5);
        audio.play('bigExplosion', { pos: e.pos, gain: 1.1 });
        if (e.killerId === localId && e.victimId !== localId) audio.play('killConfirm', { bus: 'ui' });
        if (e.victimId === localId) { audio.play('death', { bus: 'ui' }); this.cam.addTrauma(0.6); }
        else this.shakeFrom(p, 0.5, 80);
        if (e.dropped > 0) audio.play('dropTinkle', { pos: e.pos, gain: 0.6 });
        break;
      }
      case 'pickupTake': {
        if (e.shipId === localId) audio.play('pickup', { bus: 'ui', rate: 1 + Math.min(0.3, e.units * 0.05) });
        fx.flash(v(e.pos), ORANGE_HEX, 0.6, 3, 0.18, { tell: true, intensity: flashScale });
        break;
      }
      case 'powerupSpawn': {
        const c = POWERUPS[e.kind].color;
        fx.flash(v(e.pos), c, 1.2, 10, 0.4, { tell: true, intensity: flashScale, light: 3 });
        fx.ring(v(e.pos), null, c, 2, 16, 0.5, 0.8, { tell: true });
        audio.play('powerupSpawn', { pos: e.pos, gain: 0.8 });
        break;
      }
      case 'powerupTake': {
        const c = POWERUPS[e.kind].color;
        const p = v(e.pos);
        fx.flash(p, c, 1.4, 12, 0.45, { tell: true, intensity: flashScale, light: 3 });
        fx.ring(p, null, c, 2, 18, 0.55, 0.9, { tell: true });
        audio.play('powerup', e.shipId === localId ? { bus: 'ui', gain: 0.9 } : { pos: e.pos, gain: 0.8 });
        break;
      }
      case 'powerupEnd':
        if (e.shipId === localId && e.reason !== 'reset') audio.play('powerdown', { bus: 'ui', gain: 0.7 });
        break;
      case 'tier':
        if (e.shipId === localId) audio.play(e.gained ? 'tierUp' : 'tierDown', { bus: 'ui' });
        break;
      case 'ability': {
        const mine = e.shipId === localId;
        const o = mine ? { gain: 0.8 } : { pos: e.pos };
        switch (e.ability) {
          case 'overdrive': if (e.on) audio.play('overdrive', o); break;
          case 'sweep': if (e.on) audio.play('sweep', o); break;
          case 'cloak': audio.play(e.on ? 'cloakOn' : 'cloakOff', o); if (!e.on) fx.flash(v(e.pos), VIOLET, 1, 6, 0.25, { tell: true, intensity: flashScale }); break;
          case 'bulwark': if (e.on) audio.play('bulwarkUp', o); break;
        }
        break;
      }
      case 'repel': {
        const p = v(e.pos);
        fx.ring(p, null, CYAN, 2, e.radius, 0.45, 0.9, { tell: true });
        fx.sphere(p, CYAN, 2, e.radius * 0.8, 0.35, 0.25, { tell: true });
        audio.play('repel', e.shipId === localId ? {} : { pos: e.pos });
        if (e.shipId === localId) this.cam.addTrauma(0.4); else this.shakeFrom(p, 0.4, e.radius);
        break;
      }
      case 'sweep': fx.ring(v(e.pos), null, VIOLET, 5, e.radius, 1.2, 0.6, { tell: true }); break;
      case 'bulwarkHit':
        this.ships.bulwarkRipple(e.shipId);
        audio.play(e.remaining <= 0 ? 'bulwarkBreak' : 'bulwarkAbsorb', { pos: e.pos, gain: 0.7 });
        if (e.remaining <= 0) fx.sparksAt(v(e.pos), null, SHIELD, 30, 25, 0.5);
        break;
      case 'dodge': {
        const s = views.get(e.shipId);
        if (s) audio.play('dodge', e.shipId === localId ? { gain: 0.6 } : { pos: s.pos, gain: 0.6 });
        break;
      }
      case 'spawn': {
        const p = v(e.pos);
        fx.flash(p, CYAN, 1, 10, 0.45, { tell: true, intensity: flashScale, light: 2 });
        fx.ring(p, null, CYAN, 1, 14, 0.5, 0.8, { tell: true });
        audio.play('spawn', e.shipId === localId ? { bus: 'ui' } : { pos: e.pos });
        break;
      }
      case 'scrape': {
        if (now - this.scrapeAt < 0.12) break;
        this.scrapeAt = now;
        const p = v(e.pos);
        fx.sparksAt(p, null, WHITE, 10, 12, 0.3);
        audio.play('scrape', e.shipId === localId ? { gain: Math.min(1, e.force / 2e6 + 0.3) } : { pos: e.pos, gain: 0.5 });
        if (e.shipId === localId) this.cam.addTrauma(0.15);
        break;
      }
      case 'phase':
        if (e.phase === 'inProgress') audio.play('go', { bus: 'ui' });
        break;
      case 'lockOn':
        if (e.targetId === localId && now - this.lastLock > 0.5) { this.lastLock = now; audio.play('lockSolid', { bus: 'ui', gain: 0.8 }); }
        else if (e.shipId === localId) audio.play('lockSolid', { bus: 'ui', gain: 0.5 });
        break;
      default: break;
    }
  }

  private shakeFrom(p: THREE.Vector3, amount: number, range: number): void {
    const d = this.camera.position.distanceTo(p);
    if (d < range) this.cam.addTrauma(amount * (1 - d / range));
  }
}

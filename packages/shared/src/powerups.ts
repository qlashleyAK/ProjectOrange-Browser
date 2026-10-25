import type * as RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { boxDistance, doorClearanceBox, type ArenaData } from './arena/generate.js';
import { moverClearance } from './arena/movers.js';
import { DT } from './constants.js';
import type { Ship } from './entities.js';
import type { FlightOptions } from './flight.js';
import type { GameSim } from './game.js';
import { v3, vdist, type V3 } from './math.js';
import type { PowerupInfo } from './net/messages.js';
import { sphereFree } from './physicsWorld.js';

export type PowerupKind = 'quad' | 'reflect' | 'haste' | 'speed';
export const POWERUP_KINDS: readonly PowerupKind[] = ['quad', 'reflect', 'haste', 'speed'];

export interface PowerupDef { kind: PowerupKind; name: string; short: string; color: number; blurb: string }
export const POWERUPS: Record<PowerupKind, PowerupDef> = {
  quad: { kind: 'quad', name: 'Quad Damage', short: 'QUAD', color: 0xff2448, blurb: 'every shot hits four times as hard' },
  reflect: { kind: 'reflect', name: 'Quad Reflect', short: 'REFLECT', color: 0x3dff5c, blurb: 'whoever hits you takes four times the damage back' },
  haste: { kind: 'haste', name: 'Quad Haste', short: 'HASTE', color: 0xb04cff, blurb: 'four times the fire rate, free energy and missiles' },
  speed: { kind: 'speed', name: 'Quad Speed', short: 'SPEED', color: 0xfff23a, blurb: 'four times the thrust, double top speed, endless boost' },
};

export const POWERUP_DURATION_S = 30;
/** after a powerup is taken, the next one appears this long later, whether or not the first has run out */
export const POWERUP_RESPAWN_S = 10;
/** pickup reach beyond the ship's bounding radius */
export const POWERUP_RADIUS = 5;
export const QUAD_DAMAGE = 4;
export const REFLECT_MULT = 4;
export const HASTE_CADENCE = 4;
export const HASTE_LOCK = 2;
export const SPEED_THRUST = 4;
/** top speed only doubles: four times would outrun most of the game's shots */
export const SPEED_TOP = 2;

export interface LivePowerup { id: number; kind: PowerupKind; pos: V3 }
export interface PowerupState {
  live: LivePowerup | null;
  /** while none is live: the tick the next appears and where */
  nextTick: number;
  nextSpot: number;
  lastKind: PowerupKind | null;
  id: number;
}
export function newPowerupState(): PowerupState { return { live: null, nextTick: 0, nextSpot: 0, lastKind: null, id: 0 }; }

export const powerupIndex = (k: PowerupKind | null): number => (k ? POWERUP_KINDS.indexOf(k) + 1 : 0);
export const powerupFromIndex = (i: number): PowerupKind | null => POWERUP_KINDS[i - 1] ?? null;
/** ShipFlag bits 11-13 */
export const POWERUP_FLAG_SHIFT = 11;
export const powerupFlags = (k: PowerupKind | null): number => powerupIndex(k) << POWERUP_FLAG_SHIFT;
export const powerupFromFlags = (flags: number): PowerupKind | null => powerupFromIndex((flags >> POWERUP_FLAG_SHIFT) & 7);

/** Flight options for a ship's overdrive and powerup state (shared by sim and client prediction). */
export function powerupFlight(overdrive: boolean, k: PowerupKind | null): FlightOptions {
  if (k !== 'speed') return { noBoostDrain: overdrive };
  return { noBoostDrain: true, thrustMult: SPEED_THRUST, speedMult: SPEED_TOP };
}

/**
 * Where powerups appear, in rotation order: the blueprint's own spots, else one per room as near its center
 * as is open, out of movers' paths, safe zones, doorways and spawn points.
 */
export function findPowerupSpots(world: RAPIER.World, arena: ArenaData): V3[] {
  const bp = arena.blueprint;
  if (bp.powerups?.length) return bp.powerups.map((p) => ({ ...p }));
  const ok = (p: V3) => sphereFree(world, p, 7)
    && moverClearance(arena.sweeps, p) > 14
    && !arena.safeZones.some((z) => vdist(z.center, p) < z.radius + 12)
    && !arena.doorways.some((d) => boxDistance(doorClearanceBox(d), p) < 6)
    && !arena.spawns.some((s) => vdist(s.pos, p) < 30);
  const out: V3[] = [];
  for (const r of bp.rooms) {
    const step = 4, n = (s: number) => Math.floor((s * 0.3) / step);
    const nx = n(r.size.x), ny = n(r.size.y), nz = n(r.size.z);
    const cands: { p: V3; d: number }[] = [];
    for (let i = -nx; i <= nx; i++) for (let j = -ny; j <= ny; j++) for (let k = -nz; k <= nz; k++) {
      cands.push({ p: v3(r.center.x + i * step, r.center.y + j * step, r.center.z + k * step), d: i * i + k * k + j * j * 2 });
    }
    cands.sort((a, b) => a.d - b.d);
    const hit = cands.find((c) => ok(c.p));
    if (hit) out.push(hit.p);
  }
  return out;
}

export function hasPowerup(s: { powerup: PowerupKind | null }, k: PowerupKind): boolean { return s.powerup === k; }

/** Seconds of powerup left. */
export function powerupLeft(sim: GameSim, s: Ship): number { return s.powerup ? Math.max(0, (s.powerupUntil - sim.tick) * DT) : 0; }

export function losePowerup(sim: GameSim, s: Ship, reason: 'expire' | 'death' | 'reset'): void {
  if (!s.powerup) return;
  const kind = s.powerup;
  s.powerup = null; s.powerupUntil = 0;
  sim.emit({ t: 'powerupEnd', shipId: s.id, kind, reason });
}

/** New round or map: nothing live, nobody holding, the first appears as soon as the match is on. */
export function resetPowerups(sim: GameSim): void {
  const st = sim.powerups;
  for (const s of sim.shipList) losePowerup(sim, s, 'reset');
  if (st.live) sim.emit({ t: 'powerupClear' });
  st.live = null;
  st.nextTick = sim.tick;
  st.lastKind = null;
  st.nextSpot = sim.arena.powerupSpots.length ? sim.rng.int(0, sim.arena.powerupSpots.length) : 0;
}

/** The spot the next powerup will appear at. */
export function nextPowerupSpot(sim: GameSim): V3 | null {
  const spots = sim.arena.powerupSpots;
  return spots.length ? spots[sim.powerups.nextSpot % spots.length]! : null;
}

export function powerupInfo(sim: GameSim): PowerupInfo {
  const st = sim.powerups, next = nextPowerupSpot(sim);
  if (st.live) return { live: { id: st.live.id, kind: st.live.kind, pos: { ...st.live.pos } }, next: null };
  return { live: null, next: sim.match.phase === 'inProgress' && next ? { tick: st.nextTick, pos: { ...next } } : null };
}

function spawnPowerup(sim: GameSim): void {
  const st = sim.powerups, pos = nextPowerupSpot(sim);
  if (!pos) return;
  const kinds = POWERUP_KINDS.filter((k) => k !== st.lastKind);
  const kind = kinds[sim.rng.int(0, kinds.length)]!;
  st.id = (st.id + 1) & 0xffff;
  st.live = { id: st.id, kind, pos: { ...pos } };
  st.lastKind = kind;
  st.nextSpot = (st.nextSpot + 1) % sim.arena.powerupSpots.length;
  sim.emit({ t: 'powerupSpawn', id: st.id, kind, pos: { ...pos } });
}

export function updatePowerups(sim: GameSim): void {
  for (const s of sim.shipList) if (s.powerup && sim.tick >= s.powerupUntil) losePowerup(sim, s, 'expire');
  if (sim.match.phase !== 'inProgress') return;
  const st = sim.powerups;
  if (!st.live) {
    if (sim.tick >= st.nextTick) spawnPowerup(sim);
    return;
  }
  const live = st.live;
  let best: Ship | null = null, bestD = Infinity;
  for (const s of sim.shipList) {
    if (!s.alive || s.powerup) continue;
    const d = vdist(s.pos, live.pos) - s.def.boundingRadius;
    if (d < bestD) { bestD = d; best = s; }
  }
  if (!best || bestD > POWERUP_RADIUS) return;
  best.powerup = live.kind;
  best.powerupUntil = sim.tick + Math.round(POWERUP_DURATION_S / DT);
  sim.endSpawnProtection(best);
  st.live = null;
  st.nextTick = sim.tick + Math.round(POWERUP_RESPAWN_S / DT);
  const next = nextPowerupSpot(sim)!;
  sim.emit({
    t: 'powerupTake', id: live.id, shipId: best.id, kind: live.kind, pos: { ...live.pos }, until: best.powerupUntil,
    nextTick: st.nextTick, nextPos: { ...next },
  });
}

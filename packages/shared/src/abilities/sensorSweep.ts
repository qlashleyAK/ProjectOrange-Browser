import { DT } from '../constants.js';
import type { Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { vdistSq } from '../math.js';

export const SWEEP_RADIUS = 300;

export function activateSweep(sim: GameSim, s: Ship): void {
  s.sweepUntil = sim.tick + Math.round(s.def.ability.duration / DT);
  sim.emit({ t: 'sweep', shipId: s.id, pos: { ...s.pos }, radius: SWEEP_RADIUS });
  const r2 = SWEEP_RADIUS * SWEEP_RADIUS;
  for (const o of sim.shipList) {
    if (o.id === s.id || !o.alive) continue;
    if (vdistSq(o.pos, s.pos) <= r2 && o.cloaked) sim.breakCloak(o);
    // break every lock on the Mule
    if (o.lock.targetId === s.id) { o.lock.targetId = -1; o.lock.progress = 0; o.lock.locked = false; }
  }
  for (const m of sim.missiles) if (m.targetId === s.id) m.tracking = false;
  updateSweepReveal(sim, s);
}

export function updateSweepReveal(sim: GameSim, s: Ship): void {
  s.sweepRevealed.clear();
  if (sim.tick >= s.sweepUntil || !s.alive) return;
  const r2 = SWEEP_RADIUS * SWEEP_RADIUS;
  for (const o of sim.shipList) {
    if (o.id !== s.id && o.alive && vdistSq(o.pos, s.pos) <= r2) s.sweepRevealed.add(o.id);
  }
}

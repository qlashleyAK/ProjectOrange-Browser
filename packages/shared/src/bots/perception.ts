import { BOT_CLOAK_SIGHT_RANGE, BOT_SIGHT_RANGE, CLOAK_REVEAL_RANGE } from '../constants.js';
import type { Ship } from '../entities.js';
import type { GameSim } from '../game.js';
import { vdist } from '../math.js';
import { lineOfSight } from '../physicsWorld.js';

/** Visibility rule shared by interest management and locks: cloaked ships are hidden beyond 60 m unless swept. */
export function cloakVisible(obs: Ship, t: Ship): boolean {
  if (!t.cloaked) return true;
  if (obs.sweepRevealed.has(t.id)) return true;
  return vdist(obs.pos, t.pos) <= CLOAK_REVEAL_RANGE;
}

/** Bot perception: line of sight within 600 m; cloaked only within 35 m or right after firing. */
export function botCanSee(sim: GameSim, bot: Ship, t: Ship): boolean {
  if (!t.alive || t.id === bot.id) return false;
  const d = vdist(bot.pos, t.pos);
  if (d > BOT_SIGHT_RANGE) return false;
  if (t.cloaked && !bot.sweepRevealed.has(t.id) && d > BOT_CLOAK_SIGHT_RANGE && sim.tick - t.lastFireTick > 30) return false;
  if (bot.sweepRevealed.has(t.id)) return true;
  return lineOfSight(sim.world, bot.pos, t.pos);
}

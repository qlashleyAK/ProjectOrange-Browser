/**
 * Long bot soak: `pnpm soak [minutes] [skill] [arena | rotation]`.
 * Runs 8 bots in one sim and fails on crashes, runaway entity counts, NaNs, or ships stuck out of bounds.
 * `rotation` starts on the default map and moves through all of them, a match each.
 */
import {
  DEFAULT_ARENA, DROP_CAP, GameSim, PROJECTILE_CAP_PER_SHIP, WORLD_ORANGE_CAP, arenaById, boxContains, initPhysics, isArenaId,
  nextInRotation, type BotSkill,
} from '../src/index.js';

declare const process: { argv: string[]; exit(code: number): never };

const minutes = Number(process.argv[2] ?? 10);
const skill = (process.argv[3] ?? 'normal') as BotSkill;
const arenaId = process.argv[4] ?? 'hollowdeep';
const rotate = arenaId === 'rotation';
if (!rotate && !isArenaId(arenaId)) { console.error(`unknown arena ${arenaId}`); process.exit(1); }
// Fail loudly on a bad skill instead of crashing deep in the first bot's
// steering: SKILLS[bad] is undefined and the error is mysterious.
const VALID_SKILLS: readonly BotSkill[] = ['easy', 'normal', 'hard'];
if (!VALID_SKILLS.includes(skill)) { console.error(`unknown skill ${JSON.stringify(String(skill))} (expected ${VALID_SKILLS.join(' | ')})`); process.exit(1); }

await initPhysics();
const sim = new GameSim({
  arena: arenaById(rotate ? DEFAULT_ARENA : arenaId), offline: true, seed: Date.now() & 0xffff, botSkill: skill,
  nextArena: rotate ? nextInRotation : undefined,
});
const maps = new Set<string>();
for (let i = 0; i < 8; i++) sim.addBot();

const ticks = Math.round(minutes * 60 * 60);
let deaths = 0, pickups = 0, matches = 0, maxProj = 0, maxMissiles = 0, maxPickups = 0, worstTick = 0;
let aliveTicks = 0, safeTicks = 0;
const problems: string[] = [];
const t0 = performance.now();
for (let i = 0; i < ticks; i++) {
  const s0 = performance.now();
  sim.step();
  worstTick = Math.max(worstTick, performance.now() - s0);
  for (const e of sim.drainEvents()) {
    if (e.t === 'death') deaths++;
    else if (e.t === 'pickupTake') pickups++;
    else if (e.t === 'matchEnd') matches++;
  }
  maxProj = Math.max(maxProj, sim.projectiles.length);
  maxMissiles = Math.max(maxMissiles, sim.missiles.length);
  maxPickups = Math.max(maxPickups, sim.pickups.length);
  for (const s of sim.shipList) if (s.alive) { aliveTicks++; if (s.safe) safeTicks++; }
  maps.add(sim.arena.blueprint.name);
  const pickupCap = (sim.arena.blueprint.oranges?.cap ?? WORLD_ORANGE_CAP) + DROP_CAP;
  if (sim.pickups.length > pickupCap && !problems.some((p) => p.startsWith('pickups'))) {
    problems.push(`pickups reached ${sim.pickups.length} on ${sim.arena.blueprint.name} (cap ${pickupCap})`);
  }
  if (i % 600 === 0) {
    for (const s of sim.shipList) {
      if (!s.alive) continue;
      if (![s.pos.x, s.pos.y, s.pos.z].every(Number.isFinite)) problems.push(`tick ${sim.tick}: ${s.name} has a non-finite position`);
      else if (!boxContains(sim.arena.bounds, s.pos, 5)) problems.push(`tick ${sim.tick}: ${s.name} escaped ${sim.arena.blueprint.name} at ${JSON.stringify(s.pos)}`);
    }
  }
  if (i > 0 && i % (60 * 60) === 0) {
    const m = i / 3600;
    console.log(`${m.toFixed(0)} min · deaths ${deaths} · pickups ${pickups} · matches ${matches} · ${((performance.now() - t0) / i).toFixed(3)} ms/tick`);
  }
}
const ms = (performance.now() - t0) / ticks;
if (maxProj > PROJECTILE_CAP_PER_SHIP * sim.shipList.length) problems.push(`projectiles peaked at ${maxProj}`);
if (deaths === 0) problems.push('no deaths: bots are not fighting');
if (pickups === 0) problems.push('no pickups: bots are not collecting');
const safeShare = aliveTicks ? safeTicks / aliveTicks : 0;
if (safeShare > 0.15) problems.push(`bots spent ${(safeShare * 100).toFixed(0)}% of their time protected in safe zones`);

console.log(`\n${minutes} min soak on ${[...maps].join(' → ')} (${skill}): ${deaths} deaths, ${pickups} pickups, ${matches} matches finished`);
console.log(`peaks: ${maxProj} projectiles, ${maxMissiles} missiles, ${maxPickups} pickups`);
if (safeTicks) console.log(`time protected in safe zones: ${(safeShare * 100).toFixed(1)}%`);
console.log(`sim cost: ${ms.toFixed(3)} ms/tick average, ${worstTick.toFixed(2)} ms worst`);
if (problems.length) {
  console.error(`\nFAILED:\n  ${problems.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log('OK');

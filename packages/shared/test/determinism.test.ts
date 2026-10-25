import { beforeAll, describe, expect, it } from 'vitest';
import { GameSim, generateArena, gyre, hollowdeep, initPhysics, type ArenaData } from '../src/index.js';

let arena: ArenaData;
let gyreArena: ArenaData;
beforeAll(async () => { await initPhysics(); arena = generateArena(hollowdeep()); gyreArena = generateArena(gyre()); });

function run(seed: number, ticks: number, a = arena): string[] {
  const sim = new GameSim({ arena: a, offline: true, seed, botSkill: 'hard' });
  for (let i = 0; i < 6; i++) sim.addBot();
  const trace: string[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    if (i % 30 === 0) {
      trace.push(sim.shipList.map((s) => `${s.id}:${s.alive ? 1 : 0}:${s.pos.x},${s.pos.y},${s.pos.z}:${s.rot.w}:${s.hull}:${s.power}:${s.safeCharge}`).join('|')
        + `#p${sim.projectiles.length}m${sim.missiles.length}o${sim.pickups.length}`);
    }
  }
  sim.world.free();
  return trace;
}

describe('determinism', () => {
  it('identical seeds produce bit-identical simulations (bots, physics, combat, pickups)', () => {
    const a = run(4242, 60 * 30);
    const b = run(4242, 60 * 30);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(b[i], `diverged at sample ${i}`).toBe(a[i]);
  });

  it('stays bit-identical with moving machinery and safe zones', () => {
    const a = run(77, 60 * 30, gyreArena);
    const b = run(77, 60 * 30, gyreArena);
    for (let i = 0; i < a.length; i++) expect(b[i], `diverged at sample ${i}`).toBe(a[i]);
  });

  it('different seeds diverge', () => {
    expect(run(1, 600).at(-1)).not.toBe(run(2, 600).at(-1));
  });
});

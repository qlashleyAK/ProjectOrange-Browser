import { hollowdeep, type Blueprint } from './blueprint.js';
import { generateArena, type ArenaData } from './generate.js';
import { gyre } from './gyre.js';

export interface ArenaInfo { id: string; name: string; blurb: string; blueprint: () => Blueprint }

export const ARENAS: ArenaInfo[] = [
  { id: 'hollowdeep', name: 'Hollowdeep Mine', blurb: 'Six tight rooms, tunnels and a sewer', blueprint: hollowdeep },
  { id: 'gyre', name: 'The Gyre', blurb: 'Five huge halls, moving machinery, safe-zone spawns', blueprint: gyre },
];
export const DEFAULT_ARENA = 'hollowdeep';

export function isArenaId(id: unknown): id is string { return typeof id === 'string' && ARENAS.some((a) => a.id === id); }
export function arenaInfo(id: string): ArenaInfo { return ARENAS.find((a) => a.id === id) ?? ARENAS[0]!; }

const cache = new Map<string, ArenaData>();
/** Generated arena for an id (unknown ids fall back to the default). Generation is deterministic, so it is shared. */
export function arenaById(id: string): ArenaData {
  const info = arenaInfo(isArenaId(id) ? id : DEFAULT_ARENA);
  let a = cache.get(info.id);
  if (!a) { a = generateArena(info.blueprint()); cache.set(info.id, a); }
  return a;
}

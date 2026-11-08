/**
 * Balance evidence: paired bot-vs-bot A/B sims of a proposed tuning change.
 *
 * Every seed is played twice — once on current tuning (A), once with the proposal applied (B) — as a
 * full FFA match of 8 bots, two of each ship, pinned to their ship. Same seed, same map, same bot brains:
 * the only systematic difference between A and B is the change. Per-ship numbers are compared pairwise,
 * so the report can say whether a delta clears the match-to-match noise.
 */
import { CLASSES, CLASS_IDS, DT, GameSim, arenaById, standings, type BotSkill, type ClassId } from '../src/index.js';

export type Op = '=' | '*=' | '+=';
export interface Change { path: string; op: Op; value: number }
export interface Proposal { ship: ClassId; changes: Change[] }

const CHANGE_RE = /^([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*)(\*=|\+=|=)(-?\d+(?:\.\d+)?)$/;

/** Every numeric stat on a ship definition, as a dotted path (`hull`, `primary.damage`, `tiers.3.cadence`). */
export function numericPaths(o: unknown, prefix = ''): string[] {
  const out: string[] = [];
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number') out.push(p);
      else if (v && typeof v === 'object') out.push(...numericPaths(v, p));
    }
  }
  return out;
}

function resolve(ship: ClassId, path: string): { parent: Record<string, unknown>; key: string } | null {
  const parts = path.split('.');
  let cur: unknown = CLASSES[ship];
  for (const part of parts.slice(0, -1)) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  const key = parts.at(-1)!;
  if (!cur || typeof cur !== 'object' || typeof (cur as Record<string, unknown>)[key] !== 'number') return null;
  return { parent: cur as Record<string, unknown>, key };
}

/** `["brute", "hull=220", "primary.damage*=1.1"]` → Proposal. Throws a message fit to post back to the requester. */
export function parseProposal(tokens: string[]): Proposal {
  const [shipTok, ...rest] = tokens;
  const ship = (shipTok ?? '').toLowerCase() as ClassId;
  if (!CLASS_IDS.includes(ship)) throw new Error(`unknown ship ${JSON.stringify(shipTok ?? '')} (expected ${CLASS_IDS.join(' | ')})`);
  if (!rest.length) throw new Error('no change given — e.g. `hull=220`, `primary.damage*=1.1`, `maxSpeed.fwd+=5`');
  if (rest.length > 8) throw new Error('at most 8 changes per run');
  const changes = rest.map((tok) => {
    const m = CHANGE_RE.exec(tok);
    if (!m) throw new Error(`can't read ${JSON.stringify(tok)} — write stat=value, stat*=factor or stat+=delta`);
    const [, path, op, num] = m as unknown as [string, string, Op, string];
    if (!resolve(ship, path)) {
      const near = numericPaths(CLASSES[ship]).filter((p) => p.toLowerCase().includes(path.split('.').at(-1)!.toLowerCase())).slice(0, 8);
      throw new Error(`${ship} has no numeric stat "${path}"${near.length ? ` — did you mean ${near.map((p) => `\`${p}\``).join(', ')}?` : ''}`);
    }
    return { path, op, value: Number(num) };
  });
  return { ship, changes };
}

/** Apply a proposal to the live ship definitions; returns the undo. Rejects non-finite or negative results. */
export function applyProposal(p: Proposal): () => void {
  const undo: (() => void)[] = [];
  try {
    for (const c of p.changes) {
      const r = resolve(p.ship, c.path)!;
      const old = r.parent[r.key] as number;
      const next = c.op === '=' ? c.value : c.op === '*=' ? old * c.value : old + c.value;
      if (!Number.isFinite(next) || next < 0) throw new Error(`${c.path} would become ${next}`);
      r.parent[r.key] = next;
      undo.push(() => { r.parent[r.key] = old; });
    }
  } catch (e) {
    for (const u of undo.reverse()) u();
    throw e;
  }
  return () => { for (const u of undo.reverse()) u(); };
}

export function describeChange(p: Proposal): string {
  return p.changes.map((c) => {
    const r = resolve(p.ship, c.path);
    const now = r ? (r.parent[r.key] as number) : NaN;
    const next = c.op === '=' ? c.value : c.op === '*=' ? now * c.value : now + c.value;
    return `\`${c.path}\` ${fmt(now)} → ${fmt(next)}`;
  }).join(', ');
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

export interface ShipLine { classId: ClassId; kills: number; deaths: number; damage: number; placement: number; won: boolean }

/** One full FFA match: 8 bots, two per ship, pinned. Ends at match end (12 kills / 6 min) or `maxTicks`. */
export function runMatch(seed: number, arenaId: string, skill: BotSkill, maxTicks = Math.round((7 * 60) / DT)): ShipLine[] {
  const sim = new GameSim({ arena: arenaById(arenaId), offline: true, seed, botSkill: skill });
  for (let i = 0; i < 2; i++) for (const c of CLASS_IDS) sim.addPlayer(`bot:${c}${i}`, `${CLASSES[c].name}${i + 1}`, c, true);
  let done = false;
  for (let t = 0; t < maxTicks && !done; t++) {
    sim.step();
    for (const e of sim.drainEvents()) if (e.t === 'matchEnd') done = true;
  }
  const lines = standings(sim.shipList).map((s, i) => ({
    classId: s.def.id, kills: s.stats.kills, deaths: s.stats.deaths, damage: Math.round(s.stats.damageDealt), placement: i + 1, won: i === 0,
  }));
  sim.world.free();
  return lines;
}

export interface ClassSummary { kills: number; deaths: number; net: number; damage: number; placement: number; wins: number }

/** Per-ship averages over matches (per ship per match; wins = matches a ship of this class won). */
export function summarize(matches: ShipLine[][]): Record<ClassId, ClassSummary> {
  const out = {} as Record<ClassId, ClassSummary>;
  for (const c of CLASS_IDS) {
    const lines = matches.flat().filter((l) => l.classId === c);
    const n = Math.max(1, lines.length);
    const sum = (f: (l: ShipLine) => number) => lines.reduce((a, l) => a + f(l), 0);
    out[c] = {
      kills: sum((l) => l.kills) / n, deaths: sum((l) => l.deaths) / n, net: sum((l) => l.kills - l.deaths) / n,
      damage: sum((l) => l.damage) / n, placement: sum((l) => l.placement) / n, wins: matches.filter((m) => m.some((l) => l.won && l.classId === c)).length,
    };
  }
  return out;
}

/** Mean and standard error of per-seed B−A differences of a class metric. */
export function pairedDelta(a: ShipLine[][], b: ShipLine[][], c: ClassId, metric: (l: ShipLine) => number): { mean: number; se: number } {
  const per = (m: ShipLine[]) => { const ls = m.filter((l) => l.classId === c); return ls.reduce((s, l) => s + metric(l), 0) / Math.max(1, ls.length); };
  const d = a.map((m, i) => per(b[i]!) - per(m));
  const mean = d.reduce((s, x) => s + x, 0) / Math.max(1, d.length);
  const sd = d.length > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (d.length - 1)) : 0;
  return { mean, se: d.length > 1 ? sd / Math.sqrt(d.length) : 0 };
}

export interface BalanceRun { proposal: Proposal; change: string; seeds: number[]; arenas: string[]; skill: BotSkill; a: ShipLine[][]; b: ShipLine[][]; version: string }

const sign = (x: number, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

/** Markdown report: the table the bot posts on the issue/PR. */
export function formatReport(r: BalanceRun): string {
  const A = summarize(r.a), B = summarize(r.b);
  const n = r.a.length;
  const name = (c: ClassId) => CLASSES[c].name;
  const rows = CLASS_IDS.map((c) => {
    const d = pairedDelta(r.a, r.b, c, (l) => l.kills - l.deaths);
    const z = d.se > 0 ? Math.abs(d.mean) / d.se : 0;
    const ship = c === r.proposal.ship ? `**${name(c)}** (changed)` : name(c);
    return `| ${ship} | ${A[c].kills.toFixed(1)} → ${B[c].kills.toFixed(1)} | ${A[c].deaths.toFixed(1)} → ${B[c].deaths.toFixed(1)} | ${A[c].placement.toFixed(1)} → ${B[c].placement.toFixed(1)} | ${A[c].wins} → ${B[c].wins} | ${sign(d.mean)} ± ${d.se.toFixed(2)}${z >= 2 ? ' ✱' : ''} |`;
  });
  const d = pairedDelta(r.a, r.b, r.proposal.ship, (l) => l.kills - l.deaths);
  const z = d.se > 0 ? Math.abs(d.mean) / d.se : 0;
  const verdict = n < 2
    ? 'One pair can\'t separate signal from noise — run more matches.'
    : z >= 2
      ? `**${name(r.proposal.ship)} net kills/match ${sign(d.mean)}** (${z.toFixed(1)}σ over ${n} paired matches) — a real shift at this sample size.`
      : `${name(r.proposal.ship)} net kills/match ${sign(d.mean)} is **within noise** (${z.toFixed(1)}σ over ${n} paired matches). Not evidence either way — rerun with more matches before arguing about it.`;
  return [
    `### ⚖️ Balance sim — ${name(r.proposal.ship)}: ${r.change}`,
    '',
    `${n} paired FFA matches (A = current tuning, B = proposed; same seed, map and bots per pair) · 8 ${r.skill} bots, two per ship · maps ${[...new Set(r.arenas)].join(', ')} · build ${r.version}`,
    '',
    '| Ship | Kills / match | Deaths / match | Avg place (of 8) | Match wins | Δ net kills (B−A) |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    verdict,
    '',
    `<sub>Per ship per match. Δ = mean paired difference in kills − deaths ± standard error; ✱ = at least 2σ. Seeds ${r.seeds[0]}–${r.seeds.at(-1)}. Reproduce: \`pnpm balance ${r.proposal.ship} ${r.proposal.changes.map((c) => `${c.path}${c.op}${c.value}`).join(' ')} --matches ${n} --seed ${r.seeds[0]}\`</sub>`,
  ].join('\n');
}

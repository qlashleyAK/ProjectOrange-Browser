/**
 * Balance evidence bot: `pnpm balance <ship> <change>... [--matches N] [--skill easy|normal|hard] [--arena id|all]
 *                                       [--seed S] [--out report.md] [--json results.json]`
 *
 *   pnpm balance brute hull=220
 *   pnpm balance scythe primary.damage*=1.1 cloak... → see `numericPaths` for every tunable stat
 *
 * Plays N paired FFA matches (current tuning vs proposed, same seed/map/bots per pair) and prints a markdown
 * table of per-ship kills, deaths, placement and wins with the paired delta and its standard error.
 *
 * `--from-env VAR` reads the request from a GitHub comment held in that env var (first line, `/balance ...`):
 * the balance workflow passes the comment this way so it is never interpolated into a shell. Requests from
 * comments are whitelisted token by token and capped at 16 matches.
 *
 * Exit: 0 report written · 2 bad request (the error report is still written to --out, for posting back).
 */
import { ARENAS, BUILD_VERSION, isArenaId, type BotSkill } from '../src/index.js';
import { applyProposal, describeChange, formatReport, parseProposal, runMatch, type ShipLine } from './balanceLib.js';

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never };

const USAGE = 'Usage: `/balance <ship> <stat>=<value> | <stat>*=<factor> | <stat>+=<delta> ... [--matches N] [--arena id|all] [--skill easy|normal|hard]` — e.g. `/balance brute hull=220 primary.damage*=1.1`';
const SKILLS: readonly BotSkill[] = ['easy', 'normal', 'hard'];

interface Opts { tokens: string[]; matches: number; skill: BotSkill; arena: string; seed: number; out: string | null; json: string | null }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { tokens: [], matches: 8, skill: 'normal', arena: 'all', seed: 1, out: null, json: null };
  let fromComment = false;
  let args = argv;
  const envIdx = argv.indexOf('--from-env');
  if (envIdx >= 0) {
    const text = process.env[argv[envIdx + 1] ?? ''] ?? '';
    const line = text.split(/\r?\n/)[0]!.trim();
    if (!line.startsWith('/balance')) throw new Error('the comment must start with `/balance`');
    // keep the CLI's own --out/--json from argv; the comment only supplies the request
    const own = argv.filter((_, i) => i !== envIdx && i !== envIdx + 1);
    args = [...line.slice('/balance'.length).trim().split(/\s+/).filter(Boolean), ...own];
    fromComment = true;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => { const v = args[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--matches') o.matches = Number(val());
    else if (a === '--skill') o.skill = val() as BotSkill;
    else if (a === '--arena') o.arena = val();
    else if (a === '--seed' && !fromComment) o.seed = Number(val());
    else if (a === '--out') o.out = val();
    else if (a === '--json') o.json = val();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.tokens.push(a);
  }
  const cap = fromComment ? 16 : 200;
  if (!Number.isInteger(o.matches) || o.matches < 1 || o.matches > cap) throw new Error(`--matches must be 1–${cap}`);
  if (!SKILLS.includes(o.skill)) throw new Error(`--skill must be ${SKILLS.join(' | ')}`);
  if (o.arena !== 'all' && !isArenaId(o.arena)) throw new Error(`--arena must be all or one of ${ARENAS.map((x) => x.id).join(', ')}`);
  if (!Number.isInteger(o.seed) || o.seed < 1) throw new Error('--seed must be a positive integer');
  return o;
}

async function write(path: string | null, text: string): Promise<void> {
  if (!path) return;
  // the shared package has no Node typings on purpose (it also runs in browsers); this CLI is Node-only
  const fs = (await import('node:fs' as string)) as { writeFileSync(p: string, d: string): void };
  fs.writeFileSync(path, text);
}

async function main(): Promise<number> {
  let o: Opts;
  let proposal;
  const outArg = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? process.argv[i + 1] ?? null : null; })();
  try {
    o = parseArgs(process.argv.slice(2));
    proposal = parseProposal(o.tokens);
  } catch (e) {
    const msg = `### ⚖️ Balance sim — couldn't run\n\n${(e as Error).message}\n\n${USAGE}\n`;
    console.error(msg);
    await write(outArg, msg);
    return 2;
  }

  const { initPhysics } = await import('../src/index.js');
  await initPhysics();
  const change = describeChange(proposal);
  const arenaIds = o.arena === 'all' ? ARENAS.map((x) => x.id) : [o.arena];
  const seeds = Array.from({ length: o.matches }, (_, i) => o.seed + i);
  const arenas = seeds.map((_, i) => arenaIds[i % arenaIds.length]!);
  const a: ShipLine[][] = [], b: ShipLine[][] = [];
  console.error(`balance: ${proposal.ship} ${change} · ${o.matches} paired matches · ${o.skill} bots`);
  const t0 = performance.now();
  for (let i = 0; i < seeds.length; i++) {
    a.push(runMatch(seeds[i]!, arenas[i]!, o.skill));
    const undo = applyProposal(proposal);
    try { b.push(runMatch(seeds[i]!, arenas[i]!, o.skill)); } finally { undo(); }
    const secs = (performance.now() - t0) / 1000;
    console.error(`  pair ${i + 1}/${seeds.length} on ${arenas[i]} · ${secs.toFixed(0)} s elapsed, ~${((secs / (i + 1)) * (seeds.length - i - 1)).toFixed(0)} s left`);
  }
  const report = formatReport({
    proposal, change, seeds, arenas: arenas.map((id) => ARENAS.find((x) => x.id === id)!.name), skill: o.skill, a, b, version: BUILD_VERSION,
  });
  console.log(report);
  await write(o.out, report + '\n');
  await write(o.json, JSON.stringify({ proposal, seeds, arenas, skill: o.skill, version: BUILD_VERSION, a, b }, null, 1));
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

/**
 * Headless client-bug repro harness: `pnpm repro <scenario.json> [--url <origin>] [--out <dir>] [--build]`.
 *
 * Boots the real client in headless Chromium (WebGL2 via SwiftShader, no GPU needed) and plays a scenario's
 * steps — menu clicks, held keys, mouse look, firing, waits, screenshots — then checks its expectations.
 * The target is either a local game server this script starts itself (serving the built client, so offline
 * practice vs bots AND online quick play both work, exactly as deployed) or a deployed origin via --url.
 *
 * A scenario describes CORRECT behavior; a bug report becomes a scenario whose expectation fails:
 *   exit 0  NOT REPRODUCED — every expectation held and the page threw nothing
 *   exit 1  REPRODUCED     — an expectation failed, a waitFor timed out, or the page threw
 *   exit 2  harness error  — bad scenario, server didn't start, browser didn't launch
 *
 * Writes transcript.md (paste-ready for an issue), probe.jsonl (game state once a second and after every
 * step), console.log and screenshots to the out dir. Game state comes from `window.orange.probe()`
 * (packages/client/src/main.ts); `until` / `that` expressions are JS over that snapshot, named `p`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

export type Step =
  /** click a visible button whose label starts with `text` (menu, pause, HUD) */
  | { do: 'click'; text: string }
  /** poll until the expression over the probe `p` is truthy */
  | { do: 'waitFor'; until: string; timeoutMs?: number }
  /** hold KeyboardEvent.code keys together for `ms` */
  | { do: 'hold'; keys: string[]; ms: number }
  /** tap one key */
  | { do: 'press'; key: string }
  /** mouse look by (dx, dy) pixels spread over `ms` (needs pointer lock: a `click` on the canvas grants it) */
  | { do: 'look'; dx: number; dy: number; ms?: number }
  /** hold a mouse button for `ms` (left = primary, right = lock/secondary) */
  | { do: 'fire'; ms: number; button?: 'left' | 'right' }
  /** click the game canvas: grants pointer lock and captures input */
  | { do: 'focus' }
  | { do: 'wait'; ms: number }
  | { do: 'screenshot'; name: string }
  /** the expression over the probe `p` must be truthy */
  | { do: 'expect'; that: string; label?: string }
  /** remember the current probe as `m.<as>` for later expressions, e.g. `dist(p.pos, m.spawn.pos) > 20` */
  | { do: 'mark'; as: string }
  /** no page errors and no unexpected console errors so far */
  | { do: 'noErrors' };

export interface Scenario {
  name: string;
  description?: string;
  /** merged over the harness defaults into localStorage `orange.settings.v1` before the page loads */
  settings?: Record<string, unknown>;
  /** appended to the page URL, e.g. "?room=ABCDE" */
  query?: string;
  viewport?: [number, number];
  /** regexes for console errors that are known noise for this scenario */
  allowConsoleErrors?: string[];
  steps: Step[];
}

/** Low quality, muted, first-visit tutorial off: fast and deterministic enough for SwiftShader. */
const DEFAULT_SETTINGS = { firstVisit: false, quality: 'low', masterVolume: 0, name: 'Repro', cameraShake: false };
/** Console noise every headless run produces (audio needs a gesture; pointer lock may be refused before one). */
const ALWAYS_ALLOWED = [/AudioContext was not allowed/i, /pointer ?lock/i, /requestPointerLock/i];

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const repoDir = resolve(clientDir, '../..');
const serverDir = join(repoDir, 'packages/server');

/** pnpm runs package scripts from the package dir; paths on the command line mean the caller's directory */
const invokedFrom = process.env.INIT_CWD ?? process.cwd();

/** A path from the caller's directory, or a bare name from repro/scenarios ("practice-smoke"). */
function scenarioPath(arg: string): string {
  const direct = resolve(invokedFrom, arg);
  if (existsSync(direct)) return direct;
  const named = join(here, 'scenarios', arg.endsWith('.json') ? arg : `${arg}.json`);
  if (existsSync(named)) return named;
  throw new Error(`scenario not found: ${arg} (looked at ${direct} and ${named})`);
}

interface Args { scenario: string; url: string | null; out: string | null; build: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { scenario: '', url: null, out: null, build: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === '--url') a.url = argv[++i] ?? null;
    else if (x === '--out') a.out = argv[++i] ?? null;
    else if (x === '--build') a.build = true;
    else if (!x.startsWith('--')) a.scenario = x;
    else throw new Error(`unknown flag ${x}`);
  }
  if (!a.scenario) throw new Error('usage: pnpm repro <scenario.json> [--url <origin>] [--out <dir>] [--build]');
  return a;
}

const STEP_KINDS = new Set(['click', 'waitFor', 'hold', 'press', 'look', 'fire', 'focus', 'wait', 'screenshot', 'expect', 'mark', 'noErrors']);

export function validateScenario(s: unknown): Scenario {
  const sc = s as Scenario;
  if (!sc || typeof sc !== 'object') throw new Error('scenario must be a JSON object');
  if (typeof sc.name !== 'string' || !sc.name) throw new Error('scenario.name is required');
  if (!Array.isArray(sc.steps) || !sc.steps.length) throw new Error('scenario.steps must be a non-empty array');
  sc.steps.forEach((st, i) => {
    if (!st || !STEP_KINDS.has((st as { do: string }).do)) throw new Error(`step ${i + 1}: unknown "do" ${JSON.stringify((st as { do?: unknown })?.do)} (expected ${[...STEP_KINDS].join(' | ')})`);
  });
  return sc;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
    s.on('error', fail);
  });
}

async function waitForPing(origin: string, timeoutMs: number): Promise<{ version: string }> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${origin}/ping`);
      if (r.ok) return await r.json() as { version: string };
      last = `HTTP ${r.status}`;
    } catch (e) { last = String(e); }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${origin} never answered /ping (${last})`);
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

/** The real game server on a free port, serving the built client with persistence off. */
async function startLocalServer(build: boolean): Promise<{ origin: string; proc: ChildProcess }> {
  const dist = join(clientDir, 'dist/index.html');
  if (build || !existsSync(dist)) {
    console.log(build ? 'building client…' : 'client not built yet — building…');
    await run('pnpm', ['--filter', '@orange/client', 'build'], repoDir);
  }
  const port = await freePort();
  const tsx = join(serverDir, 'node_modules/.bin/tsx');
  const proc = spawn(tsx, ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), ORANGE_DB: 'none', REGION: 'repro', STATIC_DIR: join(clientDir, 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  proc.stdout?.on('data', (d) => { serverLog += String(d); });
  proc.stderr?.on('data', (d) => { serverLog += String(d); });
  const origin = `http://127.0.0.1:${port}`;
  try { await waitForPing(origin, 30_000); } catch (e) { proc.kill(); throw new Error(`${String(e)}\n${serverLog}`); }
  return { origin, proc };
}

interface Outcome { ok: boolean; note: string }

async function probe(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const o = (window as unknown as { orange?: { probe?: () => unknown } }).orange;
    return (o?.probe?.() ?? null) as Record<string, unknown> | null;
  });
}

/**
 * Evaluate a scenario expression in the page. In scope: `p` (probe now), `m` (marked probes),
 * `dist(a, b)` (metres between two {x,y,z}; Infinity if either is missing).
 */
async function evalOverProbe(page: Page, expr: string, marks: Record<string, unknown>): Promise<{ value: boolean; error?: string }> {
  // a source string, not a function: tsx/esbuild would wrap named closures in a __name() helper the page lacks
  const code = `(() => {
    const o = window.orange;
    const p = o && o.probe ? o.probe() : null;
    if (!p) return { value: false, error: 'window.orange.probe() not available yet' };
    const m = ${JSON.stringify(marks)};
    const dist = function (a, b) { return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity; };
    try { return { value: !!(function (p, m, dist) { return (${expr}\n); })(p, m, dist) }; }
    catch (err) { return { value: false, error: String(err) }; }
  })()`;
  return page.evaluate(code) as Promise<{ value: boolean; error?: string }>;
}

async function main(): Promise<number> {
  let args: Args;
  let scenario: Scenario;
  try {
    args = parseArgs(process.argv.slice(2));
    scenario = validateScenario(JSON.parse(readFileSync(scenarioPath(args.scenario), 'utf8')));
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(invokedFrom, args.out ?? join(repoDir, 'repro-out', `${basename(args.scenario, '.json')}-${stamp}`));
  mkdirSync(out, { recursive: true });
  const probeFile = join(out, 'probe.jsonl');
  const consoleFile = join(out, 'console.log');
  writeFileSync(probeFile, '');
  writeFileSync(consoleFile, '');

  let server: { origin: string; proc: ChildProcess } | null = null;
  let browser: Browser | null = null;
  const lines: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const allowed = [...ALWAYS_ALLOWED, ...(scenario.allowConsoleErrors ?? []).map((r) => new RegExp(r, 'i'))];
  let failed = 0;
  let screenshots = 0;

  try {
    let origin = args.url?.replace(/\/+$/, '') ?? null;
    if (!origin) { server = await startLocalServer(args.build); origin = server.origin; }
    const ping = await waitForPing(origin, 10_000);

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // keep the tab running at full rate even though nothing is "visible" in headless mode
      // SwiftShader rasterizes on every core and starves the sim worker / socket handlers; an in-process GPU
      // measurably shortens that lag. Headless timing is still slower than a real GPU — see repro/README.md.
      args: [
        '--enable-unsafe-swiftshader', '--in-process-gpu',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const [w, h] = scenario.viewport ?? [1280, 720];
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const settings = { ...DEFAULT_SETTINGS, ...(scenario.settings ?? {}) };
    await ctx.addInitScript((s) => { try { localStorage.setItem('orange.settings.v1', s); } catch { /* ignore */ } }, JSON.stringify(settings));
    const page = await ctx.newPage();
    const t0 = Date.now();
    const marks: Record<string, unknown> = {};
    const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    page.on('console', (m) => {
      const line = `[${at()}] ${m.type()}: ${m.text()}`;
      appendFileSync(consoleFile, line + '\n');
      if (m.type() === 'error' && !allowed.some((r) => r.test(m.text()))) consoleErrors.push(line);
    });
    page.on('pageerror', (e) => {
      const line = `[${at()}] ${e.stack ?? e.message}`;
      appendFileSync(consoleFile, `PAGEERROR ${line}\n`);
      pageErrors.push(line);
    });

    const url = `${origin}/${scenario.query ?? ''}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as unknown as { orange?: unknown }).orange, null, { timeout: 60_000 });
    const gl = await page.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      const d = g?.getExtension('WEBGL_debug_renderer_info');
      return g ? (d ? String(g.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'webgl2') : 'none';
    });
    const first = await probe(page);

    lines.push(`# Repro: ${scenario.name}`, '');
    if (scenario.description) lines.push(scenario.description, '');
    lines.push(
      `- **Target:** ${args.url ? origin : 'local server (built client, persistence off)'} — server build ${ping.version}`,
      `- **Client build:** ${String(first?.version ?? '?')} (${String(first?.buildTime ?? '?')})`,
      `- **Browser:** headless Chromium ${browser.version()} · ${gl} · ${w}×${h}`,
      `- **Scenario:** \`${args.scenario}\``,
      '', '| # | step | result | state after |', '|---|---|---|---|',
    );

    // background sampler: game state once a second
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try { const p = await probe(page); appendFileSync(probeFile, JSON.stringify({ t: at(), ...p }) + '\n'); } catch { /* page navigating */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();

    const canvasCenter = async () => {
      const b = await page.locator('#game').boundingBox();
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: w / 2, y: h / 2 };
    };

    for (let i = 0; i < scenario.steps.length; i++) {
      const st = scenario.steps[i]!;
      let res: Outcome = { ok: true, note: '' };
      try {
        switch (st.do) {
          case 'click': {
            // in-page click: menus re-render (e.g. when the region ping lands), which detaches buttons mid-way
            // through Playwright's actionability checks; a DOM click on whatever is current is what a player gets
            const want = st.text.toLowerCase();
            const until = Date.now() + 10_000;
            let clicked = false;
            while (!clicked && Date.now() < until) {
              clicked = await page.evaluate((t) => {
                const b = [...document.querySelectorAll('button')].find((e) =>
                  e.offsetParent !== null && !e.disabled && (e.textContent ?? '').trim().toLowerCase().startsWith(t));
                b?.click();
                return !!b;
              }, want);
              if (!clicked) await page.waitForTimeout(200);
            }
            res = clicked ? { ok: true, note: `clicked "${st.text}"` } : { ok: false, note: `no visible button starting "${st.text}" within 10s` };
            break;
          }
          case 'focus': {
            const c = await canvasCenter();
            await page.mouse.click(c.x, c.y);
            await page.waitForTimeout(200);
            const p = await probe(page);
            res.note = p?.pointerLocked ? 'pointer locked' : 'canvas clicked (no pointer lock)';
            break;
          }
          case 'waitFor': {
            const limit = st.timeoutMs ?? 30_000;
            const until = Date.now() + limit;
            let r = await evalOverProbe(page, st.until, marks);
            while (!r.value && Date.now() < until) { await page.waitForTimeout(200); r = await evalOverProbe(page, st.until, marks); }
            res = r.value ? { ok: true, note: `\`${st.until}\`` } : { ok: false, note: `timed out after ${limit / 1000}s waiting for \`${st.until}\`${r.error ? ` (${r.error})` : ''}` };
            break;
          }
          case 'hold':
            for (const k of st.keys) await page.keyboard.down(k);
            await page.waitForTimeout(st.ms);
            for (const k of [...st.keys].reverse()) await page.keyboard.up(k);
            res.note = `${st.keys.join('+')} for ${st.ms} ms`;
            break;
          case 'press':
            await page.keyboard.press(st.key);
            res.note = st.key;
            break;
          case 'look': {
            const n = Math.max(1, Math.round((st.ms ?? 500) / 16));
            const c = await canvasCenter();
            await page.mouse.move(c.x, c.y);
            for (let k = 1; k <= n; k++) {
              await page.mouse.move(c.x + (st.dx * k) / n, c.y + (st.dy * k) / n);
              await page.waitForTimeout(16);
            }
            res.note = `dx ${st.dx}, dy ${st.dy}`;
            break;
          }
          case 'fire': {
            const button = st.button ?? 'left';
            await page.mouse.down({ button });
            await page.waitForTimeout(st.ms);
            await page.mouse.up({ button });
            res.note = `${button} for ${st.ms} ms`;
            break;
          }
          case 'wait':
            await page.waitForTimeout(st.ms);
            res.note = `${st.ms} ms`;
            break;
          case 'screenshot': {
            const file = `${String(++screenshots).padStart(2, '0')}-${st.name.replace(/[^\w-]/g, '_')}.png`;
            await page.screenshot({ path: join(out, file) });
            res.note = `[${file}](${file})`;
            break;
          }
          case 'expect': {
            const r = await evalOverProbe(page, st.that, marks);
            res = { ok: r.value, note: `${st.label ? `${st.label}: ` : ''}\`${st.that}\`${r.error ? ` (${r.error})` : ''}` };
            break;
          }
          case 'mark': {
            const p = await probe(page);
            marks[st.as] = p;
            const pos = p?.pos as { x: number; y: number; z: number } | null | undefined;
            res.note = `m.${st.as} saved${pos ? ` at (${pos.x}, ${pos.y}, ${pos.z})` : ''}`;
            break;
          }
          case 'noErrors': {
            const errs = [...pageErrors, ...consoleErrors];
            res = { ok: errs.length === 0, note: errs.length ? `${errs.length} error(s): ${errs[0]!.slice(0, 160)}` : 'clean console' };
            break;
          }
        }
      } catch (e) {
        res = { ok: false, note: String((e as Error).message ?? e).split('\n')[0]!.slice(0, 200) };
      }
      if (!res.ok) failed++;
      const p = await probe(page).catch(() => null);
      appendFileSync(probeFile, JSON.stringify({ t: at(), step: i + 1, ...p }) + '\n');
      const state = p
        ? [p.menu ? `menu ${String(p.menu)}` : null, p.phase, p.alive === null ? null : p.alive ? `alive hull ${String(p.hull)}` : 'dead',
          p.power === null ? null : `power ${String(p.power)}`, p.speed === null ? null : `${String(p.speed)} m/s`, `${String(p.fps)} fps`,
          p.ping == null ? null : `link ${String(p.ping)} ms`]
          .filter(Boolean).join(' · ')
        : '—';
      lines.push(`| ${i + 1} | \`${st.do}\` | ${res.ok ? '✅' : '❌'} ${res.note.replace(/\|/g, '\\|')} | ${state} |`);
      console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${i + 1}. ${st.do} — ${res.note}`);
      // a missed waitFor leaves later steps meaningless: stop there
      if (!res.ok && st.do === 'waitFor') { lines.push(`| | | ⏭ stopped: later steps depend on this wait | |`); break; }
    }

    sampling = false;
    await sampler;
    const reproduced = failed > 0 || pageErrors.length > 0;
    lines.push('');
    if (pageErrors.length) lines.push('**Page errors:**', '', '```', ...pageErrors.slice(0, 10), '```', '');
    if (consoleErrors.length) lines.push('**Console errors:**', '', '```', ...consoleErrors.slice(0, 10), '```', '');
    lines.push(reproduced
      ? `**Verdict: REPRODUCED on ${String(first?.version)}** — ${failed} failed step(s)${pageErrors.length ? `, ${pageErrors.length} page error(s)` : ''}.`
      : `**Verdict: NOT REPRODUCED on ${String(first?.version)}** — all ${scenario.steps.length} steps held, no page errors.`);
    writeFileSync(join(out, 'transcript.md'), lines.join('\n') + '\n');
    console.log(`\n${lines.join('\n')}\n\nartifacts: ${out}`);
    return reproduced ? 1 : 0;
  } catch (e) {
    console.error(`harness error: ${String((e as Error).stack ?? e)}`);
    writeFileSync(join(out, 'transcript.md'), `${lines.join('\n')}\n\n**Harness error:** ${String((e as Error).message ?? e)}\n`);
    return 2;
  } finally {
    await browser?.close().catch(() => {});
    server?.proc.kill();
  }
}

// run only as a CLI, so tests can import validateScenario
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().then((code) => process.exit(code));

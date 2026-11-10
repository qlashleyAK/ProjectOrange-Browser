/**
 * Frame-time benchmark per quality tier (td5): how much High (SSAO + shadows) costs over Default on this machine.
 *
 *   pnpm bench                       # all maps, headless
 *   pnpm bench --headed              # a visible window: on most desktops the only way Chromium uses the real GPU
 *   pnpm bench --maps gyre,forest --frames 300 --size 1920x1080 --out bench.md
 *
 * For each map it starts Practice vs bots on the built client, pauses (the sim stops, the renderer keeps
 * drawing the same frame), hides the HUD, then measures `--frames` frames at Low, Default and High with vsync
 * and the frame cap off. Same frame, same camera, only the tier changes. The report names the GL renderer:
 * "SwiftShader" means software rendering, and those times say nothing about a GPU.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

const TIERS = ['low', 'default', 'high'] as const;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2',
};

interface Args { headed: boolean; maps: string[]; frames: number; width: number; height: number; out?: string; cls: string }
function parseArgs(argv: string[]): Args {
  const a: Args = { headed: false, maps: ['hollowdeep', 'gyre', 'tower', 'forest'], frames: 240, width: 1920, height: 1080, cls: 'dart' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!, v = argv[i + 1];
    if (k === '--headed') a.headed = true;
    else if (k === '--maps' && v) { a.maps = v.split(','); i++; }
    else if (k === '--frames' && v) { a.frames = Math.max(30, Number(v)); i++; }
    else if (k === '--size' && v) { const [w, h] = v.split('x').map(Number); a.width = w!; a.height = h!; i++; }
    else if (k === '--out' && v) { a.out = v; i++; }
    else if (k === '--class' && v) { a.cls = v; i++; }
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** Practice runs fully offline, so a static server for dist/ is all the page needs. */
function serve(dir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const file = normalize(join(dir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    ok({ server, origin: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` });
  }));
}

interface Sample { p50: number; p95: number; fps: number; draws: number; tris: number }

async function benchMap(browser: Browser, origin: string, map: string, a: Args): Promise<Record<string, Sample>> {
  const ctx = await browser.newContext({ viewport: { width: a.width, height: a.height }, deviceScaleFactor: 1 });
  const settings = { firstVisit: false, quality: 'high', masterVolume: 0, cameraShake: false, arena: map, lastClass: a.cls, botSkill: 'easy', name: 'Bench' };
  await ctx.addInitScript((s) => { try { localStorage.setItem('orange.settings.v1', s); } catch { /* ignore */ } }, JSON.stringify(settings));
  const page = await ctx.newPage();
  page.setDefaultTimeout(180_000);
  await page.goto(origin);
  await page.waitForFunction("window.orange && window.orange.probe().menu === 'main'");
  await page.getByRole('button', { name: /^Practice vs bots/ }).click();
  await page.waitForFunction("(() => { const p = window.orange.probe(); return p.alive === true && p.phase === 'inProgress'; })()");
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  await page.waitForFunction('window.orange.probe().paused === true');
  await page.addStyleTag({ content: '#hud, [class*=menu], [class*=hud] { display: none !important; }' });
  const out: Record<string, Sample> = {};
  for (const tier of TIERS) {
    await page.evaluate(`window.orange.renderer.setQuality(${JSON.stringify(tier)})`);
    await page.waitForTimeout(2000); // shader compiles and shadow maps settle
    // a source string, not a function: tsx would wrap a closure in a __name() helper the page lacks
    out[tier] = await page.evaluate(`new Promise((ok) => {
      const n = ${a.frames}, d = [];
      let last = 0;
      const step = (t) => {
        if (last) d.push(t - last);
        last = t;
        if (d.length < n) requestAnimationFrame(step);
        else {
          const s = d.slice().sort((x, y) => x - y), q = (k) => s[Math.min(s.length - 1, Math.floor(k * s.length))];
          const r = window.orange.renderer;
          ok({ p50: q(0.5), p95: q(0.95), fps: 1000 / (d.reduce((x, y) => x + y, 0) / d.length), draws: r.drawCalls, tris: r.triangles });
        }
      };
      requestAnimationFrame(step);
    })`) as Sample;
    process.stderr.write(`  ${map} ${tier}: p50 ${out[tier]!.p50.toFixed(1)} ms, p95 ${out[tier]!.p95.toFixed(1)} ms\n`);
  }
  await ctx.close();
  return out;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const dist = resolve(import.meta.dirname, '../dist');
  if (!existsSync(join(dist, 'index.html'))) { console.error('no build: run `pnpm build` first'); return 2; }
  const { server, origin } = await serve(dist);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: !a.headed,
    args: [
      '--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      ...(a.headed ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : ['--enable-unsafe-swiftshader']),
    ],
  });
  try {
    const probe = await browser.newPage();
    const gl = await probe.evaluate(`(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      const e = g && g.getExtension('WEBGL_debug_renderer_info');
      return g ? (e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : 'no WebGL2';
    })()`) as string;
    await probe.close();
    const software = /swiftshader|llvmpipe|software/i.test(gl);
    console.error(`bench: ${gl}${software ? '  ← software rendering: these times do not measure a GPU' : ''}`);
    const rows: string[] = [];
    for (const map of a.maps) {
      const r = await benchMap(browser, origin, map, a);
      for (const t of TIERS) {
        const s = r[t]!;
        const vsDefault = t === 'high' ? ` (${(s.p50 / r.default!.p50).toFixed(2)}× Default)` : '';
        rows.push(`| ${map} | ${t} | ${s.p50.toFixed(1)}${vsDefault} | ${s.p95.toFixed(1)} | ${s.fps.toFixed(0)} | ${s.draws} | ${s.tris} |`);
      }
    }
    const report = [
      `## Frame-time benchmark`,
      ``,
      `- **GL renderer:** ${gl}${software ? ' (**software, not a GPU**)' : ''}`,
      `- **Viewport:** ${a.width}×${a.height}, ${a.frames} frames per tier, paused on the same frame, vsync off`,
      ``,
      `| Map | Tier | p50 ms | p95 ms | fps | draw calls | triangles |`,
      `|---|---|---|---|---|---|---|`,
      ...rows,
      ``,
      `Default has to hold 60 fps (16.7 ms) on a 2019 integrated GPU at 1080p (design doc §0.2).`,
    ].join('\n');
    console.log(report);
    if (a.out) writeFileSync(a.out, report + '\n');
    return 0;
  } finally {
    await browser.close();
    server.close();
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });

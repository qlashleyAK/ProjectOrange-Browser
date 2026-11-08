import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ARENAS, arenaInfo, BUILD_VERSION, DEFAULT_ARENA, GameRoom, initPhysics, isArenaId, isIdentityToken, todayChallenge,
  type ClientLink, type MatchReport,
} from '@orange/shared';
import { MatchStore, openDb } from './db.js';
import { Presence } from './presence.js';
import { RankedQueue, migrateRanked } from './ranked.js';

const PORT = Number(process.env.PORT ?? 2567);
const REGION = process.env.REGION ?? 'local';
const DB_PATH = process.env.ORANGE_DB ?? 'data/orange.db';
const DEFAULT_ROOM_ARENA = isArenaId(process.env.ARENA) ? process.env.ARENA : DEFAULT_ARENA;
const ROOM_IDLE_MS = 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? join(here, '../../client/dist'));

const rooms = new Map<string, GameRoom>();
let roomCounter = 0;
const presence = new Presence();

const store = DB_PATH === 'none' ? null : new MatchStore(openDb(DB_PATH));
if (store) migrateRanked((store as unknown as { db: import('node:sqlite').DatabaseSync }).db);

/** Ranked-duel rooms: private 1v1, ranked mode, human cap 2. */
function makeDuelRoom(): string {
  const id = `RK${(++roomCounter).toString(36).toUpperCase()}`;
  const r = new GameRoom({ id, isPrivate: true, mode: 'ranked-duel', log, sink });
  r.start();
  rooms.set(id, r);
  log(`duel room ${id} created`);
  return id;
}

const ranked = store
  ? new RankedQueue((store as unknown as { db: import('node:sqlite').DatabaseSync }).db, () => makeDuelRoom())
  : null;

const sink = store
  ? {
      onMatchEnd(r: MatchReport): void {
        try {
          const matchId = store.recordMatch(r);
          if (r.mode === 'ranked-duel' && ranked) ranked.applyDuel(r, matchId);
          log(`room ${r.roomId}: match #${r.matchNumber} recorded (${r.mode}, ${r.players.length} players, winner ${r.winnerPlayerId ?? 'none'})`);
        } catch (e) {
          log(`room ${r.roomId}: match record failed (${String(e)})`);
        }
      },
    }
  : undefined;

function log(msg: string): void { console.log(`[${new Date().toISOString()}] ${msg}`); }

/** Today's daily-challenge room: mode + seed + arena fixed by the date, shared by everyone. */
function dailyRoom(): GameRoom {
  const c = todayChallenge();
  const id = `DAILY-${c.date}`;
  let r = rooms.get(id);
  if (!r) {
    const arena = ARENAS[c.seed % ARENAS.length]!.id;
    r = new GameRoom({ id, isPrivate: false, arena, mode: c.mode, seed: c.seed, rotation: false, log, sink });
    r.start();
    rooms.set(id, r);
    log(`daily room ${id} created (${c.mode}, seed ${c.seed}, ${arenaInfo(arena).name})`);
  }
  return r;
}

/** The arena only picks where a new room's rotation starts; joiners get whatever map the room is on. */
function getRoom(id: string, isPrivate: boolean, arena = DEFAULT_ROOM_ARENA): GameRoom {
  let r = rooms.get(id);
  if (!r) {
    r = new GameRoom({ id, isPrivate, arena, log, sink });
    r.start();
    rooms.set(id, r);
    log(`room ${id} created (${isPrivate ? 'private' : 'public'}, ${arenaInfo(arena).name})`);
  }
  return r;
}

const arenaParam = (url: URL): string | undefined => {
  const a = url.searchParams.get('arena');
  return isArenaId(a) ? a : undefined;
};

/** Fullest public room with a free human slot, whatever map its rotation is on; otherwise a new one starting on `arena`. */
function quickplayRoom(arena = DEFAULT_ROOM_ARENA): GameRoom {
  let best: GameRoom | null = null;
  for (const r of rooms.values()) {
    if (r.isPrivate || !r.hasFreeSlot) continue;
    if (!best || r.humans > best.humans) best = r;
  }
  return best ?? getRoom(`PUB${(++roomCounter).toString(36).toUpperCase()}`, false, arena);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Small request bodies only (a token); anything bigger is dropped. */
function readBody(req: IncomingMessage, max = 256): Promise<string | null> {
  return new Promise((ok) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { body += d; if (body.length > max) { ok(null); req.destroy(); } });
    req.on('end', () => ok(body));
    req.on('error', () => ok(null));
  });
}

function sanitizeCode(code: string): string { return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!existsSync(STATIC_DIR)) { res.writeHead(404).end('client not built'); return; }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(path)));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
  stream.pipe(res);
}

async function main(): Promise<void> {
  await initPhysics();
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    if (url.pathname === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, region: REGION, version: BUILD_VERSION, t: Date.now() }));
      return;
    }
    if (url.pathname === '/quickplay') {
      const r = quickplayRoom(arenaParam(url));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ room: r.id, region: REGION, arena: r.sim.arena.blueprint.id }));
      return;
    }
    if (url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: BUILD_VERSION, rooms: [...rooms.values()].map((r) => r.stats()) }));
      return;
    }
    if (store && url.pathname === '/api/leaderboard') {
      const w = url.searchParams.get('window') ?? 'week';
      const windowS = w === 'day' ? 86400 : w === 'alltime' ? 0 : 604800;
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ window: w, rows: store.leaderboard(windowS, limit) }));
      return;
    }
    if (store && url.pathname === '/api/recent') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ matches: store.recentMatches(limit) }));
      return;
    }
    if (url.pathname === '/api/presence') {
      presence.touch(url.searchParams.get('id'), Date.now());
      let inMatch = 0;
      for (const r of rooms.values()) inMatch += r.connectedHumans;
      json(res, 200, { ...presence.counts(inMatch, Date.now()), rooms: rooms.size });
      return;
    }
    // POST with a text/plain body: the token never lands in a URL or log, and stays a CORS "simple" request
    if (store && url.pathname === '/api/profile' && req.method === 'POST') {
      void readBody(req).then((body) => {
        const token = body?.trim();
        if (!isIdentityToken(token)) { json(res, 400, { error: 'bad token' }); return; }
        json(res, 200, { profile: store.profile(token) });
      });
      return;
    }
    if (store && url.pathname === '/api/daily') {
      const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(store.dailySeed(date)));
      return;
    }
    if (ranked && req.method === 'POST' && url.pathname === '/api/ranked') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { token, handle } = JSON.parse(body || '{}') as { token?: string; handle?: string };
          if (!token) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'token required' })); return; }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(ranked.join(token, String(handle ?? 'Pilot').slice(0, 16))));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' }));
        }
      });
      return;
    }
    if (ranked && req.method === 'POST' && url.pathname === '/api/ranked/leave') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { ranked.leave((JSON.parse(body || '{}') as { token?: string }).token ?? ''); } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (ranked && url.pathname === '/api/ranks') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ rows: ranked.ladder(limit) }));
      return;
    }
    if (store && url.pathname === '/api/daily/leaderboard') {
      const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ date, rows: store.dailyLeaderboard(date, limit) }));
      return;
    }
    serveStatic(req, res, url.pathname);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const code = sanitizeCode(url.searchParams.get('room') ?? '');
    const isPrivate = url.searchParams.get('private') === '1';
    const arena = arenaParam(url);
    const daily = url.searchParams.get('daily') === '1';
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = daily ? dailyRoom() : code ? getRoom(code, isPrivate || !code.startsWith('PUB'), arena) : quickplayRoom(arena);
      attach(ws, room);
    });
  });

  setInterval(() => {
    const now = performance.now();
    for (const [id, r] of rooms) {
      if (r.humans === 0 && now - r.lastHumanAt > ROOM_IDLE_MS) {
        r.stop();
        rooms.delete(id);
        log(`room ${id} closed (idle)`);
      }
    }
  }, 5000);

  http.listen(PORT, () => log(`Project Orange server ${BUILD_VERSION} listening on :${PORT} (region ${REGION}, default map ${arenaInfo(DEFAULT_ROOM_ARENA).name})`));
}

function attach(ws: WebSocket, room: GameRoom): void {
  ws.binaryType = 'nodebuffer';
  const link: ClientLink = {
    send: (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    close: () => ws.close(),
  };
  room.connect(link);
  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        room.message(link, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      } else room.message(link, data.toString());
    } catch (e) {
      log(`room ${room.id}: bad message dropped (${String(e)})`);
    }
  });
  ws.on('close', () => room.disconnect(link));
  ws.on('error', () => room.disconnect(link));
}

process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack ?? e}`));
main().catch((e) => { console.error(e); process.exit(1); });

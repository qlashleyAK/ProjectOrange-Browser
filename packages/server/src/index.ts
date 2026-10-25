import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { arenaInfo, BUILD_VERSION, DEFAULT_ARENA, GameRoom, initPhysics, isArenaId, type ClientLink } from '@orange/shared';

const PORT = Number(process.env.PORT ?? 2567);
const REGION = process.env.REGION ?? 'local';
const DEFAULT_ROOM_ARENA = isArenaId(process.env.ARENA) ? process.env.ARENA : DEFAULT_ARENA;
const ROOM_IDLE_MS = 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? join(here, '../../client/dist'));

const rooms = new Map<string, GameRoom>();
let roomCounter = 0;

function log(msg: string): void { console.log(`[${new Date().toISOString()}] ${msg}`); }

/** The arena only applies when the room is created; joiners get whatever map the room is already running. */
function getRoom(id: string, isPrivate: boolean, arena = DEFAULT_ROOM_ARENA): GameRoom {
  let r = rooms.get(id);
  if (!r) {
    r = new GameRoom({ id, isPrivate, arena, log });
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

/** Fullest public room on the requested map with a free human slot, otherwise a new one. */
function quickplayRoom(arena = DEFAULT_ROOM_ARENA): GameRoom {
  let best: GameRoom | null = null;
  for (const r of rooms.values()) {
    if (r.isPrivate || !r.hasFreeSlot || r.sim.arena.blueprint.id !== arena) continue;
    if (!best || r.humans > best.humans) best = r;
  }
  return best ?? getRoom(`PUB${(++roomCounter).toString(36).toUpperCase()}`, false, arena);
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
    serveStatic(req, res, url.pathname);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const code = sanitizeCode(url.searchParams.get('room') ?? '');
    const isPrivate = url.searchParams.get('private') === '1';
    const arena = arenaParam(url);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = code ? getRoom(code, isPrivate || !code.startsWith('PUB'), arena) : quickplayRoom(arena);
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

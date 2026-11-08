/**
 * Synthetic-client WS load driver: N rooms x M clients sending real input
 * packets, measuring server tickMs (via /status), snapshot rate, and bandwidth.
 *
 *   pnpm --filter @orange/server load http://45.55.189.32 5 8 60
 *   args: <host> <rooms> <clientsPerRoom> <seconds>
 */
import WebSocket from 'ws';
import { encodeInputPacket, neutralInput } from '@orange/shared';

const host = process.argv[2] ?? 'http://localhost:2567';
const nRooms = Number(process.argv[3] ?? 2);
const perRoom = Math.min(8, Number(process.argv[4] ?? 8));
const seconds = Number(process.argv[5] ?? 60);

const wsBase = host.replace(/^http/, 'ws');
const input = encodeInputPacket([neutralInput()]);
let totalSnaps = 0;
let totalBytesIn = 0;
let totalBytesOut = 0;
let clientsUp = 0;

function makeClient(roomCode: string): WebSocket {
  const ws = new WebSocket(`${wsBase}/ws?room=${roomCode}`);
  ws.binaryType = 'arraybuffer';
  ws.on('open', () => {
    clientsUp++;
    ws.send(JSON.stringify({ t: 'hello', name: `Load${clientsUp}`, classId: 'dart', version: '0.2.0' }));
  });
  ws.on('message', (data: ArrayBuffer, isBinary: boolean) => {
    totalSnaps++;
    totalBytesIn += isBinary ? (data as ArrayBuffer).byteLength : String(data).length;
  });
  ws.on('error', () => {});
  ws.on('close', () => { clientsUp--; });
  return ws;
}

async function main(): Promise<void> {
  const clients: WebSocket[] = [];
  const timers: NodeJS.Timeout[] = [];
  const samples: { t: number; tickMs: Record<string, number> }[] = [];
  console.log(`load: ${nRooms} rooms x ${perRoom} clients for ${seconds}s -> ${host}`);
  for (let r = 0; r < nRooms; r++) {
    const code = `LOAD${r}`;
    for (let c = 0; c < perRoom; c++) clients.push(makeClient(code));
  }
  // input stream at 30Hz per client (neutral stick: counts as traffic, zero bot load)
  for (const ws of clients) timers.push(setInterval(() => { if (ws.readyState === ws.OPEN) { ws.send(input); totalBytesOut += input.byteLength; } }, 1000 / 30));
  // /status sampler every 5s
  const statusTimer = setInterval(async () => {
    try {
      const j = await (await fetch(`${host}/status`)).json() as { rooms: { id: string; humans: number; tickMs: number }[] };
      samples.push({ t: Date.now(), tickMs: Object.fromEntries(j.rooms.filter((r) => r.id.startsWith('LOAD')).map((r) => [r.id, r.tickMs])) });
      const loadRooms = j.rooms.filter((r) => r.id.startsWith('LOAD'));
      console.log(`  t+${samples.length * 5}s  rooms=${loadRooms.length} humans=${loadRooms.reduce((a, r) => a + r.humans, 0)} tickMs avg=${(loadRooms.reduce((a, r) => a + r.tickMs, 0) / Math.max(1, loadRooms.length)).toFixed(2)}`);
    } catch { /* ignore */ }
  }, 5000);
  timers.push(statusTimer);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  for (const t of timers) clearInterval(t);
  for (const ws of clients) ws.close();

  const loadRooms = Object.keys(samples.at(-1)?.tickMs ?? {});
  const allTick = samples.flatMap((s) => Object.values(s.tickMs));
  const lastTick = Object.values(samples.at(-1)?.tickMs ?? {});
  console.log('--- results ---');
  console.log(`clients connected: peak=${clientsUp} (target ${nRooms * perRoom})`);
  console.log(`server tickMs over time: avg=${(allTick.reduce((a, b) => a + b, 0) / Math.max(1, allTick.length)).toFixed(2)} max=${Math.max(0, ...allTick).toFixed(2)} | final: avg=${(lastTick.reduce((a, b) => a + b, 0) / Math.max(1, lastTick.length)).toFixed(2)}`);
  console.log(`snapshots received: ${totalSnaps} (${(totalSnaps / Math.max(1, nRooms * perRoom * seconds)).toFixed(1)}/client/s)`);
  console.log(`bandwidth per client: in=${(totalBytesIn / Math.max(1, nRooms * perRoom * seconds) / 1024).toFixed(1)} KB/s out=${(totalBytesOut / Math.max(1, nRooms * perRoom * seconds) / 1024).toFixed(1)} KB/s`);
  console.log(`rooms measured: ${loadRooms.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

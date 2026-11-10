import * as THREE from 'three';
import {
  arenaById, BUILD_VERSION, BULWARK_ABSORB, CLASS_LIST, initPhysics, lineOfSight, placeAt,
  type ArenaData, type ClassId, type GameEvent, type Theme,
} from '@orange/shared';
import './style.css';
import { buildArena, type ArenaView } from './arena/arenaMesh';
import { audio } from './audio/audio';
import { Presenter } from './game/presenter';
import { Hud } from './hud/hud';
import { InputManager } from './input/input';
import { TouchControls } from './input/touch';
import { OfflineSource } from './modes/offline';
import { OnlineSource, type NetStatus } from './modes/online';
import { presenceTabId, serverApi } from './net/api';
import { WorkerTransport, WsTransport } from './net/transport';
import { CameraRig } from './render/camera';
import { Effects } from './render/effects';
import { LightRig } from './render/lights';
import { CheckpointRenderer } from './render/checkpoints';
import { PowerupRenderer } from './render/powerups';
import { MissileRenderer, PickupRenderer, ProjectileRenderer } from './render/projectiles';
import { Renderer, type QualityProfile } from './render/renderer';
import { ShipRenderer } from './render/ships';
import { onSettings, saveSettings, settings, touchMode, type Quality } from './settings';
import { Menu } from './ui/menu';
import type { ShipView, ViewSource } from './view';

type SessionKind = 'quick' | 'private' | 'practice' | 'daily';
interface Session { source: ViewSource; kind: SessionKind; room: string | null; origin: string }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const canvas = $<HTMLCanvasElement>('#game');
const hudEl = $<HTMLDivElement>('#hud');
const bootEl = $<HTMLDivElement>('#boot');

// ------------------------------------------------------------------ regions
const REGIONS: string[] = ((import.meta.env.VITE_REGIONS as string | undefined) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!REGIONS.length) REGIONS.push(location.origin);
interface RegionInfo { origin: string; name: string; ping: number }
let bestRegion: RegionInfo | null = null;

async function pingRegions(): Promise<RegionInfo | null> {
  const results: RegionInfo[] = [];
  await Promise.all(REGIONS.map(async (origin) => {
    const samples: number[] = [];
    let name = origin;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        const r = await fetch(`${origin}/ping`, { cache: 'no-store' });
        if (!r.ok) break;
        const j = await r.json() as { region?: string };
        name = j.region ?? name;
        samples.push(performance.now() - t0);
      } catch { break; }
    }
    if (samples.length) results.push({ origin, name, ping: samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]! });
  }));
  results.sort((a, b) => a.ping - b.ping);
  return results[0] ?? null;
}

/** `arena` only matters if the server has to create the room; existing rooms keep their map. `daily` joins today's challenge room. */
function wsUrl(origin: string, room: string | null, isPrivate: boolean, arena: string, daily = false): string {
  const u = new URL(origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = daily ? '?daily=1' : `?room=${encodeURIComponent(room ?? '')}${isPrivate ? '&private=1' : ''}&arena=${encodeURIComponent(arena)}`;
  return u.toString();
}

const AMBIENCE_OF: Record<Theme, string> = {
  refinery: 'hub', industrial: 'foundry', hangar: 'dock', reactor: 'reactor', rock: 'gallery', machinery: 'crusher', tunnel: 'tunnel', sewer: 'tunnel',
  office: 'hub', garage: 'gallery', roof: 'wind', shaft: 'tunnel',
  mine: 'hub', works: 'foundry', cave: 'gallery', drift: 'tunnel', forest: 'forest',
};
const tunnelRoomsOf = (a: ArenaData) => new Map<string, [string, string]>(a.blueprint.tunnels.map((t) => [t.id, [t.a, t.b]]));

function randomCode(): string {
  const A = 'ABCDEFGHJKLMNQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s.startsWith('PUB') ? randomCode() : s;
}

// ------------------------------------------------------------------ boot
async function boot(): Promise<void> {
  const physics = initPhysics();
  const renderer = new Renderer(canvas);
  const input = new InputManager(canvas);
  const hud = new Hud(hudEl);
  hud.setVisible(false);
  const menu = new Menu(hudEl);
  const touch = new TouchControls(hudEl, input, { menu: () => openPause(), scoreboard: (on) => { hud.showScoreboard = on; } });
  const applyControlScheme = () => document.body.classList.toggle('touch-ui', touchMode());
  applyControlScheme();
  onSettings(applyControlScheme);
  /** phones: a match runs fullscreen and landscape where the browser allows it (needs the tap that started it) */
  const mobileFullscreen = () => {
    if (!touchMode() || document.fullscreenElement) return;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const p = el.requestFullscreen?.({ navigationUI: 'hide' }) ?? (el.webkitRequestFullscreen?.(), undefined);
    void Promise.resolve(p)
      .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))
      .catch(() => { /* not allowed here (iOS Safari): the rotate hint covers it */ });
  };
  const regionPing = pingRegions();

  await physics;
  const t0 = performance.now();
  let arena: ArenaData = arenaById(settings.arena);
  let arenaView: ArenaView = buildArena(arena);
  renderer.scene.add(arenaView.group);
  const lights = new LightRig(renderer.scene, arenaView, arena.adjacency, tunnelRoomsOf(arena));
  const applyAtmosphere = (a: ArenaData) => {
    const at = a.blueprint.atmosphere;
    if (at) {
      renderer.scene.fog = new THREE.FogExp2(at.fog.color, at.fog.density);
      renderer.scene.background = new THREE.Color(at.fog.color);
      renderer.scene.environmentIntensity = 0.22;
    } else {
      renderer.scene.fog = null;
      renderer.scene.background = new THREE.Color(0x020306);
      renderer.scene.environmentIntensity = 0.32;
    }
    lights.setAtmosphere(at);
  };
  applyAtmosphere(arena);
  // every zone's shaders at once, in parallel, instead of a stall the first time each floor comes into view
  const precompileArena = () => { void renderer.renderer.compileAsync(arenaView.group, renderer.camera, renderer.scene); };
  precompileArena();
  const effects = new Effects(renderer.scene);
  const shipR = new ShipRenderer(renderer.scene, effects);
  const projR = new ProjectileRenderer(renderer.scene);
  const missileR = new MissileRenderer(renderer.scene, effects);
  const pickupR = new PickupRenderer(renderer.scene);
  const powerupR = new PowerupRenderer(renderer.scene, effects);
  const checkpointR = new CheckpointRenderer(renderer.scene);
  const camRig = new CameraRig(renderer.camera);
  const presenter = new Presenter(effects, shipR, camRig, renderer.camera);
  console.info(`arena ready in ${(performance.now() - t0).toFixed(0)} ms`);

  let session: Session | null = null;
  let connecting = false;
  let paused = false;
  let deathAt = 0;
  let deathPos = new THREE.Vector3();
  let wasAlive = false;
  let lastPlace: string | null = null;
  const losCache = new Map<number, { t: number; vis: boolean }>();
  const urlRoom = new URLSearchParams(location.search).get('room')?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

  const useArena = (a: ArenaData) => {
    if (a === arena) return;
    const t1 = performance.now();
    renderer.scene.remove(arenaView.group);
    arenaView.dispose();
    arena = a;
    arenaView = buildArena(a);
    renderer.scene.add(arenaView.group);
    lights.setArena(arenaView, a.adjacency, tunnelRoomsOf(a));
    applyAtmosphere(a);
    precompileArena();
    lastPlace = null;
    losCache.clear();
    console.info(`${a.blueprint.name} ready in ${(performance.now() - t1).toFixed(0)} ms`);
  };

  // every tier change (settings, the auto probe, or `orange.renderer.setQuality` from a benchmark) applies the whole profile
  const applyProfile = (p: QualityProfile) => {
    effects.debrisEnabled = p.debris;
    effects.setDust(p.dust);
    effects.setBudget(p.particles);
    lights.dynamicLimit = p.dynamicLights;
    lights.setShadowQuality(p.shadows);
  };
  renderer.onQuality(applyProfile);
  applyProfile(renderer.profile);
  const applySettings = () => {
    if (settings.quality !== 'auto') renderer.setQuality(settings.quality);
    audio.applyVolumes();
  };
  onSettings(applySettings);
  applySettings();

  // ---------------------------------------------------------------- auto quality probe (2 s)
  let probe: { t: number; frames: number } | null = null;
  const startProbe = () => { if (settings.quality === 'auto') probe = { t: 0, frames: 0 }; };
  const stepProbe = (dt: number) => {
    if (!probe) return;
    probe.t += dt; probe.frames++;
    if (probe.t < 2) return;
    const fps = probe.frames / probe.t;
    probe = null;
    let q: Quality = renderer.quality;
    if (fps < 45) q = renderer.quality === 'high' ? 'default' : 'low';
    else if (fps > 100 && renderer.quality === 'default') q = 'high';
    if (q !== renderer.quality) { renderer.setQuality(q); applySettings(); console.info(`auto quality → ${q} (${fps.toFixed(0)} fps)`); if (q === 'low') startProbe(); }
  };

  // ---------------------------------------------------------------- menus
  const inviteLink = () => (session && (session.kind === 'quick' || session.kind === 'private') && session.room ? `${location.origin}${location.pathname}?room=${session.room}` : null);

  const showMain = () => {
    menu.showMain({
      quickPlay: () => void startOnline('quick', null),
      daily: () => void startOnline('daily', null),
      practice: () => startPractice(),
      createPrivate: () => void startOnline('private', randomCode()),
      joinPrivate: (code) => void startOnline('private', code),
      rankedFound: (room) => void startOnline('private', room),
      mapChanged: (id) => useArena(arenaById(id)),
      api: () => (bestRegion ? serverApi(bestRegion.origin) : null),
    }, urlRoom);
    audio.startMusic('menu');
  };

  let pauseOpenedAt = 0;
  const openPause = () => {
    if (!session) return;
    pauseOpenedAt = performance.now();
    paused = true;
    input.enabled = false;
    input.releaseLock();
    if (!session.source.online) session.source.setPaused(true);
    menu.showPause({ online: session.source.online, inviteLink: inviteLink(), resume, leave: () => endSession() });
  };

  const resume = () => {
    if (!session) return;
    menu.hide();
    paused = false;
    session.source.setPaused(false);
    input.enabled = true;
    input.requestLock();
  };

  const statusMessage = (s: NetStatus, detail?: string) => {
    if (s === 'live') {
      connecting = false;
      menu.hide();
      paused = false;
      input.enabled = true;
      input.requestLock();
      startProbe();
      return;
    }
    if (s === 'reload') {
      menu.showMessage('New version available', 'Reloading…');
      setTimeout(() => location.reload(), 1500);
      return;
    }
    if (s === 'full') {
      endSession(false);
      menu.showMessage('Room is full', 'All 8 slots are taken by players.', [{ label: 'Quick Play', fn: () => void startOnline('quick', null) }, { label: 'Back', fn: showMain }]);
      return;
    }
    if (s === 'lost') {
      const kind = session?.kind;
      const room = session?.room ?? null;
      if (kind === 'practice') { console.warn('offline worker failed, falling back to main thread', detail); endSession(false); startPractice(true); return; }
      endSession(false);
      menu.showMessage('Disconnected', detail ?? 'The connection to the server was lost.', [
        { label: 'Reconnect', fn: () => void startOnline(kind === 'private' || kind === 'daily' ? kind : 'quick', room) }, { label: 'Back to menu', fn: showMain },
      ]);
    }
  };

  const beginSession = (s: Session) => {
    session = s;
    hud.setVisible(true);
    hud.inviteLink = inviteLink();
    camRig.reset();
    effects.clear();
    wasAlive = false;
    audio.startMusic('match');
    if (settings.firstVisit) { settings.firstVisit = false; saveSettings(); }
  };

  const startOnline = async (kind: 'quick' | 'private' | 'daily', room: string | null) => {
    audio.unlock();
    mobileFullscreen();
    connecting = true;
    menu.showMessage('Connecting…', kind === 'private' ? `Room ${room}` : kind === 'daily' ? "Today's daily challenge" : 'Finding a match', [{ label: 'Cancel', fn: () => { endSession(); } }]);
    const region = bestRegion ?? { origin: location.origin, name: 'local', ping: 0 };
    let code = room;
    if (kind === 'quick') {
      try {
        const r = await fetch(`${region.origin}/quickplay?arena=${encodeURIComponent(settings.arena)}`, { cache: 'no-store' });
        code = ((await r.json()) as { room: string }).room;
      } catch {
        connecting = false;
        menu.showMessage('No server reachable', 'Online play needs the game server. Practice vs bots works offline.', [
          { label: 'Practice vs bots', fn: () => startPractice() }, { label: 'Back', fn: showMain },
        ]);
        return;
      }
    }
    if (!connecting) return;
    if (kind === 'private' && code) history.replaceState(null, '', `${location.pathname}?room=${code}`);
    const cls = settings.firstVisit ? 'dart' : settings.lastClass;
    const src = new OnlineSource(arena, input, settings.name || 'Pilot', cls, {
      makeTransport: () => new WsTransport(wsUrl(region.origin, code, kind === 'private', settings.arena, kind === 'daily')),
      offline: false,
      token: settings.token || undefined,
      onToken: (t) => { settings.token = t; saveSettings(); },
      onStatus: statusMessage,
      resolveArena: arenaById,
    });
    beginSession({ source: src, kind, room: code, origin: region.origin });
  };

  const startPractice = (mainThread = false) => {
    audio.unlock();
    mobileFullscreen();
    const cls: ClassId = settings.firstVisit ? 'dart' : settings.lastClass;
    const map = arenaById(settings.arena);
    let src: ViewSource;
    if (!mainThread && typeof Worker !== 'undefined') {
      connecting = true;
      menu.showMessage('Starting practice…', 'Spinning up bots');
      src = new OnlineSource(map, input, settings.name || 'Pilot', cls, {
        makeTransport: () => new WorkerTransport(settings.botSkill, map.blueprint.id), offline: true, onStatus: statusMessage,
        resolveArena: arenaById,
      });
    } else {
      src = new OfflineSource(input, settings.name || 'Pilot', cls, settings.botSkill, map);
      menu.hide();
      input.enabled = true;
      input.requestLock();
      paused = false;
      startProbe();
    }
    beginSession({ source: src, kind: 'practice', room: null, origin: '' });
  };

  const endSession = (toMenu = true) => {
    connecting = false;
    if (session) { session.source.dispose(); session = null; }
    shipR.update([], 0, 0);
    projR.update([]);
    missileR.update([], 0, renderer.camera);
    pickupR.update([], 0, renderer.camera);
    checkpointR.clear();
    effects.clear();
    audio.stopAllLoops();
    audio.engine(null);
    hud.setVisible(false);
    hud.inviteLink = null;
    input.enabled = false;
    input.releaseLock();
    paused = false;
    if (urlRoom || location.search) history.replaceState(null, '', location.pathname);
    if (toMenu) { useArena(arenaById(settings.arena)); showMain(); }
  };

  // ---------------------------------------------------------------- input wiring
  input.on('menu', () => {
    if (!session) { menu.goBack(); return; }
    if (menu.isOpen) { if (!menu.goBack() && !connecting && performance.now() - pauseOpenedAt > 400) resume(); } else openPause();
  });
  input.on('camera', () => { camRig.firstPerson = !camRig.firstPerson; settings.thirdPerson = !camRig.firstPerson; saveSettings(); });
  input.on('scoreboard', () => { hud.showScoreboard = true; });
  input.on('scoreboardUp', () => { hud.showScoreboard = false; });
  input.on('debug', () => { hud.showDebug = !hud.showDebug; });
  input.on('fullscreen', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().then(() => (navigator as unknown as { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.()).catch(() => {});
  });
  hud.onPickClass = (c) => {
    if (!session) return;
    session.source.setClass(c);
    session.source.setHold(true);
    settings.lastClass = c; saveSettings();
  };
  hud.onLaunch = () => {
    if (!session) return;
    hud.pickerOpen = false;
    session.source.setHold(false);
    input.requestLock();
  };
  hud.onCountdown = () => audio.play('beep', { bus: 'ui' });

  window.addEventListener('keydown', (e) => {
    if (!session || menu.isOpen || e.repeat) return;
    if (e.target instanceof HTMLInputElement) return;
    const L = session.source.local();
    const m = /^Digit([1-4])$/.exec(e.code);
    if (m) {
      const c = CLASS_LIST[Number(m[1]) - 1]!.id;
      if (L && !L.alive) hud.pick(c);
      else { session.source.setClass(c); settings.lastClass = c; saveSettings(); hud.toast(`${CLASS_LIST[Number(m[1]) - 1]!.name.toUpperCase()} NEXT SPAWN`, '#fff', 1.4); }
    } else if (e.code === 'Space' && L && !L.alive && hud.pickerOpen) hud.onLaunch();
  });

  canvas.addEventListener('click', () => {
    audio.unlock();
    if (session && !menu.isOpen) { input.enabled = true; input.requestLock(); }
  });
  document.addEventListener('pointerlockchange', () => {
    if (!input.pointerLocked && session && !menu.isOpen && settings.mouseMode === 'direct') {
      const L = session.source.local();
      if (L?.alive !== false) openPause();
    }
  });
  window.addEventListener('keydown', () => audio.unlock(), { once: true });
  // a stray Ctrl+W / Cmd+W mid-match gets the browser's "Leave site?" prompt instead of closing the tab
  window.addEventListener('beforeunload', (e) => { if (session) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

  document.addEventListener('visibilitychange', () => {
    if (!session) return;
    if (document.hidden && !session.source.online && !paused) openPause();
  });

  // ---------------------------------------------------------------- frame loop
  const vA = new THREE.Vector3(), qA = new THREE.Quaternion(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const viewMap = new Map<number, ShipView>();
  let last = performance.now();
  let fpsAvg = 60;

  const frame = (nowMs: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (nowMs - last) / 1000));
    last = nowMs;
    fpsAvg += (1 / Math.max(dt, 1e-3) - fpsAvg) * 0.05;
    const s = session;

    touch.setVisible(!!s && !menu.isOpen && touchMode());
    if (!s) {
      // menu backdrop: a slow drift through the hub (or the first room of other maps)
      const t = nowMs / 1000 * 0.05;
      const bd = arena.blueprint.atmosphere?.backdrop;
      if (bd) {
        renderer.camera.position.set(bd.target.x + Math.cos(t) * bd.radius, bd.target.y + bd.height + Math.sin(t * 0.7) * 12, bd.target.z + Math.sin(t) * bd.radius);
        renderer.camera.lookAt(bd.target.x, bd.target.y, bd.target.z);
      } else {
        const hub = arena.blueprint.rooms.find((r) => r.id === 'hub') ?? arena.blueprint.rooms[0]!;
        const orbit = hub.id === 'hub' ? 0.32 : 0.4;
        renderer.camera.position.set(hub.center.x + Math.cos(t) * hub.size.x * orbit, hub.center.y + Math.sin(t * 0.7) * 12, hub.center.z + Math.sin(t) * hub.size.z * orbit);
        renderer.camera.lookAt(hub.center.x, hub.center.y, hub.center.z);
      }
      renderer.setHorizontalFov(settings.fov);
      const place = arenaView.updateVisibility(renderer.camera.position);
      lights.updateStatic(place, renderer.camera.position);
      lights.updateDynamic(effects.lightRequests, renderer.camera.position);
      arenaView.animate(nowMs / 1000);
      effects.update(dt, renderer.camera);
      audio.update(dt);
      renderer.render(dt);
      return;
    }

    const src = s.source;
    src.update(dt);
    if (src.arena !== arena) useArena(src.arena);
    const ships = src.ships();
    viewMap.clear();
    for (const v of ships) viewMap.set(v.id, v);
    const L = src.local();
    const localView = ships.find((v) => v.isLocal) ?? null;
    const localId = L?.shipId ?? -1;
    const time = src.time();

    // camera
    let fov = settings.fov;
    if (L?.alive && localView) {
      if (!wasAlive) camRig.reset();
      vA.set(localView.pos.x, localView.pos.y, localView.pos.z);
      qA.set(localView.rot.x, localView.rot.y, localView.rot.z, localView.rot.w);
      vB.set(localView.vel.x, localView.vel.y, localView.vel.z);
      fov = camRig.follow(dt, vA, qA, vB, L.def, localView.boosting, src.world);
      deathPos.copy(vA);
      deathAt = time;
    } else if (L && !L.alive) {
      const killer = L.killerId >= 0 ? viewMap.get(L.killerId) : undefined;
      fov = camRig.deathCam(dt, deathPos, killer ? vC.set(killer.pos.x, killer.pos.y, killer.pos.z) : null, time - deathAt);
    }
    wasAlive = !!L?.alive;
    touch.setFlying(!!L?.alive && src.match().phase !== 'postMatch');
    if (touch.visible && L) touch.setReady(L.abilityCooldown <= 0 && L.abilityActive <= 0, L.tier.repel && L.repelCooldown <= 0);
    renderer.setHorizontalFov(fov);
    const camPos = renderer.camera.position;

    // events → effects / audio / HUD
    const events: GameEvent[] = src.drainEvents();
    const roster = src.roster();
    for (const e of events) {
      presenter.present(e, localId, viewMap, time);
      let attackerPos: THREE.Vector3 | null = null;
      if (e.t === 'hit' && e.targetId === localId) {
        const a = viewMap.get(e.attackerId);
        if (a) attackerPos = new THREE.Vector3(a.pos.x, a.pos.y, a.pos.z);
      }
      if (e.t === 'death' && e.victimId === localId) { deathPos.set(e.pos.x, e.pos.y, e.pos.z); deathAt = time; }
      hud.handleEvent(e, { localId, roster, camera: renderer.camera, attackerPos });
    }

    // world
    shipR.hideLocal = camRig.firstPerson && !!L?.alive;
    shipR.update(ships, dt, time);
    if (L?.alive && L.bulwarkHp > 0) shipR.setBulwarkHealth(localId, L.bulwarkHp / BULWARK_ABSORB);
    projR.update(src.projectiles());
    const missiles = src.missiles();
    missileR.update(missiles, dt, renderer.camera);
    pickupR.update(src.pickups(), time, renderer.camera);
    powerupR.update(src.powerup(), time, dt);
    const mv = src.match();
    const myCheckpoint = roster.find((r) => r.id === localId)?.checkpoint ?? 0;
    checkpointR.update(mv.mode === 'mine-run' && mv.phase === 'inProgress' ? mv.course : [], myCheckpoint, time);
    const extra: typeof effects.lightRequests = [];
    shipR.auraLights(extra);
    const placeId = arenaView.updateVisibility(camPos);
    lights.updateStatic(placeId, camPos);
    lights.updateDynamic(effects.lightRequests.concat(extra), camPos);
    arenaView.animate(time, src.envTick());
    effects.update(dt, renderer.camera);

    // audio
    renderer.camera.getWorldDirection(vB);
    vC.set(0, 1, 0).applyQuaternion(renderer.camera.quaternion);
    audio.setListener(camPos, vB, vC);
    const place = placeAt(arena, camPos);
    if ((place?.id ?? null) !== lastPlace) {
      lastPlace = place?.id ?? null;
      const room = place?.kind === 'room' ? arena.blueprint.rooms.find((r) => r.id === place.id) : undefined;
      audio.setPlace(room ? (room.ambience ?? AMBIENCE_OF[room.theme]) : null, place?.kind === 'tunnel');
    }
    if (L?.alive && localView) {
      const speed = Math.hypot(localView.vel.x, localView.vel.y, localView.vel.z);
      audio.engine({ faction: L.def.faction, speed01: Math.min(1, speed / (L.def.maxSpeed.fwd * L.def.boostSpeedMult)), boosting: localView.boosting, alive: true });
    } else audio.engine(null);
    audio.loop('missileAlarm', !!L?.alive && L.missileWarn > 0, 0.7);
    audio.loop('lockBeep', !!L?.alive && ((L.lockWarn > 0 && L.missileWarn === 0) || (L.lockProgress > 0 && !L.locked)), 0.5);
    audio.update(dt);

    // HUD
    const net = src.netStats();
    hud.update({
      dt, time, camera: renderer.camera, local: L, localView, ships, missiles, powerup: src.powerup(), roster, match: src.match(),
      place: place?.name ?? null, placeSub: place?.kind === 'tunnel' ? 'Tunnel' : null,
      net, warning: src.warning(), assist: input.assist, firstPerson: camRig.firstPerson, joystick: input.joystick,
      losTo: (id) => {
        const c = losCache.get(id);
        if (c && time - c.t < 0.1) return c.vis;
        const v = viewMap.get(id);
        const vis = !!v && lineOfSight(src.world, camPos, v.pos);
        losCache.set(id, { t: time, vis });
        return vis;
      },
      debug: {
        fps: fpsAvg.toFixed(0), quality: renderer.quality, draws: renderer.drawCalls, tris: renderer.triangles,
        place: placeId ?? '-', ...(net ? {
          ping: `${net.ping} ms`, jitter: `${net.jitter.toFixed(1)} ms`, loss: `${(net.loss * 100).toFixed(1)}%`,
          interp: `${net.interpDelay.toFixed(0)} ms`, snapAge: `${net.snapshotAge.toFixed(0)} ms`, corr: `${net.corrections.toFixed(2)}/s`,
          inBuf: net.bufferDepth, tick: net.serverTick, down: `${(net.bandwidthIn / 1024).toFixed(1)} KB/s`, up: `${(net.bandwidthOut / 1024).toFixed(1)} KB/s`,
        } : { mode: 'offline (main thread)' }),
      },
      online: src.online,
    });

    stepProbe(dt);
    renderer.render(dt);
  };

  // presence: "N pilots online · M in matches" on the menu, refreshed while it's up
  const tabId = presenceTabId();
  const pollPresence = () => {
    if (session || !bestRegion || document.hidden) return;
    serverApi(bestRegion.origin).presence(tabId).then((c) => {
      menu.setPresence(`${c.online} ${c.online === 1 ? 'pilot' : 'pilots'} online · ${c.inMatch} in matches`);
    }).catch(() => menu.setPresence(null));
  };
  setInterval(pollPresence, 20_000);

  void regionPing.then((r) => {
    bestRegion = r;
    menu.regionText = r ? `Region ${r.name} · ${Math.round(r.ping)} ms` : 'No server found — Practice works offline';
    if (!session && menu.isOpen && !connecting && menu.screen === 'main') showMain();
    pollPresence();
  });

  /**
   * JSON-safe state snapshot for the headless repro harness (packages/client/repro) and for bug reports.
   * Scenario files read these fields by name: extend the shape, don't rename fields.
   */
  const stateProbe = () => {
    const src = session?.source ?? null;
    const L = src?.local() ?? null;
    const m = src?.match() ?? null;
    const roster = src?.roster() ?? [];
    const me = L ? roster.find((r) => r.id === L.shipId) : undefined;
    const v = src?.ships().find((s) => s.isLocal);
    const net = src?.netStats() ?? null;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return {
      version: BUILD_VERSION, buildTime: __BUILD_TIME__,
      mode: session ? session.kind : 'menu', online: src?.online ?? false, connecting, paused,
      menu: menu.screen, arena: arena.blueprint.id, fps: Math.round(fpsAvg), quality: renderer.quality,
      pointerLocked: input.pointerLocked, inputEnabled: input.enabled, touchControls: touch.visible,
      controlScheme: touchMode() ? 'touch' : 'kbm',
      ping: net ? Math.round(net.ping) : null, corrections: net ? r1(net.corrections) : null,
      phase: m?.phase ?? null, timeLeft: m ? Math.round(m.timeLeft) : null,
      alive: L?.alive ?? null, classId: L ? L.def.id : null, hull: L ? r1(L.hull) : null, shield: L ? r1(L.shield) : null,
      power: L?.power ?? null, tier: L?.tier.index ?? null,
      pos: v ? { x: r1(v.pos.x), y: r1(v.pos.y), z: r1(v.pos.z) } : null,
      speed: v ? r1(Math.hypot(v.vel.x, v.vel.y, v.vel.z)) : null,
      kills: me?.kills ?? null, deaths: me?.deaths ?? null,
      gameMode: m?.mode ?? null, wave: m?.wave ?? null, score: me?.score ?? null, checkpoint: me?.checkpoint ?? null,
      courseLength: m?.course.length ?? null,
      ships: roster.length, bots: roster.filter((r) => r.isBot).length, humans: roster.filter((r) => !r.isBot).length,
    };
  };
  // effects and lights are here for poking at visuals from the console (e.g. orange.effects.fireball(...))
  (window as unknown as { orange: unknown }).orange = { get session() { return session; }, renderer, settings, effects, lights, probe: stateProbe };

  bootEl.classList.add('gone');
  setTimeout(() => bootEl.remove(), 600);
  showMain();
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  bootEl.innerHTML = `<div class="boot-title">PROJECT ORANGE</div><div class="boot-sub">Failed to start: ${String(e?.message ?? e)}</div>`;
});

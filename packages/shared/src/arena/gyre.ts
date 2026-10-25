import { v3, type V3 } from '../math.js';
import { Rng } from '../rng.js';
import { doorLanes, sphereHitsLanes, type Blueprint, type Mover, type Prop, type Room, type SafeZone, type Tunnel } from './blueprint.js';
import { moverClearance, moverSweeps } from './movers.js';

/**
 * The Gyre: five big halls. A 260 m central hall with a spinning rotor and two counter-rotating boulder rings,
 * ringed by four outer halls with their own machinery and a safe-zone spawn bay against the far wall.
 * Spokes link the center to each hall; corner tunnels link neighboring halls.
 */
const W = 4;
const p = (x: number, y: number, z: number) => v3(x, y, z);

export const GYRE_ROOMS: Room[] = [
  { id: 'gyre', name: 'The Gyre', center: p(0, 0, 0), size: p(260, 160, 260), wall: W, landmark: 0xe8f0ff, theme: 'refinery' },
  { id: 'quarry', name: 'Tumble Quarry', center: p(340, 0, 0), size: p(220, 150, 220), wall: W, landmark: 0x9a6bff, theme: 'rock' },
  { id: 'shutters', name: 'Shutter Works', center: p(0, 0, -340), size: p(220, 110, 200), wall: W, landmark: 0xff3fa0, theme: 'industrial' },
  { id: 'gantry', name: 'Gantry Hangar', center: p(-340, 0, 0), size: p(240, 100, 200), wall: W, landmark: 0x3f8cff, theme: 'hangar' },
  { id: 'halo', name: 'Halo Reactor', center: p(0, 0, 340), size: p(200, 220, 200), wall: W, landmark: 0x4cff7a, theme: 'reactor' },
];

export const GYRE_TUNNELS: Tunnel[] = [
  { id: 'G1', a: 'gyre', b: 'quarry', side: 32, theme: 'tunnel', path: [p(130, -20, 0), p(230, -20, 0)] },
  { id: 'G2', a: 'gyre', b: 'shutters', side: 32, theme: 'tunnel', path: [p(0, 15, -130), p(0, 15, -240)] },
  { id: 'G3', a: 'gyre', b: 'gantry', side: 32, theme: 'tunnel', path: [p(-130, -10, 0), p(-220, -10, 0)] },
  { id: 'G4', a: 'gyre', b: 'halo', side: 32, theme: 'tunnel', path: [p(0, 20, 130), p(0, 20, 240)] },
  { id: 'R1', a: 'quarry', b: 'shutters', side: 26, theme: 'tunnel', path: [p(340, 25, -110), p(340, 25, -340), p(110, 25, -340)] },
  { id: 'R2', a: 'shutters', b: 'gantry', side: 26, theme: 'tunnel', path: [p(-110, -20, -340), p(-340, -20, -340), p(-340, -20, -100)] },
  { id: 'R3', a: 'gantry', b: 'halo', side: 26, theme: 'tunnel', path: [p(-340, 25, 100), p(-340, 25, 340), p(-100, 25, 340)] },
  { id: 'R4', a: 'halo', b: 'quarry', side: 26, theme: 'tunnel', path: [p(100, -20, 340), p(340, -20, 340), p(340, -20, 110)] },
];

export const GYRE_SAFE_ZONES: SafeZone[] = [
  { id: 'quarry-bay', room: 'quarry', center: p(416, 0, 0), radius: 28 },
  { id: 'shutters-bay', room: 'shutters', center: p(0, 0, -406), radius: 28 },
  { id: 'gantry-bay', room: 'gantry', center: p(-426, 0, 0), radius: 28 },
  { id: 'halo-bay', room: 'halo', center: p(60, -76, 400), radius: 28 },
];

const roomById = (id: string) => GYRE_ROOMS.find((r) => r.id === id)!;
const TAU = Math.PI * 2;

function buildMovers(rng: Rng): Mover[] {
  const movers: Mover[] = [];

  // The Gyre: a floating rotor with three arms, and two boulder rings turning the other way above and below it
  {
    const room = 'gyre';
    const parts: Prop[] = [
      { room, kind: 'cylinder', center: p(0, 0, 0), radius: 12, height: 44, axis: 'y', collides: true, material: 'metal' },
      { room, kind: 'crystal', center: p(0, 22, 0), dir: p(0, 1, 0), length: 16, radius: 5, collides: true, material: 'crystal', emissive: 0xe8f0ff },
      { room, kind: 'crystal', center: p(0, -22, 0), dir: p(0, -1, 0), length: 16, radius: 5, collides: true, material: 'crystal', emissive: 0xe8f0ff },
    ];
    for (const y of [-14, 0, 14]) parts.push({ room, kind: 'ring', center: p(0, y, 0), radius: 12.3, tube: 0.7, axis: 'y', collides: false, material: 'emissive', emissive: 0xe8f0ff });
    for (let k = 0; k < 3; k++) {
      const a = (k * TAU) / 3, c = Math.cos(a), s = Math.sin(a);
      parts.push({ room, kind: 'box', center: p(c * 40, 0, s * 40), size: p(56, 5, 9), rotY: -a, collides: true, material: 'darkMetal' });
      parts.push({ room, kind: 'box', center: p(c * 40, 2.6, s * 40), size: p(50, 0.3, 1.4), rotY: -a, collides: false, material: 'emissive', emissive: 0xe8f0ff });
      parts.push({ room, kind: 'box', center: p(c * 73, 0, s * 73), size: p(10, 12, 14), rotY: -a, collides: true, material: 'hazard' });
    }
    movers.push({ id: 'gyre-rotor', room, origin: p(0, 0, 0), parts, motion: { kind: 'spin', axis: 'y', period: 40 } });

    const halo: Prop[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k * TAU) / 6;
      halo.push({ room, kind: 'rock', center: p(Math.cos(a) * 92, 52, Math.sin(a) * 92), radius: 7, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
    }
    movers.push({ id: 'gyre-halo', room, origin: p(0, 52, 0), parts: halo, motion: { kind: 'spin', axis: 'y', period: -64 } });

    const under: Prop[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * TAU) / 4 + Math.PI / 4;
      under.push({ room, kind: 'rock', center: p(Math.cos(a) * 70, -50, Math.sin(a) * 70), radius: 9, squash: 0.55, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
    }
    movers.push({ id: 'gyre-underhalo', room, origin: p(0, -50, 0), parts: under, motion: { kind: 'spin', axis: 'y', period: 52 } });
  }

  // Tumble Quarry: a slow vertical wheel of boulders on glowing tethers
  {
    const room = 'quarry', o = p(320, 0, 0);
    const parts: Prop[] = [{ room, kind: 'rock', center: o, radius: 7, seed: rng.int(1, 1e9), collides: true, material: 'rock' }];
    for (let k = 0; k < 5; k++) {
      const a = (k * TAU) / 5, dir = p(Math.cos(a), Math.sin(a), 0);
      parts.push({ room, kind: 'rock', center: p(o.x + dir.x * 44, o.y + dir.y * 44, o.z), radius: 8, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
      parts.push({ room, kind: 'crystal', center: o, dir, length: 37, radius: 0.6, collides: false, material: 'emissive', emissive: 0x9a6bff });
    }
    movers.push({ id: 'quarry-wheel', room, origin: o, parts, motion: { kind: 'spin', axis: 'z', period: 30 } });
  }

  // Shutter Works: two sliding walls that cross in opposite directions, and two pistons pumping out of phase
  {
    const room = 'shutters';
    const shutter = (id: string, o: V3, dx: number): Mover => ({
      id, room, origin: o, motion: { kind: 'slide', offset: p(dx, 0, 0), period: 16 },
      parts: [
        { room, kind: 'box', center: o, size: p(60, 46, 4), collides: true, material: 'darkMetal' },
        // edge caps overhang the panel on every side so no faces are coplanar (z-fighting)
        { room, kind: 'box', center: p(o.x - 29.2, o.y, o.z), size: p(2.4, 46.4, 4.4), collides: false, material: 'hazard' },
        { room, kind: 'box', center: p(o.x + 29.2, o.y, o.z), size: p(2.4, 46.4, 4.4), collides: false, material: 'hazard' },
        { room, kind: 'box', center: p(o.x, o.y + 20, o.z), size: p(54, 0.6, 4.4), collides: false, material: 'emissive', emissive: 0xff3fa0 },
        { room, kind: 'box', center: p(o.x, o.y - 20, o.z), size: p(54, 0.6, 4.4), collides: false, material: 'emissive', emissive: 0xff3fa0 },
      ],
    });
    movers.push(shutter('shutter-a', p(-35, 0, -322), 70));
    movers.push(shutter('shutter-b', p(35, 0, -358), -70));
    const piston = (id: string, o: V3, dy: number): Mover => ({
      id, room, origin: o, motion: { kind: 'slide', offset: p(0, dy, 0), period: 10 },
      parts: [
        { room, kind: 'box', center: o, size: p(30, 20, 30), collides: true, material: 'metal' },
        { room, kind: 'box', center: p(o.x, o.y - 10.2, o.z), size: p(26, 0.4, 26), collides: false, material: 'hazard' },
        { room, kind: 'box', center: p(o.x, o.y, o.z), size: p(30.4, 1, 30.4), collides: false, material: 'emissive', emissive: 0xff3fa0 },
      ],
    });
    movers.push(piston('press-west', p(-65, 15, -280), -35));
    movers.push(piston('press-east', p(65, -20, -280), 35));
  }

  // Gantry Hangar: a ceiling crane hauling a container back and forth
  {
    const room = 'gantry', o = p(-350, 20, 0);
    const parts: Prop[] = [
      { room, kind: 'box', center: o, size: p(6, 4, 140), collides: true, material: 'darkMetal' },
      { room, kind: 'box', center: p(o.x, o.y - 2.2, o.z), size: p(1, 0.4, 130), collides: false, material: 'emissive', emissive: 0x3f8cff },
      { room, kind: 'box', center: p(o.x, o.y - 4, o.z), size: p(12, 4, 12), collides: true, material: 'hazard' },
      { room, kind: 'box', center: p(o.x, o.y - 18, o.z), size: p(14, 12, 28), rounded: 1.2, collides: true, material: 'metal' },
    ];
    for (const [dx, dz] of [[-5, -10], [5, -10], [-5, 10], [5, 10]] as const) {
      parts.push({ room, kind: 'cylinder', center: p(o.x + dx, o.y - 9, o.z + dz), radius: 0.3, height: 6, axis: 'y', collides: false, material: 'metal' });
    }
    movers.push({ id: 'gantry-crane', room, origin: o, parts, motion: { kind: 'slide', offset: p(80, 0, 0), period: 24 } });
  }

  // Halo Reactor: rings of shield plates orbiting the core at three heights, alternating direction
  {
    const room = 'halo', c = roomById(room).center;
    const ring = (id: string, y: number, n: number, radius: number, size: V3, period: number): Mover => {
      const o = p(c.x, c.y + y, c.z);
      const parts: Prop[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k * TAU) / n + y * 0.01, cx = Math.cos(a), sz = Math.sin(a);
        parts.push({ room, kind: 'box', center: p(o.x + cx * radius, o.y, o.z + sz * radius), size, rotY: -(a + Math.PI / 2), collides: true, material: 'darkMetal' });
        parts.push({
          room, kind: 'box', center: p(o.x + cx * (radius - 1.7), o.y, o.z + sz * (radius - 1.7)), size: p(size.x - 2, 0.6, 0.4),
          rotY: -(a + Math.PI / 2), collides: false, material: 'emissive', emissive: 0x4cff7a,
        });
      }
      return { id, room, origin: o, parts, motion: { kind: 'spin', axis: 'y', period } };
    };
    movers.push(ring('halo-low', -40, 3, 50, p(26, 18, 3), 26));
    movers.push(ring('halo-mid', 15, 4, 62, p(30, 22, 3), -34));
    movers.push(ring('halo-high', 70, 3, 44, p(26, 18, 3), 22));
  }
  return movers;
}

function buildProps(rng: Rng, movers: Mover[]): Prop[] {
  const props: Prop[] = [];
  const sweeps = movers.flatMap(moverSweeps);
  const at = (r: Room, x: number, y: number, z: number) => p(r.center.x + x, r.center.y + y, r.center.z + z);
  const zones = (room: string) => GYRE_SAFE_ZONES.filter((z) => z.room === room);
  /** Scatter rocks that keep clear of doors, mover paths, safe zones and each other. */
  const scatter = (r: Room, count: number, rad: [number, number]) => {
    const lanes = doorLanes(r, 45, 6, GYRE_TUNNELS);
    const h = p(r.size.x / 2, r.size.y / 2, r.size.z / 2);
    let placed = 0;
    for (let tries = 0; placed < count && tries < 600; tries++) {
      const rr = rng.range(rad[0], rad[1]);
      const rel = p(rng.range(-h.x, h.x), rng.range(-h.y, h.y), rng.range(-h.z, h.z));
      if (Math.abs(rel.x) > h.x - rr - 6 || Math.abs(rel.y) > h.y - rr - 6 || Math.abs(rel.z) > h.z - rr - 6) continue;
      if (sphereHitsLanes(rel, rr + 2, lanes)) continue;
      const c = at(r, rel.x, rel.y, rel.z);
      if (moverClearance(sweeps, c) < rr * 1.15 + 20) continue;
      if (zones(r.id).some((z) => Math.hypot(c.x - z.center.x, c.y - z.center.y, c.z - z.center.z) < z.radius + rr + 8)) continue;
      if (props.some((q) => q.room === r.id && (q.kind === 'rock' || q.kind === 'pillar')
        && Math.hypot(q.center.x - c.x, (q.kind === 'pillar' ? 0 : q.center.y - c.y), q.center.z - c.z) < q.radius + rr + 10)) continue;
      props.push({ room: r.id, kind: 'rock', center: c, radius: rr, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
      placed++;
    }
  };

  // The Gyre: rock columns in the corners, scattered cover around the rotor
  {
    const r = roomById('gyre');
    for (const [x, z] of [[-100, -100], [100, -100], [-100, 100], [100, 100]] as const) {
      props.push({ room: r.id, kind: 'pillar', center: at(r, x, 0, z), radius: 10, height: r.size.y + 6, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
    }
    for (const y of [-79.9, 79.9]) {
      props.push({ room: r.id, kind: 'ring', center: at(r, 0, y, 0), radius: 60, tube: 0.6, axis: 'y', collides: false, material: 'emissive', emissive: 0xe8f0ff });
    }
    scatter(r, 12, [5, 9]);
  }

  // Tumble Quarry: rock spires, boulders and crystal clusters on the floor
  {
    const r = roomById('quarry');
    const floor = -r.size.y / 2;
    for (const [x, z] of [[-60, -70], [-60, 70], [36, -75], [36, 75]] as const) {
      props.push({ room: r.id, kind: 'pillar', center: at(r, x, 0, z), radius: 10, height: r.size.y + 6, seed: rng.int(1, 1e9), collides: true, material: 'rock' });
    }
    scatter(r, 10, [4, 8]);
    const lanes = doorLanes(r, 45, 6, GYRE_TUNNELS);
    let crystals = 0;
    for (let tries = 0; crystals < 8 && tries < 400; tries++) {
      const x = rng.range(-90, 90), z = rng.range(-90, 90);
      const dir = p(rng.range(-0.5, 0.5), 1, rng.range(-0.5, 0.5));
      const l = Math.hypot(dir.x, dir.y, dir.z); dir.x /= l; dir.y /= l; dir.z /= l;
      const len = rng.range(14, 22);
      const base = at(r, x, floor + 1, z);
      const rel = p(x, floor + 1 + len / 2, z);
      if (sphereHitsLanes(rel, len / 2 + 3, lanes)) continue;
      if (moverClearance(sweeps, p(base.x + dir.x * len / 2, base.y + dir.y * len / 2, base.z + dir.z * len / 2)) < len / 2 + 20) continue;
      if (zones(r.id).some((zz) => Math.hypot(base.x - zz.center.x, base.z - zz.center.z) < zz.radius + 8)) continue;
      if (props.some((q) => q.room === r.id && Math.hypot(q.center.x - base.x, q.center.z - base.z) < ('radius' in q ? q.radius : 0) + 10)) continue;
      props.push({ room: r.id, kind: 'crystal', center: base, dir, length: len, radius: rng.range(2.2, 3.4), collides: true, material: 'crystal', emissive: 0x9a6bff });
      crystals++;
    }
  }

  // Shutter Works: tanks flanking the bay, ceiling girders, slag channels
  {
    const r = roomById('shutters');
    const floor = -r.size.y / 2;
    for (const x of [-70, 70]) {
      props.push({ room: r.id, kind: 'cylinder', center: at(r, x, floor + 25, -70), radius: 10, height: 50, axis: 'y', collides: true, material: 'darkMetal' });
      props.push({ room: r.id, kind: 'ring', center: at(r, x, floor + 40, -70), radius: 10.15, tube: 0.4, axis: 'y', collides: false, material: 'emissive', emissive: 0xff3fa0 });
    }
    for (const z of [-30, 30]) props.push({ room: r.id, kind: 'box', center: at(r, 0, r.size.y / 2 - 3, z), size: p(r.size.x, 3, 3), collides: true, material: 'metal' });
    for (const z of [-60, 60]) props.push({ room: r.id, kind: 'box', center: at(r, 0, floor + 0.05, z), size: p(200, 0.1, 2.4), collides: false, material: 'emissive', emissive: 0xff3fa0 });
  }

  // Gantry Hangar: parked shuttles and floor guide lights
  {
    const r = roomById('gantry');
    const floor = -r.size.y / 2;
    for (const [x, z] of [[-50, -45], [-50, 45], [50, -45], [50, 45]] as const) {
      props.push({ room: r.id, kind: 'box', center: at(r, x, floor + 6, z), size: p(40, 12, 16), rounded: 2.5, collides: true, material: 'metal' });
    }
    for (let i = -5; i <= 5; i++) {
      props.push({ room: r.id, kind: 'box', center: at(r, i * 18, floor + 0.08, 0), size: p(1.2, 0.12, 40), collides: false, material: 'emissive', emissive: 0x3f8cff });
    }
    for (const z of [-r.size.z / 2 + 0.6, r.size.z / 2 - 0.6]) {
      props.push({ room: r.id, kind: 'box', center: at(r, 0, r.size.y / 2 - 8, z), size: p(200, 1, 0.4), collides: false, material: 'emissive', emissive: 0x3f8cff });
    }
  }

  // Halo Reactor: the core column
  {
    const r = roomById('halo');
    props.push({ room: r.id, kind: 'cylinder', center: at(r, 0, 0, 0), radius: 14, height: r.size.y, axis: 'y', collides: true, material: 'metal' });
    for (let y = -90; y <= 90; y += 30) {
      props.push({ room: r.id, kind: 'ring', center: at(r, 0, y, 0), radius: 14.2, tube: 0.8, axis: 'y', collides: false, material: 'emissive', emissive: 0x4cff7a });
    }
  }
  return props;
}

export const GYRE_SEED = 0x67e2e;
export function gyre(): Blueprint {
  const rng = new Rng(GYRE_SEED);
  const movers = buildMovers(rng);
  return {
    id: 'gyre', name: 'The Gyre', rooms: GYRE_ROOMS, tunnels: GYRE_TUNNELS, props: buildProps(rng, movers), seed: GYRE_SEED,
    movers, safeZones: GYRE_SAFE_ZONES,
  };
}

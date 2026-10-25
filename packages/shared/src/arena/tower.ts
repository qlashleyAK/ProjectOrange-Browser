import { v3, type V3 } from '../math.js';
import { Rng } from '../rng.js';
import type { Blueprint, Prop, PropMaterial, Room, Tunnel } from './blueprint.js';

/**
 * Meridian Tower: an abandoned high-rise, four stacked fighting floors. A parking garage full of pillars,
 * a cubicle farm, an executive floor of walled offices, and an open rooftop with one AC unit under a
 * starry black sky. Elevator shafts stuffed with oranges link neighboring floors at alternating corners,
 * so crossing a floor means crossing the fight; two freight shafts outside the walls skip a floor.
 */
const W = 4;
const p = (x: number, y: number, z: number) => v3(x, y, z);

export const TOWER_ROOMS: Room[] = [
  {
    id: 'roof', name: 'Rooftop', center: p(0, 195, 0), size: p(340, 130, 260), wall: W, landmark: 0x7fa8ff, theme: 'roof',
    light: { color: 0x9fb8ff, scale: 0.5 },
  },
  {
    id: 'exec', name: 'Executive Floor', center: p(0, 35, 0), size: p(340, 50, 260), wall: W, landmark: 0xc07bff, theme: 'office',
    light: { color: 0xdde4ff, scale: 0.85 }, navGrid: { step: 40, ys: [17] },
  },
  {
    id: 'cubes', name: 'Cubicle Farm', center: p(0, -85, 0), size: p(340, 50, 260), wall: W, landmark: 0x2fe0c0, theme: 'office',
    light: { color: 0xdcfff2, scale: 0.85 }, navGrid: { step: 46, ys: [8] },
  },
  {
    id: 'garage', name: 'Parking Garage', center: p(0, -200, 0), size: p(340, 40, 260), wall: W, landmark: 0xff4f8a, theme: 'garage',
    light: { color: 0xe6f2b8, scale: 0.7 }, navGrid: { step: 50, ys: [0] },
  },
];

/** Shaft corners (x, z); each pair of floors uses the two corners the floor below doesn't. */
const A = [-125, -100] as const, B = [125, 100] as const, C = [125, -100] as const, D = [-125, 100] as const;
const shaft = (id: string, a: string, b: string, [x, z]: readonly [number, number], y0: number, y1: number): Tunnel =>
  ({ id, a, b, side: 26, theme: 'shaft', oranges: 4, path: [p(x, y0, z), p(x, y1, z)] });

export const TOWER_TUNNELS: Tunnel[] = [
  shaft('S1', 'garage', 'cubes', A, -180, -110),
  shaft('S2', 'garage', 'cubes', B, -180, -110),
  shaft('S3', 'cubes', 'exec', C, -60, 10),
  shaft('S4', 'cubes', 'exec', D, -60, 10),
  shaft('S5', 'exec', 'roof', A, 60, 130),
  shaft('S6', 'exec', 'roof', B, 60, 130),
  {
    id: 'X1', a: 'garage', b: 'exec', side: 26, theme: 'shaft', bonus: true, label: 'west freight shaft',
    path: [p(-170, -200, 0), p(-215, -200, 0), p(-215, 35, 0), p(-170, 35, 0)],
  },
  {
    id: 'X2', a: 'cubes', b: 'roof', side: 26, theme: 'shaft', bonus: true, label: 'east freight shaft',
    path: [p(170, -85, 0), p(215, -85, 0), p(215, 95, 0), p(60, 95, 0), p(60, 130, 0)],
  },
];

export const TOWER_SPAWNS: { room: string; pos: V3 }[] = [
  { room: 'roof', pos: p(0, 160, -100) }, { room: 'roof', pos: p(0, 160, 100) }, { room: 'roof', pos: p(-140, 160, 20) },
  { room: 'exec', pos: p(100, 35, 0) }, { room: 'exec', pos: p(-20, 35, 62) }, { room: 'exec', pos: p(20, 35, -62) },
  { room: 'cubes', pos: p(0, -75, -105) }, { room: 'cubes', pos: p(0, -75, 105) }, { room: 'cubes', pos: p(-140, -75, 0) },
  { room: 'garage', pos: p(25, -200, -105) }, { room: 'garage', pos: p(-25, -200, 105) }, { room: 'garage', pos: p(125, -200, 0) },
];

export const BEACON_RED = 0xff2a4a;
const LAMP = 0xeef6e4;
const PAINT_WHITE = 0xc9ced6, PAINT_YELLOW = 0xc8d040;
const CAR_COLORS = [0x5a1f2a, 0x2b3f5c, 0x6b7076, 0xb9bec4, 0x24382e, 0x3a3d44];

const roomById = (id: string) => TOWER_ROOMS.find((r) => r.id === id)!;

function buildProps(rng: Rng): Prop[] {
  const props: Prop[] = [];
  const box = (room: string, center: V3, size: V3, material: PropMaterial, collides: boolean, extra: Partial<Prop> = {}) =>
    props.push({ room, kind: 'box', center, size, material, collides, ...extra } as Prop);
  const holesOf = (room: string) => TOWER_TUNNELS.flatMap((t) => [[t.a, t.path[0]!], [t.b, t.path[t.path.length - 1]!]] as const)
    .filter(([r, pt]) => r === room && Math.abs(Math.abs(pt.y - roomById(room).center.y) - roomById(room).size.y / 2) < 0.01)
    .map(([, pt]) => pt);
  const nearHole = (room: string, x: number, z: number, d: number) => holesOf(room).some((h) => Math.abs(h.x - x) < 13 + d && Math.abs(h.z - z) < 13 + d);

  /** Window panes onto the night sky along every outer wall, leaving mullions of bare wall between them. */
  const windows = (r: Room, skipNear: (axis: 'x' | 'z', side: number, along: number) => boolean) => {
    const floor = r.center.y - r.size.y / 2, hx = r.size.x / 2, hz = r.size.z / 2;
    for (const side of [-1, 1]) {
      for (let x = -156; x <= 156; x += 12) {
        if (!skipNear('z', side, x)) box(r.id, p(r.center.x + x, floor + 22, r.center.z + side * (hz - 0.25)), p(9, 32, 0.2), 'sky', false);
      }
      for (let z = -120; z <= 120; z += 12) {
        if (!skipNear('x', side, z)) box(r.id, p(r.center.x + side * (hx - 0.25), floor + 22, r.center.z + z), p(0.2, 32, 9), 'sky', false);
      }
    }
  };

  /** Ceiling light panels, most of them dead. */
  const ceilingLights = (r: Room, step: number, litShare: number) => {
    const ceil = r.center.y + r.size.y / 2;
    const nx = Math.floor((r.size.x - 20) / step), nz = Math.floor((r.size.z - 20) / step);
    for (let i = 0; i <= nx; i++) for (let k = 0; k <= nz; k++) {
      const x = (i - nx / 2) * step, z = (k - nz / 2) * step;
      if (nearHole(r.id, x, z, 6)) continue;
      const lit = rng.chance(litShare);
      box(r.id, p(x, ceil - 0.4, z), p(6, 0.4, 3), lit ? 'emissive' : 'darkMetal', false, lit ? { emissive: LAMP } : {});
    }
  };

  /** Ceiling tiles hanging loose and lying in the aisles. */
  const debris = (r: Room, aisles: (rng: Rng) => [number, number], fallen: number, hanging: number) => {
    const floor = r.center.y - r.size.y / 2, ceil = r.center.y + r.size.y / 2;
    for (let i = 0; i < fallen; i++) {
      const [x, z] = aisles(rng);
      box(r.id, p(x, floor + 0.15, z), p(3, 0.25, 3), 'plaster', false, { rotY: rng.range(0, Math.PI) });
    }
    for (let i = 0; i < hanging; i++) {
      const x = rng.range(-150, 150), z = rng.range(-110, 110);
      if (nearHole(r.id, x, z, 6)) continue;
      box(r.id, p(x, ceil - 1.4, z), p(3, 0.25, 3), 'plaster', false, { rotY: rng.range(0, Math.PI), rotX: rng.range(0.7, 1.1) * (rng.chance(0.5) ? 1 : -1) });
    }
  };

  // ---------------------------------------------------------------- Parking Garage: a forest of pillars
  {
    const r = roomById('garage'), id = r.id;
    const floor = r.center.y - r.size.y / 2, ceil = r.center.y + r.size.y / 2;
    const cols = [-150, -100, -50, 0, 50, 100, 150], rows = [-75, -25, 25, 75];
    for (const x of cols) for (const z of rows) {
      box(id, p(x, r.center.y, z), p(7, r.size.y, 7), 'concrete', true);
      box(id, p(x, ceil - 1, z), p(11, 2, 11), 'concrete', true);
      box(id, p(x, floor + 1.5, z), p(7.6, 3, 7.6), 'hazard', false);
    }
    // ribbed ceiling: beams along both pillar lines (different depths, so their undersides never share a plane)
    for (const z of rows) box(id, p(0, ceil - 1.5, z), p(340, 3, 2), 'concrete', true);
    for (const x of cols) box(id, p(x, ceil - 1.7, 0), p(2, 3.4, 260), 'concrete', true);
    // tube fixtures in the bays, a few dead and a few hanging off one end
    for (const x of [-125, -75, -25, 25, 75, 125]) for (const z of [-102.5, -50, 0, 50, 102.5]) {
      if (nearHole(id, x, z, 8)) continue;
      const lit = rng.chance(0.65);
      const drop = !lit && rng.chance(0.35) ? rng.range(0.25, 0.45) * (rng.chance(0.5) ? 1 : -1) : 0;
      const yHang = drop ? ceil - 4 : ceil - 1.15;
      box(id, p(x, yHang, z), p(12.4, drop ? 0.8 : 2.3, 2), 'darkMetal', false, drop ? { rotZ: drop } : {});
      box(id, p(x, yHang - (drop ? 0.65 : 1.4), z), p(12, 0.5, 1.2), lit ? 'emissive' : 'darkMetal', false,
        { ...(lit ? { emissive: LAMP } : {}), ...(drop ? { rotZ: drop } : {}) });
    }
    // stall lines across each pillar row, lane dashes between them
    const lines: number[] = [];
    for (let x = -162.5; x <= 162.5; x += 12.5) if (cols.every((c) => Math.abs(x - c) >= 5)) lines.push(x);
    for (const z of rows) for (const x of lines) box(id, p(x, floor + 0.05, z), p(0.7, 0.1, 16), 'paint', false, { color: PAINT_WHITE });
    for (const z of [-106, -50, 0, 50, 106]) for (let x = -160; x <= 162; x += 14) box(id, p(x, floor + 0.05, z), p(6, 0.1, 0.7), 'paint', false, { color: PAINT_YELLOW });
    // abandoned cars in some of the stalls
    const stalls: [number, number][] = [];
    for (const z of rows) for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i + 1]! - lines[i]! < 13) stalls.push([(lines[i]! + lines[i + 1]!) / 2, z]);
    }
    for (let i = stalls.length - 1; i > 0; i--) { const j = rng.int(0, i + 1); [stalls[i], stalls[j]] = [stalls[j]!, stalls[i]!]; }
    for (const [x, z] of stalls.slice(0, 11)) {
      const color = CAR_COLORS[rng.int(0, CAR_COLORS.length)]!;
      const rotY = rng.range(-0.18, 0.18), dz = rng.range(-1.5, 1.5);
      const c = Math.cos(rotY), s = Math.sin(rotY);
      const at = (lx: number, ly: number, lz: number) => p(x + lx * c + lz * s, floor + ly, z + dz - lx * s + lz * c);
      box(id, at(0, 1.6, 0), p(5.2, 2.4, 11), 'paint', true, { color, rotY, rounded: 1 });
      box(id, at(0, 3.6, -0.6), p(4.6, 1.8, 6), 'paint', true, { color, rotY, rounded: 0.8 });
      for (const lx of [-2.45, 2.45]) for (const lz of [-3.6, 3.6]) {
        props.push({ room: id, kind: 'cylinder', center: at(lx, 0.8, lz), radius: 0.8, height: 0.6, axis: 'x', collides: false, material: 'darkMetal' });
      }
    }
    // a vehicle ramp up the south wall, broken off short of the ceiling, with rubble underneath
    const th = 0.42, len = 52, x0 = 58, zr = -118;
    box(id, p(x0 + (len / 2) * Math.cos(th), floor + (len / 2) * Math.sin(th) + 0.8 * Math.cos(th), zr), p(len, 1.6, 16), 'concrete', true, { rotZ: th });
    const top = p(x0 + len * Math.cos(th), floor + len * Math.sin(th) + 0.8, zr);
    box(id, p(top.x - 0.6, top.y + 2, zr), p(1, 4, 16), 'hazard', false);
    props.push({ room: id, kind: 'rock', center: p(top.x - 4, floor, zr + 2), radius: 5, squash: 0.5, seed: rng.int(1, 1e9), collides: true, material: 'concrete' });
    props.push({ room: id, kind: 'rock', center: p(top.x + 5, floor, zr - 2), radius: 3.5, squash: 0.6, seed: rng.int(1, 1e9), collides: true, material: 'concrete' });
  }

  // ---------------------------------------------------------------- Cubicle Farm: low partitions you can duck behind
  {
    const r = roomById('cubes'), id = r.id;
    const floor = r.center.y - r.size.y / 2;
    const H = 16, T = 1.2, REACH = 14;
    const columnAt = (x: number, z: number) => [-92, 0, 92].includes(x) && [-46, 46].includes(z);
    for (const x of [-92, 0, 92]) for (const z of [-46, 46]) {
      props.push({ room: id, kind: 'cylinder', center: p(x, r.center.y, z), radius: 3.2, height: r.size.y, axis: 'y', collides: true, material: 'concrete' });
    }
    const fabric = [0x4f5a66, 0x56606a, 0x4a5560];
    for (const x of [-138, -92, -46, 0, 46, 92, 138]) for (const z of [-92, -46, 0, 46, 92]) {
      if (nearHole(id, x, z, 25)) continue;
      if (x > 120 && Math.abs(z) < 20) continue; // the freight shaft door in the east wall
      const col = columnAt(x, z);
      const start = col ? 3.4 : 0.8;
      if (!col) box(id, p(x, floor + (H + 0.6) / 2, z), p(1.6, H + 0.6, 1.6), 'metal', true);
      const color = fabric[rng.int(0, fabric.length)]!;
      const fell = new Set<string>();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const roll = rng.next();
        const l = REACH - start, mid = start + l / 2;
        const alongX = dx !== 0;
        const cx = x + dx * mid, cz = z + dz * mid;
        if (roll < 0.08) continue;
        if (roll < 0.17) {
          // knocked flat into the neighboring cubicle
          const side = rng.chance(0.5) ? 1 : -1;
          fell.add(alongX ? `${dx},${side}` : `${side},${dz}`);
          box(id, alongX ? p(cx, floor + T / 2, cz + side * (H / 2 + 0.6)) : p(cx + side * (H / 2 + 0.6), floor + T / 2, cz),
            alongX ? p(l, T, H) : p(H, T, l), 'fabric', true, { color });
          continue;
        }
        if (roll < 0.25) {
          // leaning over
          const side = rng.chance(0.5) ? 1 : -1, th = 0.5;
          fell.add(alongX ? `${dx},${side}` : `${side},${dz}`);
          const y = floor + (H / 2) * Math.cos(th) + (T / 2) * Math.sin(th) - 0.15, off = (H / 2) * Math.sin(th);
          box(id, alongX ? p(cx, y, cz + side * off) : p(cx + side * off, y, cz), alongX ? p(l, H, T) : p(T, H, l), 'fabric', true,
            { color, ...(alongX ? { rotX: side * th } : { rotZ: -side * th }) });
          continue;
        }
        box(id, p(cx, floor + H / 2, cz), alongX ? p(l, H, T) : p(T, H, l), 'fabric', true, { color });
        box(id, p(cx, floor + H + 0.15, cz), alongX ? p(l, 0.3, T + 0.3) : p(T + 0.3, 0.3, l), 'metal', false);
      }
      // a desk in each quadrant nothing fell into
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        if (fell.has(`${sx},${sz}`) || !rng.chance(0.7)) continue;
        box(id, p(x + sx * 8, floor + 1.9, z + sz * 3.3), p(7, 3.8, 4.5), 'metal', true);
      }
    }
    ceilingLights(r, 23, 0.35);
    debris(r, (g) => {
      const ax = [-115, -69, -23, 23, 69, 115][g.int(0, 6)]!;
      return g.chance(0.5) ? [ax + g.range(-4, 4), g.range(-120, 120)] : [g.range(-160, 160), [-69, -23, 23, 69][g.int(0, 4)]! + g.range(-4, 4)];
    }, 36, 14);
    windows(r, (axis, side, along) => axis === 'x' && side > 0 && Math.abs(along) < 18);
  }

  // ---------------------------------------------------------------- Executive Floor: walled offices, a boardroom, a server room
  {
    const r = roomById('exec'), id = r.id;
    const floor = r.center.y - r.size.y / 2;
    const H = 34, T = 1.5, wy = floor + H / 2;
    const wall = (center: V3, size: V3) => box(id, center, size, 'plaster', true);
    // private offices along the north and south walls, between the shaft corners
    const fins = [-90, -54, -18, 18, 54, 90];
    for (const sz of [-1, 1]) {
      for (const x of fins) wall(p(x, wy, sz * 114), p(T, H, 32));
      for (let i = 0; i + 1 < fins.length; i++) {
        const x0 = fins[i]!;
        const front = rng.next();
        if (front >= 0.2) {
          wall(p(x0 + 4.75, wy, sz * 98.75), p(8, H, T));
          if (front < 0.32) {
            // the other half came down across the doorway
            box(id, p(x0 + 31.25, floor + T / 2, sz * (98.75 - 9)), p(8, T, H * 0.5), 'plaster', true, { rotY: rng.range(-0.3, 0.3) });
          } else wall(p(x0 + 31.25, wy, sz * 98.75), p(8, H, T));
        }
        box(id, p(x0 + 18, floor + 2.5, sz * 119), p(14, 5, 6), 'darkMetal', true);
        if (rng.chance(0.6)) box(id, p(x0 + 4, floor + 4.5, sz * 126), p(5, 9, 5), 'metal', true);
        else box(id, p(x0 + 6, floor + 2.6, sz * 118), p(5, 9, 5), 'metal', true, { rotZ: Math.PI / 2 * 0.94 });
      }
    }
    // boardroom in the middle, two wide doors
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) wall(p(sx * 25.625, wy, sz * 27), p(29.25, H, T));
    for (const sx of [-1, 1]) wall(p(sx * 41, wy, 0), p(T, H, 55.5));
    box(id, p(0, floor + 7, 0), p(40, 1.2, 12), 'darkMetal', true);
    for (const sx of [-1, 1]) box(id, p(sx * 12, floor + 3.2, 0), p(3, 6.4, 6), 'darkMetal', true);
    // L-shaped screens in the open quadrants
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      wall(p(sx * 85.75, wy, sz * 60), p(26, H, T));
      wall(p(sx * 72, wy, sz * 47), p(T, H, 26));
    }
    for (const [x, z] of [[0, 62], [0, -62]] as const) {
      props.push({ room: id, kind: 'cylinder', center: p(x, r.center.y, z), radius: 3.2, height: r.size.y, axis: 'y', collides: true, material: 'concrete' });
    }
    // reception facing the freight shaft door, with a logo wall behind it
    box(id, p(-128, floor + 4.5, 0), p(4, 9, 30), 'plaster', true);
    box(id, p(-104, floor + 15, 0), p(T, 30, 44), 'darkMetal', true);
    for (const sz of [-1, 1]) box(id, p(-152, floor + 2, sz * 40), p(5, 4, 16), 'fabric', true, { color: 0x3a3f48 });
    // server room along the east wall: racks with dim status strips
    for (const sz of [-1, 1]) {
      wall(p(136, wy, sz * 32), p(T, H, 44));
      wall(p(153.375, wy, sz * 54), p(33.25, H, T));
    }
    for (const x of [148, 161]) for (let z = -40; z <= 40; z += 10) {
      box(id, p(x, floor + 10, z), p(3, 20, 8), 'darkMetal', true);
      box(id, p(x - 1.6, floor + 11, z), p(0.2, 14, 0.5), 'emissive', false, { emissive: rng.chance(0.5) ? 0x3cff8a : 0x3c9aff });
    }
    ceilingLights(r, 30, 0.3);
    debris(r, (g) => [g.range(-150, 130), g.chance(0.5) ? g.range(30, 95) * (g.chance(0.5) ? 1 : -1) : g.range(-20, 20)], 30, 12);
    windows(r, (axis, side, along) => axis === 'x' && side < 0 && Math.abs(along) < 18);
  }

  // ---------------------------------------------------------------- Rooftop: open sky, one AC unit
  {
    const r = roomById('roof'), id = r.id;
    const floor = r.center.y - r.size.y / 2;
    const hx = r.size.x / 2, hz = r.size.z / 2;
    for (const sz of [-1, 1]) box(id, p(0, floor + 1.5, sz * (hz - 0.75)), p(r.size.x, 3, 1.5), 'concrete', true);
    for (const sx of [-1, 1]) box(id, p(sx * (hx - 0.75), floor + 1.5, 0), p(1.5, 3, r.size.z - 3), 'concrete', true);
    // the AC unit: cabinet on rails, condenser louvers, two fans, a duct into the roof
    for (const sz of [-1, 1]) box(id, p(0, floor + 0.75, sz * 9), p(52, 1.5, 2.4), 'darkMetal', true);
    const cy = floor + 1.5 + 8, top = floor + 1.5 + 16;
    box(id, p(0, cy, 0), p(46, 16, 26), 'metal', true);
    for (const sz of [-1, 1]) for (let y = floor + 3.5; y <= top - 1.5; y += 1.5) box(id, p(0, y, sz * 13.2), p(42, 0.45, 0.3), 'darkMetal', false);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(id, p(sx * 23.2, cy, sz * 6), p(0.3, 12, 8), 'darkMetal', false);
    for (const [fx, spin] of [[-11.5, 2.4], [11.5, -1.7]] as const) {
      props.push({ room: id, kind: 'ring', center: p(fx, top + 0.7, 0), radius: 7.5, tube: 0.9, axis: 'y', collides: false, material: 'metal' });
      for (const rot of [0, Math.PI / 2]) box(id, p(fx, top + 0.5, 0), p(13.5, 0.25, 2.4), 'darkMetal', false, { rotY: rot + 0.3, spin });
      props.push({ room: id, kind: 'cylinder', center: p(fx, top + 0.6, 0), radius: 1.3, height: 1.2, axis: 'y', collides: false, material: 'darkMetal' });
      for (const rot of [0, Math.PI / 2]) box(id, p(fx, top + 1.5, 0), p(15.5, 0.3, 0.5), 'metal', false, { rotY: rot });
    }
    box(id, p(-30, floor + 5.5, 0), p(14, 8, 9), 'metal', true);
    box(id, p(-41.5, floor + 4.75, 0), p(9, 9.5, 9), 'metal', true);
    for (const x of [-27, -33]) box(id, p(x, floor + 5.5, 0), p(0.6, 8.6, 9.6), 'darkMetal', false);
    // helipad paint
    const hp = p(-95, floor + 0.05, 50), R = 22, segs = 28;
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      box(id, p(hp.x + Math.cos(a) * R, hp.y, hp.z + Math.sin(a) * R), p((2 * Math.PI * R) / segs + 0.3, 0.1, 1.2), 'paint', false, { color: PAINT_WHITE, rotY: -(a + Math.PI / 2) });
    }
    for (const sx of [-1, 1]) box(id, p(hp.x + sx * 5, hp.y, hp.z), p(1.6, 0.1, 14), 'paint', false, { color: PAINT_WHITE });
    box(id, p(hp.x, hp.y, hp.z), p(8.4, 0.1, 1.6), 'paint', false, { color: PAINT_WHITE });
    // little vent stacks, too small to hide behind
    for (const [x, z] of [[110, -40], [-30, -95], [40, 95], [-140, -40]] as const) {
      props.push({ room: id, kind: 'cylinder', center: p(x, floor + 1.5, z), radius: 1.2, height: 3, axis: 'y', collides: true, material: 'metal' });
      props.push({ room: id, kind: 'cylinder', center: p(x, floor + 3.3, z), radius: 1.8, height: 0.6, axis: 'y', collides: false, material: 'darkMetal' });
    }
    // aviation beacon on a mast in the northeast corner
    props.push({ room: id, kind: 'cylinder', center: p(150, floor + 11, -110), radius: 0.6, height: 22, axis: 'y', collides: true, material: 'metal' });
    box(id, p(150, floor + 22.8, -110), p(1.6, 1.6, 1.6), 'emissive', false, { emissive: BEACON_RED, pulse: 0.4 });
  }
  return props;
}

export const TOWER_SEED = 0x70e3;
export function tower(): Blueprint {
  return {
    id: 'tower', name: 'Meridian Tower', rooms: TOWER_ROOMS, tunnels: TOWER_TUNNELS, props: buildProps(new Rng(TOWER_SEED)), seed: TOWER_SEED,
    spawns: TOWER_SPAWNS,
    oranges: { scale: 2.5, cap: 64, roomWeight: 0.05 },
  };
}

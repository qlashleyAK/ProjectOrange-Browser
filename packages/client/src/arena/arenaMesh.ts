import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  crystalPoints, getA, pillarPoints, placeAt, rockPoints, type ArenaData, type Axis, type Prop, type Slab, type V3,
} from '@orange/shared';
import { ArenaMaterials } from './materials';

export interface RoomLightSpec { room: string; pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number }

export interface ArenaView {
  group: THREE.Group;
  zones: Map<string, THREE.Group>;
  lights: RoomLightSpec[];
  /** show only the zone containing `pos` and its neighbors (room-graph PVS) */
  updateVisibility(pos: V3): string | null;
  /** zones visible from a place */
  visibleZones(place: string | null): Set<string>;
  animate(t: number): void;
  dispose(): void;
}

// ------------------------------------------------------------------ small noise for rock displacement
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v), w);
}
const fbm = (x: number, y: number, z: number) => vnoise(x, y, z) * 0.6 + vnoise(x * 2.3, y * 2.3, z * 2.3) * 0.3 + vnoise(x * 5, y * 5, z * 5) * 0.1;

// ------------------------------------------------------------------ geometry helpers
const AXES: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** Interior face quad of a slab, optionally subdivided and displaced into the wall. */
function faceGeometry(s: Slab, displace: boolean): THREE.BufferGeometry {
  const f = s.face;
  const ua = ((f.axis + 1) % 3) as Axis, va = ((f.axis + 2) % 3) as Axis;
  const du = f.uMax - f.uMin, dv = f.vMax - f.vMin;
  const nu = displace ? Math.max(1, Math.round(du / 3)) : 1;
  const nv = displace ? Math.max(1, Math.round(dv / 3)) : 1;
  const pos: number[] = [];
  const grid: THREE.Vector3[][] = [];
  for (let i = 0; i <= nu; i++) {
    const row: THREE.Vector3[] = [];
    for (let j = 0; j <= nv; j++) {
      const u = f.uMin + (du * i) / nu, v = f.vMin + (dv * j) / nv;
      const p = new THREE.Vector3();
      p.setComponent(f.axis, f.plane); p.setComponent(ua, u); p.setComponent(va, v);
      if (displace) {
        const edge = Math.min(u - f.uMin, f.uMax - u, v - f.vMin, f.vMax - v);
        const k = Math.min(1, edge / 6);
        const d = fbm(p.x * 0.06, p.y * 0.06, p.z * 0.06) * 3 * k;
        // displace away from the interior: opposite to the inward normal
        p.setComponent(f.axis, f.plane - f.normalSign * d);
      }
      row.push(p);
    }
    grid.push(row);
  }
  // normal must point along normalSign on `axis`; (u, v) orientation decides the winding
  const flip = f.normalSign < 0;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = grid[i]![j]!, b = grid[i + 1]![j]!, c = grid[i + 1]![j + 1]!, d = grid[i]![j + 1]!;
      const tri = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
      for (const t of tri) pos.push(t.x, t.y, t.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function propGeometry(p: Prop): THREE.BufferGeometry | null {
  let g: THREE.BufferGeometry;
  switch (p.kind) {
    case 'box':
      g = p.rounded ? new RoundedBoxGeometry(p.size.x, p.size.y, p.size.z, 2, p.rounded) : new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z);
      if (p.rotY) g.rotateY(p.rotY);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(p.radius, p.radius, p.height, Math.min(40, Math.max(12, Math.round(p.radius * 3))));
      if (p.axis === 'x') g.rotateZ(Math.PI / 2); else if (p.axis === 'z') g.rotateX(Math.PI / 2);
      break;
    case 'rock': g = convex(rockPoints(p.radius, p.seed, p.squash ?? 1)); break;
    case 'pillar': g = convex(pillarPoints(p.radius, p.height, p.seed)); break;
    case 'crystal': {
      g = convex(crystalPoints(p.length, p.radius));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(p.dir.x, p.dir.y, p.dir.z).normalize());
      g.applyQuaternion(q);
      break;
    }
    case 'ring':
      g = new THREE.TorusGeometry(p.radius, p.tube, 8, 48);
      if (p.axis === 'x') g.rotateY(Math.PI / 2); else if (p.axis === 'y') g.rotateX(Math.PI / 2);
      break;
  }
  g.translate(p.center.x, p.center.y, p.center.z);
  return clean(g);
}

function convex(pts: number[]): THREE.BufferGeometry {
  const v: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length; i += 3) v.push(new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]));
  return new ConvexGeometry(v);
}

function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
  if (!n.getAttribute('normal')) n.computeVertexNormals();
  return n;
}

function boxAt(center: THREE.Vector3, size: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size.x, size.y, size.z);
  g.translate(center.x, center.y, center.z);
  return clean(g);
}

// ------------------------------------------------------------------ text signs
function signTexture(text: string, color: THREE.Color, arrow: 'none' | 'right'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(6,8,12,0.88)';
  ctx.fillRect(0, 0, c.width, c.height);
  const css = `#${color.getHexString()}`;
  ctx.strokeStyle = css; ctx.lineWidth = 6; ctx.strokeRect(4, 4, c.width - 8, c.height - 8);
  ctx.fillStyle = css;
  ctx.font = 'bold 52px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = arrow === 'right' ? 'left' : 'center';
  const label = text.toUpperCase();
  if (arrow === 'right') {
    ctx.fillText(label, 24, 50);
    ctx.beginPath();
    for (const x of [400, 440]) { ctx.moveTo(x, 18); ctx.lineTo(x + 34, 48); ctx.lineTo(x, 78); }
    ctx.lineWidth = 10; ctx.stroke();
  } else ctx.fillText(label, c.width / 2, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function signMesh(text: string, color: number, arrow: 'none' | 'right', width: number): THREE.Mesh {
  const col = new THREE.Color(color);
  const mat = new THREE.MeshBasicMaterial({ map: signTexture(text, col, arrow), color: new THREE.Color(1.8, 1.8, 1.8), transparent: true, side: THREE.FrontSide });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, width * (96 / 512)), mat);
  m.name = `sign:${text}`;
  return m;
}

// ------------------------------------------------------------------ builder
export function buildArena(arena: ArenaData): ArenaView {
  const mats = new ArenaMaterials();
  const group = new THREE.Group();
  group.name = 'arena';
  const zones = new Map<string, THREE.Group>();
  const pending = new Map<string, Map<THREE.Material, THREE.BufferGeometry[]>>();
  const extras = new Map<string, THREE.Object3D[]>();
  const animated: { mesh: THREE.Mesh; kind: 'pulse'; base: THREE.Color; speed: number }[] = [];
  const rooms = new Map(arena.blueprint.rooms.map((r) => [r.id, r]));

  const addGeom = (zone: string, mat: THREE.Material, g: THREE.BufferGeometry) => {
    let z = pending.get(zone);
    if (!z) { z = new Map(); pending.set(zone, z); }
    let arr = z.get(mat);
    if (!arr) { arr = []; z.set(mat, arr); }
    arr.push(g);
  };
  const addObj = (zone: string, o: THREE.Object3D) => {
    let arr = extras.get(zone);
    if (!arr) { arr = []; extras.set(zone, arr); }
    arr.push(o);
  };

  // walls
  for (const s of arena.slabs) {
    const floorCeil = s.face.axis === 1;
    const displace = s.theme === 'rock';
    addGeom(s.owner, mats.wall(s.theme, floorCeil), faceGeometry(s, displace));
  }

  // props
  for (const p of arena.blueprint.props) {
    const g = propGeometry(p);
    if (!g) continue;
    const m = mats.prop(p.material, p.emissive);
    addGeom(p.room, m, g);
  }

  // doorway frames in the destination's landmark color + signs
  for (const d of arena.doorways) {
    const destId = d.end === 'a' ? d.tunnel.b : d.tunnel.a;
    const dest = rooms.get(destId)!;
    const color = dest.landmark;
    const glow = mats.glow(color, 3.2);
    const ua = ((d.axis + 1) % 3) as Axis, va = ((d.axis + 2) % 3) as Axis;
    const hs = d.size / 2, bar = 1.2, depth = 0.8;
    const n = new THREE.Vector3(d.inward.x, d.inward.y, d.inward.z);
    const c = new THREE.Vector3(d.center.x, d.center.y, d.center.z).addScaledVector(n, depth / 2);
    for (const [axis, sgn] of [[ua, 1], [ua, -1], [va, 1], [va, -1]] as [Axis, number][]) {
      const other = axis === ua ? va : ua;
      const center = c.clone();
      center.setComponent(axis, center.getComponent(axis) + sgn * (hs + bar / 2));
      const size = new THREE.Vector3();
      size.setComponent(d.axis, depth);
      size.setComponent(axis, bar);
      size.setComponent(other, d.size + bar * 2);
      addGeom(d.room.id, glow, boxAt(center, size));
    }
    // sign above the door (on the face), reading the destination
    const sign = signMesh(`▸ ${dest.name}`, color, 'none', Math.min(26, d.size * 0.9));
    const up = d.axis === 1 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    const basis = new THREE.Matrix4().makeBasis(right, up, n);
    sign.quaternion.setFromRotationMatrix(basis);
    sign.position.copy(new THREE.Vector3(d.center.x, d.center.y, d.center.z)).addScaledVector(up, hs + bar + 3.2).addScaledVector(n, 0.3);
    addObj(d.room.id, sign);

    // the tunnel side gets a smaller frame in the room's own color so exits are readable from inside
    const own = mats.glow(d.room.landmark, 2.2);
    const cIn = new THREE.Vector3(d.center.x, d.center.y, d.center.z).addScaledVector(n, -2.5);
    for (const [axis, sgn] of [[ua, 1], [ua, -1], [va, 1], [va, -1]] as [Axis, number][]) {
      const other = axis === ua ? va : ua;
      const center = cIn.clone();
      center.setComponent(axis, center.getComponent(axis) + sgn * (hs - 0.25));
      const size = new THREE.Vector3();
      size.setComponent(d.axis, 0.6);
      size.setComponent(axis, 0.5);
      size.setComponent(other, d.size);
      addGeom(d.tunnel.id, own, boxAt(center, size));
    }
  }

  // tunnel floor stripes, running lights and elbow chevrons
  const stripeMat = mats.glow(0xb8c4d0, 0.9);
  const runMat = mats.glow(0xbfe8ff, 3);
  for (const s of arena.segments) {
    const t = s.tunnel;
    const hs = t.side / 2;
    const floorAxis: Axis = s.axis === 1 ? 0 : 1;
    const sideAxis = (3 - s.axis - floorAxis) as Axis;
    const min = s.box.min, max = s.box.max;
    const len = getA(max, s.axis) - getA(min, s.axis);
    const mid = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const floorPlane = getA(min, floorAxis);
    const stripeC = mid.clone(); stripeC.setComponent(floorAxis, floorPlane + 0.06);
    const stripeS = new THREE.Vector3(); stripeS.setComponent(s.axis, len); stripeS.setComponent(floorAxis, 0.1); stripeS.setComponent(sideAxis, t.bonus ? 1.5 : 3);
    addGeom(t.id, stripeMat, boxAt(stripeC, stripeS));
    const step = 8;
    for (let k = step / 2; k < len; k += step) {
      for (const sg of [-1, 1]) {
        const c = mid.clone();
        c.setComponent(s.axis, getA(min, s.axis) + k);
        c.setComponent(floorAxis, floorPlane + 0.15);
        c.setComponent(sideAxis, getA(mid as unknown as V3, sideAxis) + sg * (hs - 1.0));
        const sz = new THREE.Vector3(); sz.setComponent(s.axis, 1.2); sz.setComponent(floorAxis, 0.3); sz.setComponent(sideAxis, 0.4);
        addGeom(t.id, runMat, boxAt(c, sz));
      }
    }
    if (t.bonus) {
      // sewer: dim hazard strips on the ceiling corners
      const hz = mats.prop('hazard');
      for (const sg of [-1, 1]) {
        const c = mid.clone();
        c.setComponent(floorAxis, getA(max, floorAxis) - 0.3);
        c.setComponent(sideAxis, getA(mid as unknown as V3, sideAxis) + sg * (hs - 0.6));
        const sz = new THREE.Vector3(); sz.setComponent(s.axis, len); sz.setComponent(floorAxis, 0.6); sz.setComponent(sideAxis, 1.2);
        addGeom(t.id, hz, boxAt(c, sz));
      }
    }
  }
  for (const e of arena.elbows) {
    const t = e.tunnel;
    const hs = t.side / 2;
    const [o0, o1] = e.openings as [{ axis: Axis; sign: 1 | -1 }, { axis: Axis; sign: 1 | -1 }];
    for (const [from, to, dest] of [[o0, o1, t.b], [o1, o0, t.a]] as const) {
      const room = rooms.get(dest)!;
      // wall opposite the opening we arrive through; its inward normal points back toward that opening
      const n = AXES[from.axis].clone().multiplyScalar(from.sign);
      const right = AXES[to.axis].clone().multiplyScalar(to.sign);
      const up = new THREE.Vector3().crossVectors(n, right);
      const sign = signMesh(room.name, room.landmark, 'right', Math.min(20, t.side * 0.75));
      sign.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
      sign.position.set(e.center.x, e.center.y, e.center.z).addScaledVector(n, -(hs - 0.25));
      addObj(t.id, sign);
    }
  }

  // hub: teal rims on the shaft mouths, hazard frame on the sewer opening
  for (const d of arena.doorways) {
    if (d.room.id !== 'hub' || d.axis !== 1) continue;
    const isSewer = !!d.tunnel.bonus;
    const mat = isSewer ? mats.prop('hazard') : mats.glow(0x2fe0d0, 3.5);
    const hs = d.size / 2, bar = isSewer ? 2.5 : 1.6;
    const c = new THREE.Vector3(d.center.x, d.center.y + d.inward.y * 0.35, d.center.z);
    for (const [ax, sg] of [[0, 1], [0, -1], [2, 1], [2, -1]] as [0 | 2, number][]) {
      const other = ax === 0 ? 2 : 0;
      const center = c.clone(); center.setComponent(ax, center.getComponent(ax) + sg * (hs + bar / 2 + 1.2));
      const size = new THREE.Vector3(); size.setComponent(1, 0.7); size.setComponent(ax, bar); size.setComponent(other, d.size + bar * 2 + 2.4);
      addGeom('hub', mat, boxAt(center, size));
    }
  }

  // room-specific cosmetics
  const dock = rooms.get('dock');
  if (dock) {
    const padMat = mats.glow(0x3f8cff, 2.5);
    const floorY = dock.center.y - dock.size.y / 2 + 0.08;
    for (const px of [-45, 0, 45]) {
      for (let i = -3; i <= 3; i++) for (const pz of [-26, -12]) {
        addGeom('dock', padMat, boxAt(new THREE.Vector3(dock.center.x + px + i * 3, floorY, dock.center.z + pz), new THREE.Vector3(0.5, 0.12, 0.5)));
      }
    }
    // bay door slits (glass, visual only) with a starfield behind
    const doorZ = dock.center.z + dock.size.z / 2 - 0.15;
    const star = starfieldMaterial();
    for (let i = 0; i < 5; i++) {
      const slit = new THREE.Mesh(new THREE.PlaneGeometry(90, 1.4), star);
      slit.position.set(dock.center.x, dock.center.y - 12 + i * 6, doorZ);
      slit.rotation.y = Math.PI;
      addObj('dock', slit);
    }
    const runL = mats.glow(0x3f8cff, 4);
    for (let i = -7; i <= 7; i++) addGeom('dock', runL, boxAt(new THREE.Vector3(dock.center.x + i * 9, dock.center.y + 18, doorZ - 0.3), new THREE.Vector3(1.4, 0.5, 0.5)));
  }
  const foundry = rooms.get('foundry');
  if (foundry) {
    const slag = mats.glow(0xff3fa0, 2.4);
    const fy = foundry.center.y - foundry.size.y / 2 + 0.05;
    for (const z of [-36, 34]) addGeom('foundry', slag, boxAt(new THREE.Vector3(foundry.center.x, fy, foundry.center.z + z), new THREE.Vector3(96, 0.1, 2.2)));
    addGeom('foundry', slag, boxAt(new THREE.Vector3(foundry.center.x - 46, fy, foundry.center.z), new THREE.Vector3(2.2, 0.1, 70)));
  }
  const reactor = rooms.get('reactor');
  if (reactor) {
    for (let y = -90; y <= 90; y += 30) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(12.15, 12.15, 1.6, 40, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x4cff7a).multiplyScalar(3) }));
      band.position.set(reactor.center.x, reactor.center.y + y, reactor.center.z);
      animated.push({ mesh: band, kind: 'pulse', base: new THREE.Color(0x4cff7a).multiplyScalar(3), speed: 1.3 });
      addObj('reactor', band);
    }
  }
  const crusher = rooms.get('crusher');
  if (crusher) {
    const warn = mats.glow(0x2fe0d0, 4);
    for (const [x, z] of [[-48, -48], [48, -48], [-48, 48], [48, 48]]) {
      addGeom('crusher', warn, boxAt(new THREE.Vector3(crusher.center.x + x, crusher.center.y + 20, crusher.center.z + z), new THREE.Vector3(1.2, 1.2, 1.2)));
    }
  }
  const hub = rooms.get('hub');
  if (hub) {
    const band = mats.glow(0xe8f0ff, 3.5);
    const g = new THREE.CylinderGeometry(9.2, 9.2, 2.4, 36, 1, true);
    g.translate(hub.center.x, hub.center.y, hub.center.z);
    addGeom('hub', band, clean(g));
  }
  const gallery = rooms.get('gallery');
  if (gallery) {
    // small wall crystal clusters (visual, ≤ 1 m protrusion)
    const cm = mats.prop('crystal', 0x9a6bff);
    let seed = 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 40; i++) {
      const face = Math.floor(rnd() * 4);
      const hx = gallery.size.x / 2, hz = gallery.size.z / 2;
      const along = (rnd() - 0.5) * gallery.size.x * 0.85;
      const y = gallery.center.y + (rnd() - 0.5) * gallery.size.y * 0.8;
      const base = new THREE.Vector3(), dir = new THREE.Vector3();
      if (face === 0) { base.set(gallery.center.x + hx, y, gallery.center.z + along); dir.set(-1, 0, 0); }
      else if (face === 1) { base.set(gallery.center.x - hx, y, gallery.center.z + along); dir.set(1, 0, 0); }
      else if (face === 2) { base.set(gallery.center.x + along, y, gallery.center.z + hz); dir.set(0, 0, -1); }
      else { base.set(gallery.center.x + along, y, gallery.center.z - hz); dir.set(0, 0, 1); }
      const near = arena.doorways.some((d) => d.room.id === 'gallery' && base.distanceTo(new THREE.Vector3(d.center.x, d.center.y, d.center.z)) < d.size);
      if (near) continue;
      dir.add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.8)).normalize();
      const g = convex(crystalPoints(1.0 + rnd() * 0.4, 0.25 + rnd() * 0.15));
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      g.translate(base.x, base.y, base.z);
      addGeom('gallery', cm, clean(g));
    }
  }

  // merge per zone per material
  for (const [zone, byMat] of pending) {
    const zg = new THREE.Group();
    zg.name = zone;
    for (const [mat, geoms] of byMat) {
      const merged = mergeGeometries(geoms.map(clean), false);
      for (const g of geoms) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      zg.add(mesh);
    }
    zones.set(zone, zg);
    group.add(zg);
  }
  for (const [zone, objs] of extras) {
    let zg = zones.get(zone);
    if (!zg) { zg = new THREE.Group(); zg.name = zone; zones.set(zone, zg); group.add(zg); }
    for (const o of objs) zg.add(o);
  }

  // static light specs per room (landmark color)
  const lights: RoomLightSpec[] = [];
  for (const r of arena.blueprint.rooms) {
    const big = Math.max(r.size.x, r.size.y, r.size.z);
    const color = new THREE.Color(r.landmark);
    const pts: THREE.Vector3[] = r.id === 'reactor'
      ? [new THREE.Vector3(r.center.x, r.center.y + 55, r.center.z + 25), new THREE.Vector3(r.center.x, r.center.y - 55, r.center.z - 25)]
      : r.id === 'hub'
        ? [new THREE.Vector3(r.center.x + 30, r.center.y + 30, r.center.z + 30), new THREE.Vector3(r.center.x - 30, r.center.y - 25, r.center.z - 30)]
        : [new THREE.Vector3(r.center.x, r.center.y + r.size.y * 0.3, r.center.z)];
    for (const p of pts) lights.push({ room: r.id, pos: p, color, intensity: big * big * 0.9 / pts.length, distance: big * 1.6 });
  }

  const pvsCache = new Map<string, Set<string>>();
  const visibleZones = (place: string | null): Set<string> => {
    const key = place ?? '';
    const hit = pvsCache.get(key);
    if (hit) return hit;
    const out = new Set<string>();
    if (!place) { for (const z of zones.keys()) out.add(z); pvsCache.set(key, out); return out; }
    const addRoom = (room: string, withTunnels: boolean) => {
      out.add(room);
      if (withTunnels) for (const a of arena.adjacency.get(room) ?? []) out.add(a.tunnel);
    };
    if (rooms.has(place)) {
      addRoom(place, true);
      for (const a of arena.adjacency.get(place) ?? []) addRoom(a.room, false);
    } else {
      const t = arena.blueprint.tunnels.find((x) => x.id === place);
      out.add(place);
      if (t) { addRoom(t.a, true); addRoom(t.b, true); }
    }
    pvsCache.set(key, out);
    return out;
  };

  let lastPlace: string | null | undefined;
  return {
    group, zones, lights, visibleZones,
    updateVisibility(pos: V3) {
      const pl = placeAt(arena, pos);
      const id = pl ? pl.id : lastPlace ?? null;
      if (id !== lastPlace) {
        lastPlace = id;
        const vis = visibleZones(id);
        for (const [z, g] of zones) g.visible = vis.has(z);
      }
      return id;
    },
    animate(t: number) {
      for (const a of animated) {
        const k = 0.75 + 0.25 * Math.sin(t * a.speed * Math.PI * 2);
        (a.mesh.material as THREE.MeshBasicMaterial).color.copy(a.base).multiplyScalar(k);
      }
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mm = m.material as THREE.MeshBasicMaterial;
          if (mm.map) mm.map.dispose();
        }
      });
      mats.dispose();
    },
  };
}

function starfieldMaterial(): THREE.MeshBasicMaterial {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#02040a';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 260; i++) {
    const b = 120 + Math.floor(Math.random() * 135);
    ctx.fillStyle = `rgb(${b},${b},${Math.min(255, b + 30)})`;
    ctx.fillRect(Math.random() * c.width, Math.random() * c.height, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(2, 2, 2.2) });
}

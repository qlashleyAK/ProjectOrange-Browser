import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  crystalPoints, DT, getA, logFrame, moverPose, pillarPoints, placeAt, q4, rockPoints, spikePoints, v3,
  type ArenaData, type Axis, type Mover, type Prop, type Slab, type Theme, type V3,
} from '@orange/shared';
import { ArenaMaterials } from './materials';

export interface RoomLightSpec { room: string; pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; decay: number }

export interface ArenaView {
  group: THREE.Group;
  zones: Map<string, THREE.Group>;
  lights: RoomLightSpec[];
  /** show only the zone containing `pos` and its neighbors (room-graph PVS) */
  updateVisibility(pos: V3): string | null;
  /** zones visible from a place */
  visibleZones(place: string | null): Set<string>;
  /** `t` drives cosmetic pulses; `tick` poses moving fixtures (defaults to the tick at `t`) */
  animate(t: number, tick?: number): void;
  dispose(): void;
}

export const SAFE_ZONE_COLOR = 0x6dffc9;

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

/** How far (m) a theme's faces sink into the rock behind them, by part; unlisted faces stay flat. */
const DISPLACE: Partial<Record<Theme, { wall: number; floor?: number; ceiling: number }>> = {
  rock: { wall: 3, floor: 3, ceiling: 3 },
  mine: { wall: 2.6, ceiling: 2 },
  // shallow overhead, so stalactite roots stay buried
  cave: { wall: 3.2, ceiling: 1.2 },
  drift: { wall: 1.6, ceiling: 1.2 },
  works: { wall: 1.1, ceiling: 1.6 },
  sewer: { wall: 0.6, ceiling: 0.6 },
};
/** Vein color in the drifts, which belong to no one room. */
const DRIFT_VEIN = 0xa8d4ff;

/** Interior face quad of a slab, optionally subdivided and displaced `depth` meters into the wall. */
function faceGeometry(s: Slab, depth: number): THREE.BufferGeometry {
  const f = s.face;
  const ua = ((f.axis + 1) % 3) as Axis, va = ((f.axis + 2) % 3) as Axis;
  const du = f.uMax - f.uMin, dv = f.vMax - f.vMin;
  const displace = depth > 0;
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
        const d = fbm(p.x * 0.06, p.y * 0.06, p.z * 0.06) * depth * k;
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
      // same order as boxRotation in shared: Z tilt, X tilt, Y turn
      if (p.rotZ) g.rotateZ(p.rotZ);
      if (p.rotX) g.rotateX(p.rotX);
      if (p.rotY) g.rotateY(p.rotY);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(p.radius, p.radius, p.height, Math.min(40, Math.max(12, Math.round(p.radius * 3))));
      if (p.axis === 'x') g.rotateZ(Math.PI / 2); else if (p.axis === 'z') g.rotateX(Math.PI / 2);
      break;
    case 'rock': g = convex(rockPoints(p.radius, p.seed, p.squash ?? 1)); break;
    case 'pillar': g = convex(pillarPoints(p.radius, p.height, p.seed)); break;
    case 'crystal':
    case 'spike': {
      g = convex(p.kind === 'crystal' ? crystalPoints(p.length, p.radius) : spikePoints(p.length, p.radius, p.seed));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(p.dir.x, p.dir.y, p.dir.z).normalize());
      g.applyQuaternion(q);
      break;
    }
    case 'ring':
      g = new THREE.TorusGeometry(p.radius, p.tube, 8, 48);
      if (p.axis === 'x') g.rotateY(Math.PI / 2); else if (p.axis === 'y') g.rotateX(Math.PI / 2);
      break;
    case 'limb': return clean(limbGeometry(p));
    case 'hull': g = convex(p.points); break;
    case 'log': g = logGeometry(p); break;
  }
  g.translate(p.center.x, p.center.y, p.center.z);
  return clean(g);
}

const AXIS_NAME = ['x', 'y', 'z'] as const;
const MINE_THEMES = new Set<Theme>(['mine', 'works', 'cave']);

/** World axis bark or timber grain runs along: a limb's span, a log's axis, or a box's longest side. */
function grainAxis(p: Prop): 'x' | 'y' | 'z' {
  if (p.kind === 'limb') {
    const a = p.points[0]!, b = p.points[p.points.length - 1]!;
    const d = [Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)];
    return AXIS_NAME[d.indexOf(Math.max(...d))]!;
  }
  if (p.kind === 'log') {
    const d = [Math.abs(p.dir.x), Math.abs(p.dir.y), Math.abs(p.dir.z)];
    return AXIS_NAME[d.indexOf(Math.max(...d))]!;
  }
  if (p.kind !== 'box') return 'y';
  const { x, y, z } = p.size;
  const v = x >= y && x >= z ? new THREE.Vector3(1, 0, 0) : y >= z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  // same order as boxRotation: Z tilt, then X, then Y
  v.applyEuler(new THREE.Euler(p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0, 'YXZ'));
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  return AXIS_NAME[a.indexOf(Math.max(...a))]!;
}

/** Tapering tube through world-space points. Frames ride along by parallel transport so the bark doesn't twist. */
function limbGeometry(p: Extract<Prop, { kind: 'limb' }>): THREE.BufferGeometry {
  const n = p.points.length, segs = 8;
  const pts = p.points.map((q) => new THREE.Vector3(q.x, q.y, q.z));
  const T = pts.map((q, i) => {
    const t = i === 0 ? pts[1]!.clone().sub(q) : i === n - 1 ? q.clone().sub(pts[n - 2]!) : pts[i + 1]!.clone().sub(pts[i - 1]!);
    return t.lengthSq() < 1e-8 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });
  const N = new THREE.Vector3(), B = new THREE.Vector3();
  if (Math.abs(T[0]!.y) < 0.92) N.crossVectors(T[0]!, new THREE.Vector3(0, 1, 0));
  else N.crossVectors(T[0]!, new THREE.Vector3(1, 0, 0));
  N.normalize();
  B.crossVectors(T[0]!, N).normalize();
  const rings: THREE.Vector3[][] = [];
  const axis = new THREE.Vector3(), q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      axis.crossVectors(T[i - 1]!, T[i]!);
      const ang = T[i - 1]!.angleTo(T[i]!);
      if (axis.lengthSq() > 1e-10 && ang > 1e-4) {
        q.setFromAxisAngle(axis.normalize(), ang);
        N.applyQuaternion(q); B.applyQuaternion(q);
      }
    }
    const r = p.radii[i]!, ring: THREE.Vector3[] = [];
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      ring.push(pts[i]!.clone().addScaledVector(N, Math.cos(a) * r).addScaledVector(B, Math.sin(a) * r));
    }
    rings.push(ring);
  }
  const pos: number[] = [];
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); };
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    const a = rings[i]![j]!, b = rings[i]![j1]!, c = rings[i + 1]![j1]!, d = rings[i + 1]![j]!;
    push(a, b, c); push(a, c, d);
  }
  for (let j = 1; j < segs - 1; j++) {
    push(rings[0]![0]!, rings[0]![j + 1]!, rings[0]![j]!);
    push(rings[n - 1]![0]!, rings[n - 1]![j]!, rings[n - 1]![j + 1]!);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Hollow fallen trunk: outer bark, inner hollow, open ends. */
function logGeometry(p: Extract<Prop, { kind: 'log' }>): THREE.BufferGeometry {
  const { d, u, w } = logFrame(p.dir);
  const D = new THREE.Vector3(d.x, d.y, d.z), U = new THREE.Vector3(u.x, u.y, u.z), W = new THREE.Vector3(w.x, w.y, w.z);
  const segs = 16, h = p.length / 2, pos: number[] = [];
  const ring = (t: number, r: number) => Array.from({ length: segs }, (_, i) => {
    const a = (i / segs) * Math.PI * 2;
    return new THREE.Vector3().addScaledVector(D, t).addScaledVector(U, Math.cos(a) * r).addScaledVector(W, Math.sin(a) * r);
  });
  const lo = ring(-h, p.outer), hi = ring(h, p.outer), li = ring(-h, p.inner), hi2 = ring(h, p.inner);
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); };
  for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    push(lo[j]!, lo[j1]!, hi[j1]!); push(lo[j]!, hi[j1]!, hi[j]!);
    push(li[j1]!, li[j]!, hi2[j]!); push(li[j1]!, hi2[j]!, hi2[j1]!);
    push(lo[j]!, li[j]!, li[j1]!); push(lo[j]!, li[j1]!, lo[j1]!);
    push(hi[j1]!, hi2[j1]!, hi2[j]!); push(hi[j1]!, hi2[j]!, hi[j]!);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A box `w` thick from `a` to `b`. */
function beamGeom(a: THREE.Vector3, b: THREE.Vector3, w: number): THREE.BufferGeometry {
  const d = b.clone().sub(a), len = d.length();
  const g = new THREE.BoxGeometry(len, w, w);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
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
    ctx.fillText(label, 24, 50, 360);
    ctx.beginPath();
    for (const x of [400, 440]) { ctx.moveTo(x, 18); ctx.lineTo(x + 34, 48); ctx.lineTo(x, 78); }
    ctx.lineWidth = 10; ctx.stroke();
  } else ctx.fillText(label, c.width / 2, 50, c.width - 40);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Square painted level marker: a colored band with big text. */
function levelTexture(text: string, color: THREE.Color): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const css = `#${color.getHexString()}`;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgb(18,20,24)';
  ctx.font = 'bold 150px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 136, 236);
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
    const part = s.face.axis !== 1 ? 'wall' : s.face.normalSign > 0 ? 'floor' : 'ceiling';
    const room = rooms.get(s.owner);
    const floorY = room ? room.center.y - room.size.y / 2 : 0;
    addGeom(s.owner, mats.wall(s.theme, part, floorY, room?.landmark ?? DRIFT_VEIN), faceGeometry(s, DISPLACE[s.theme]?.[part] ?? 0));
  }

  // props: static ones merge per material; spinning and pulsing ones keep their own mesh
  const spinners: { mesh: THREE.Mesh; rate: number }[] = [];
  for (const p of arena.blueprint.props) {
    const g = propGeometry(p);
    if (!g) continue;
    if (p.pulse) {
      const base = new THREE.Color(p.emissive ?? 0xffffff).multiplyScalar(3);
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: base.clone() }));
      animated.push({ mesh, kind: 'pulse', base, speed: p.pulse });
      addObj(p.room, mesh);
      continue;
    }
    const mine = MINE_THEMES.has(rooms.get(p.room)!.theme) && (p.material === 'metal' || p.material === 'darkMetal');
    const m = mine ? mats.steel(p.material === 'darkMetal', !!p.spin)
      : mats.prop(p.material, p.emissive, false, p.color, p.material === 'timber' || p.material === 'bark' ? grainAxis(p) : undefined);
    if (p.spin) {
      g.translate(-p.center.x, -p.center.y, -p.center.z);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(p.center.x, p.center.y, p.center.z);
      spinners.push({ mesh, rate: p.spin });
      addObj(p.room, mesh);
      continue;
    }
    addGeom(p.room, m, g);
  }

  // moving fixtures: one group per mover in body space, posed every frame
  const movers: { def: Mover; group: THREE.Group }[] = [];
  for (const m of arena.movers) {
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const p of m.parts) {
      const g = propGeometry(p);
      if (!g) continue;
      g.translate(-m.origin.x, -m.origin.y, -m.origin.z);
      const mat = mats.prop(p.material, p.emissive, true, p.color);
      let arr = byMat.get(mat);
      if (!arr) { arr = []; byMat.set(mat, arr); }
      arr.push(g);
    }
    const mg = new THREE.Group();
    mg.name = `mover:${m.id}`;
    for (const [mat, geoms] of byMat) {
      const merged = mergeGeometries(geoms, false);
      for (const g of geoms) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      mg.add(new THREE.Mesh(merged, mat));
    }
    mg.position.set(m.origin.x, m.origin.y, m.origin.z);
    movers.push({ def: m, group: mg });
    addObj(m.room, mg);
  }

  // safe zones: a shimmering shell, with a ring and sign on the nearest clear side wall
  const shellMats: THREE.ShaderMaterial[] = [];
  const safeRing = mats.glow(SAFE_ZONE_COLOR, 2.6);
  for (const z of arena.safeZones) {
    const room = rooms.get(z.room)!;
    const mat = safeZoneMaterial();
    shellMats.push(mat);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(z.radius, 64, 32), mat);
    shell.position.set(z.center.x, z.center.y, z.center.z);
    shell.renderOrder = 2;
    addObj(z.room, shell);

    const walls = ([[0, 1], [0, -1], [2, 1], [2, -1]] as [Axis, 1 | -1][]).map(([axis, sign]) => {
      const gap = getA(room.size, axis) / 2 - sign * (getA(z.center, axis) - getA(room.center, axis));
      const door = arena.doorways.some((d) => d.room.id === room.id && d.axis === axis && Math.sign(getA(d.inward, axis)) === -sign);
      return { axis, sign, score: gap + (door ? 20 : 0) };
    }).sort((a, b) => a.score - b.score);
    const w = walls[0]!;
    const n = new THREE.Vector3().setComponent(w.axis, -w.sign);
    const onWall = new THREE.Vector3(z.center.x, z.center.y, z.center.z)
      .setComponent(w.axis, getA(room.center, w.axis) + w.sign * getA(room.size, w.axis) / 2);
    const ringR = z.radius * 0.8;
    const ring = new THREE.TorusGeometry(ringR, 0.45, 8, 64);
    if (w.axis === 0) ring.rotateY(Math.PI / 2);
    ring.translate(onWall.x + n.x * 0.6, onWall.y, onWall.z + n.z * 0.6);
    addGeom(z.room, safeRing, clean(ring));
    const sign = signMesh('Safe zone', SAFE_ZONE_COLOR, 'none', 22);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    sign.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
    sign.position.copy(onWall).addScaledVector(up, ringR + 5).addScaledVector(n, 0.3);
    addObj(z.room, sign);
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
    // mine rooms set a steel portal around wall doors
    const portal = MINE_THEMES.has(d.room.theme) && d.axis !== 1 ? 1.8 : 0;
    if (portal) {
      const pc = new THREE.Vector3(d.center.x, d.center.y, d.center.z).addScaledVector(n, 0.8);
      for (const [axis, sgn] of [[ua, 1], [ua, -1], [va, 1], [va, -1]] as [Axis, number][]) {
        const other = axis === ua ? va : ua;
        const center = pc.clone();
        center.setComponent(axis, center.getComponent(axis) + sgn * (hs + bar + portal / 2));
        const size = new THREE.Vector3();
        size.setComponent(d.axis, 1.6);
        size.setComponent(axis, portal);
        size.setComponent(other, d.size + (bar + portal) * 2);
        addGeom(d.room.id, mats.steel(true), boxAt(center, size));
      }
    }
    // sign above the door (on the face), reading the destination
    const sign = signMesh(`▸ ${dest.name}`, color, 'none', Math.min(26, d.size * 0.9));
    const up = d.axis === 1 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    const basis = new THREE.Matrix4().makeBasis(right, up, n);
    sign.quaternion.setFromRotationMatrix(basis);
    sign.position.copy(new THREE.Vector3(d.center.x, d.center.y, d.center.z)).addScaledVector(up, hs + bar + 3.2 + portal).addScaledVector(n, 0.3);
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

  // mine drifts: timber sets with knee braces, caged lamps on every other cap, a track in level drifts,
  // and a water main and sagging cable run along the top corners
  const lampMat = mats.glow(0xdce8ff, 3.2);
  const cageMat = mats.steel(true);
  const steel = mats.steel();
  const cableMat = mats.steel(true);
  for (const s of arena.segments) {
    const t = s.tunnel;
    if (t.theme !== 'drift') continue;
    const hs = t.side / 2;
    const along = s.axis, up: Axis = along === 1 ? 0 : 1, across = (3 - along - up) as Axis;
    const lo = getA(s.box.min, along), len = getA(s.box.max, along) - lo;
    const floorP = getA(s.box.min, up), ceilP = getA(s.box.max, up), mid = getA(s.box.min, across) + hs;
    const P = (a: number, u: number, c: number) => new THREE.Vector3().setComponent(along, a).setComponent(up, u).setComponent(across, c);
    const post = mats.prop('timber', undefined, false, undefined, AXIS_NAME[up]);
    const cap = mats.prop('timber', undefined, false, undefined, AXIS_NAME[across]);
    const raise = along === 1;
    const n = Math.max(1, Math.round(len / 12)), step = len / n;
    const sets: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = lo + step * (i + 0.5);
      sets.push(a);
      for (const sg of [-1, 1]) {
        addGeom(t.id, post, boxAt(P(a, (floorP + ceilP) / 2, mid + sg * (hs - 0.8)), P(1.5, t.side, 1.5)));
        addGeom(t.id, cap, beamGeom(P(a, ceilP - 5.6, mid + sg * (hs - 1.5)), P(a, ceilP - 1.6, mid + sg * (hs - 5.6)), 0.9));
      }
      addGeom(t.id, cap, boxAt(P(a, ceilP - 0.9, mid), P(1.5, 1.8, t.side)));
      // a raise has no floor to stand the posts on, so its sets close into square frames
      if (raise) addGeom(t.id, cap, boxAt(P(a, floorP + 0.9, mid), P(1.5, 1.8, t.side)));
      if (i % 2 === 0) {
        addGeom(t.id, cageMat, boxAt(P(a, ceilP - 2.2, mid), P(1.7, 0.8, 1.7)));
        addGeom(t.id, lampMat, boxAt(P(a, ceilP - 2.95, mid), P(1.1, 0.7, 1.1)));
      }
    }
    if (!raise) {
      for (let k = 1.3; k < len - 0.6; k += 2.6) addGeom(t.id, cap, boxAt(P(lo + k, floorP + 0.2, mid), P(1.1, 0.4, 9.5)));
      for (const sg of [-1, 1]) addGeom(t.id, steel, boxAt(P(lo + len / 2, floorP + 0.7, mid + sg * 3), P(len, 0.6, 0.5)));
    }
    const pipe = new THREE.CylinderGeometry(0.75, 0.75, len, 12);
    if (along === 0) pipe.rotateZ(Math.PI / 2); else if (along === 2) pipe.rotateX(Math.PI / 2);
    const pc = P(lo + len / 2, ceilP - 3, mid + (hs - 2.4));
    pipe.translate(pc.x, pc.y, pc.z);
    addGeom(t.id, steel, clean(pipe));
    for (let k = 3; k < len - 1; k += 6) addGeom(t.id, steel, boxAt(P(lo + k, ceilP - 3, mid + (hs - 2.4)), P(0.5, 1.9, 1.9)));
    // the cable sags between the cap ends
    const knots = [lo, ...sets, lo + len];
    for (let i = 0; i < knots.length - 1; i++) {
      const a0 = knots[i]!, a1 = knots[i + 1]!;
      const c = mid - (hs - 2.2), y0 = ceilP - 2.1, sag = raise ? 0 : 0.9;
      const pts = [0, 0.25, 0.5, 0.75, 1].map((f) => P(a0 + (a1 - a0) * f, y0 - Math.sin(f * Math.PI) * sag, c));
      for (let j = 0; j < 4; j++) addGeom(t.id, cableMat, beamGeom(pts[j]!, pts[j + 1]!, 0.45));
    }
  }

  // tunnel floor stripes, running lights and elbow chevrons
  const stripeMat = mats.glow(0xb8c4d0, 0.9);
  const runMat = mats.glow(0xbfe8ff, 3);
  for (const s of arena.segments) {
    const t = s.tunnel;
    if (t.theme === 'drift') continue;
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

  // building floors: hazard rims around the shaft holes in floors and ceilings
  const rim = mats.prop('hazard');
  for (const d of arena.doorways) {
    if (d.axis !== 1 || !['office', 'garage', 'roof'].includes(d.room.theme)) continue;
    const hs = d.size / 2, bar = 2.5;
    const c = new THREE.Vector3(d.center.x, d.center.y + d.inward.y * 0.35, d.center.z);
    for (const [ax, sg] of [[0, 1], [0, -1], [2, 1], [2, -1]] as [0 | 2, number][]) {
      const other = ax === 0 ? 2 : 0;
      const center = c.clone(); center.setComponent(ax, center.getComponent(ax) + sg * (hs + bar / 2 + 1.2));
      const size = new THREE.Vector3(); size.setComponent(1, 0.7); size.setComponent(ax, bar); size.setComponent(other, d.size + bar * 2 + 2.4);
      addGeom(d.room.id, rim, boxAt(center, size));
    }
  }
  // elevator shafts: a pair of guide rails up opposite walls
  const railMat = mats.prop('darkMetal');
  for (const s of arena.segments) {
    if (s.tunnel.theme !== 'shaft' || s.axis !== 1) continue;
    const hs = s.tunnel.side / 2, len = s.box.max.y - s.box.min.y;
    const mid = new THREE.Vector3((s.box.min.x + s.box.max.x) / 2, (s.box.min.y + s.box.max.y) / 2, (s.box.min.z + s.box.max.z) / 2);
    for (const sg of [-1, 1]) addGeom(s.tunnel.id, railMat, boxAt(new THREE.Vector3(mid.x, mid.y, mid.z + sg * (hs - 0.4)), new THREE.Vector3(1, len, 0.8)));
  }

  // room-specific cosmetics
  const garage = rooms.get('garage');
  if (garage) {
    // level markers on every face of every full-height pillar
    const floorY = garage.center.y - garage.size.y / 2;
    const mat = new THREE.MeshBasicMaterial({ map: levelTexture('P2', new THREE.Color(garage.landmark)), color: new THREE.Color(1.4, 1.4, 1.4) });
    const planes: THREE.BufferGeometry[] = [];
    for (const p of arena.blueprint.props) {
      if (p.room !== 'garage' || p.kind !== 'box' || p.material !== 'concrete' || p.size.y !== garage.size.y) continue;
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const g = new THREE.PlaneGeometry(5, 5);
        g.rotateY(Math.atan2(nx, nz));
        g.translate(p.center.x + nx * (p.size.x / 2 + 0.08), floorY + 11, p.center.z + nz * (p.size.z / 2 + 0.08));
        planes.push(g);
      }
    }
    const merged = planes.length ? mergeGeometries(planes, false) : null;
    for (const g of planes) g.dispose();
    if (merged) { merged.computeBoundingSphere(); addObj('garage', new THREE.Mesh(merged, mat)); }
  }
  const exec = rooms.get('exec');
  if (exec) {
    const logo = signMesh('Meridian', exec.landmark, 'none', 30);
    logo.rotation.y = -Math.PI / 2;
    logo.position.set(exec.center.x - 104.85, exec.center.y - exec.size.y / 2 + 21, exec.center.z);
    addObj('exec', logo);
  }
  const dock = rooms.get('dock');
  if (dock) {
    // vision slits in the bay door (glass, visual only) with a starfield behind, framed in steel
    const doorZ = dock.center.z + dock.size.z / 2 - 0.85;
    const star = starfieldMaterial();
    for (const y of [-6, 0, 6]) {
      const slit = new THREE.Mesh(new THREE.PlaneGeometry(70, 1.6), star);
      slit.position.set(dock.center.x, dock.center.y + y, doorZ);
      slit.rotation.y = Math.PI;
      addObj('dock', slit);
      for (const dy of [-1, 1]) addGeom('dock', mats.steel(true), boxAt(new THREE.Vector3(dock.center.x, dock.center.y + y + dy * 1.0, doorZ - 0.15), new THREE.Vector3(72, 0.4, 0.4)));
    }
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
      // root it in the displaced rock rather than the nominal wall plane
      base.addScaledVector(dir, -fbm(base.x * 0.06, base.y * 0.06, base.z * 0.06) * (DISPLACE[gallery.theme]?.wall ?? 0));
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

  // static light specs per room (landmark color): tall shafts get a light at each end, wide halls one per side
  const lights: RoomLightSpec[] = [];
  for (const r of arena.blueprint.rooms) {
    if (r.lights) {
      for (const l of r.lights) {
        lights.push({ room: r.id, pos: new THREE.Vector3(l.pos.x, l.pos.y, l.pos.z), color: new THREE.Color(l.color), intensity: l.intensity, distance: l.distance, decay: 2 });
      }
      continue;
    }
    const big = Math.max(r.size.x, r.size.y, r.size.z);
    const wide = Math.max(r.size.x, r.size.z);
    const color = new THREE.Color(r.light?.color ?? r.landmark);
    const scale = r.light?.scale ?? 1;
    const at = (x: number, y: number, z: number) => new THREE.Vector3(r.center.x + x, r.center.y + y, r.center.z + z);
    if (r.size.y < 0.3 * wide) {
      // a low floor plate: the ceiling is too close for one bright lamp, so four at mid-height with 1/d
      // falloff stand in for a ceiling full of fixtures and light it evenly
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        lights.push({ room: r.id, pos: at(sx * r.size.x * 0.27, 0, sz * r.size.z * 0.27), color, intensity: 1.5 * r.size.y * scale, distance: wide * 1.2, decay: 1 });
      }
      continue;
    }
    const pts: THREE.Vector3[] = r.id === 'hub'
      ? [at(30, 30, 30), at(-30, -25, -30)]
      : r.size.y > 1.5 * wide
        ? [at(0, r.size.y * 0.25, r.size.z * 0.35), at(0, -r.size.y * 0.25, -r.size.z * 0.35)]
        : wide >= 200
          ? [at(r.size.x * 0.25, r.size.y * 0.3, r.size.z * 0.25), at(-r.size.x * 0.25, r.size.y * 0.3, -r.size.z * 0.25)]
          : [at(0, r.size.y * 0.3, 0)];
    for (const p of pts) lights.push({ room: r.id, pos: p, color, intensity: (big * big * 0.9 * scale) / pts.length, distance: big * 1.6, decay: 2 });
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
    animate(t: number, tick = t / DT) {
      for (const a of animated) {
        const k = 0.75 + 0.25 * Math.sin(t * a.speed * Math.PI * 2);
        (a.mesh.material as THREE.MeshBasicMaterial).color.copy(a.base).multiplyScalar(k);
      }
      for (const m of movers) {
        if (!m.group.parent?.visible) continue;
        moverPose(m.def, tick, _mp, _mq);
        m.group.position.set(_mp.x, _mp.y, _mp.z);
        m.group.quaternion.set(_mq.x, _mq.y, _mq.z, _mq.w);
      }
      for (const s of shellMats) s.uniforms.uTime!.value = t;
      for (const s of spinners) s.mesh.rotation.y = t * s.rate;
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
      for (const s of shellMats) s.dispose();
      mats.dispose();
    },
  };
}

const _mp = v3(), _mq = q4();

/** Fresnel shell with slow scan bands: readable from outside, a faint haze from inside. */
function safeZoneMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(SAFE_ZONE_COLOR) }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 toCam = cameraPosition - vW;
        float dist = length(toCam);
        // pow() of a rounding-negative base is NaN, and bloom smears one NaN pixel into a black frame
        float f = clamp(1.0 - abs(dot(normalize(vN), toCam / dist)), 0.0, 1.0);
        float rim = pow(f, 1.6);
        float phase = vW.y * 0.45 - uTime * 1.6;
        float bands = smoothstep(0.86, 1.0, sin(phase) * 0.5 + 0.5) * (1.0 - smoothstep(0.4, 1.2, fwidth(phase)));
        // spawn cameras sit right on the shell; fading it near the eye stops it popping through the near plane.
        // Both faces stack at the silhouette, so the peak stays under the bloom threshold.
        float a = (rim * 0.26 + bands * (0.02 + f * 0.1) + 0.008) * smoothstep(4.0, 18.0, dist);
        gl_FragColor = vec4(uColor * a * 1.6, a);
      }`,
  });
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

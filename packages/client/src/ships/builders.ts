import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { superellipseRing, type LoftSection } from '@orange/shared';

/** LatheGeometry around local Z: profile is [z, r] pairs, ordered by z. */
export function lathe(profile: [number, number][], segments: number, scaleY = 1): THREE.BufferGeometry {
  const pts = profile.map(([z, r]) => new THREE.Vector2(Math.max(r, 1e-4), z));
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateX(Math.PI / 2);
  g.scale(1, scaleY, 1);
  // three's lathe winds faces outward when y increases; rotating by +90° about X maps y→z, keeping winding
  return g.toNonIndexed();
}

/** Superellipse cross-sections connected into a closed hull with caps. */
export function loft(sectionsIn: LoftSection[], ringPoints = 16, exponent = 2.5): THREE.BufferGeometry {
  const sections = sectionsIn.slice().sort((a, b) => a.z - b.z);
  const rings = sections.map((s) => superellipseRing(s, ringPoints, exponent).map(([x, y]) => new THREE.Vector3(x, y, s.z)));
  const pos: number[] = [];
  const push = (...vs: THREE.Vector3[]) => { for (const v of vs) pos.push(v.x, v.y, v.z); };
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i]!, r1 = rings[i + 1]!;
    for (let j = 0; j < ringPoints; j++) {
      const j1 = (j + 1) % ringPoints;
      const a = r0[j]!, b = r0[j1]!, c = r1[j1]!, d = r1[j]!;
      push(a, b, c, a, c, d);
    }
  }
  const cap = (ring: THREE.Vector3[], front: boolean) => {
    const c = ring.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    for (let j = 0; j < ringPoints; j++) {
      const a = ring[j]!, b = ring[(j + 1) % ringPoints]!;
      if (front) push(c, b, a); else push(c, a, b);
    }
  };
  cap(rings[0]!, true);
  cap(rings[rings.length - 1]!, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return smoothNormals(g);
}

/** Recompute normals smoothing across shared positions (non-indexed geometry). */
export function smoothNormals(g: THREE.BufferGeometry, creaseDeg = 50): THREE.BufferGeometry {
  g.computeVertexNormals();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const key = (i: number) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    let arr = groups.get(k);
    if (!arr) { arr = []; groups.set(k, arr); }
    arr.push(i);
  }
  const face = new Float32Array(n.array as Float32Array);
  const cos = Math.cos(creaseDeg * THREE.MathUtils.DEG2RAD);
  const v = new THREE.Vector3(), w = new THREE.Vector3(), acc = new THREE.Vector3();
  for (const idx of groups.values()) {
    for (const i of idx) {
      v.set(face[i * 3]!, face[i * 3 + 1]!, face[i * 3 + 2]!);
      acc.set(0, 0, 0);
      for (const j of idx) {
        w.set(face[j * 3]!, face[j * 3 + 1]!, face[j * 3 + 2]!);
        if (v.dot(w) >= cos) acc.add(w);
      }
      acc.normalize();
      n.setXYZ(i, acc.x, acc.y, acc.z);
    }
  }
  n.needsUpdate = true;
  return g;
}

export type OutlineRun = { line: [number, number][] } | { spline: [number, number][] };
export type OutlinePlane = 'xz' | 'zy';

/**
 * Shape from an outline → ExtrudeGeometry centered on its thickness.
 * 'xz': shape (x, z) lies in the XZ plane (wings), thickness along Y.
 * 'zy': shape (z, y) lies in the ZY plane (fins), thickness along X.
 */
export function extrudeOutline(outline: [number, number][] | OutlineRun[], thickness: number, bevel: number, plane: OutlinePlane): THREE.BufferGeometry {
  const runs: OutlineRun[] = Array.isArray(outline[0]) ? [{ line: outline as [number, number][] }] : outline as OutlineRun[];
  const shape = new THREE.Shape();
  let started = false;
  for (const run of runs) {
    const pts = 'line' in run ? run.line : run.spline;
    const v2 = pts.map(([a, b]) => new THREE.Vector2(a, b));
    if (!started) { shape.moveTo(v2[0]!.x, v2[0]!.y); started = true; v2.shift(); }
    if ('line' in run) for (const p of v2) shape.lineTo(p.x, p.y);
    else shape.splineThru(v2);
  }
  shape.closePath();
  const depth = Math.max(0.001, thickness - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 1, curveSegments: 6,
  });
  g.translate(0, 0, -depth / 2);
  if (plane === 'xz') g.rotateX(Math.PI / 2);
  else g.rotateY(-Math.PI / 2);
  g.deleteAttribute('uv');
  return g.index ? g.toNonIndexed() : g;
}

/** Wing post-process: thickness scales by 1 − taperK·|x|/span, then y −= droopK·x². */
export function taperAndDroop(g: THREE.BufferGeometry, droopK: number, taperK: number, span: number, midY = 0): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const t = Math.max(0.15, 1 - (taperK * Math.abs(x)) / span);
    const y = midY + (p.getY(i) - midY) * t - droopK * x * x;
    p.setY(i, y);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function flipWinding(g: THREE.BufferGeometry): void {
  if (g.index) {
    const idx = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]!; idx[i + 1] = idx[i + 2]!; idx[i + 2] = t; }
    g.index.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const s = a.itemSize, arr = a.array as Float32Array;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < s; k++) {
        const t = arr[(i + 1) * s + k]!; arr[(i + 1) * s + k] = arr[(i + 2) * s + k]!; arr[(i + 2) * s + k] = t;
      }
    }
    a.needsUpdate = true;
  }
}

/** Mirrored copy across X with corrected winding. */
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = (g.index ? g.toNonIndexed() : g.clone());
  m.scale(-1, 1, 1);
  flipWinding(m);
  return m;
}

export function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 2, r);
  g.deleteAttribute('uv');
  return g.toNonIndexed();
}

export interface Part { geom: THREE.BufferGeometry; mat: THREE.Material }

/** Merge part geometries per material so a ship has at most ~6 draw calls. */
export function mergeByMaterial(parts: Part[]): THREE.Mesh[] {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const { geom, mat } of parts) {
    let g = geom.index ? geom.toNonIndexed() : geom;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g = g as THREE.BufferGeometry;
    let arr = byMat.get(mat);
    if (!arr) { arr = []; byMat.set(mat, arr); }
    arr.push(g);
  }
  const meshes: THREE.Mesh[] = [];
  for (const [mat, geoms] of byMat) {
    const merged = mergeGeometries(geoms, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = mat.name;
    meshes.push(mesh);
  }
  return meshes;
}

// ------------------------------------------------------------------ placement helpers
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Transform a geometry in place: rotation (degrees, XYZ order) then translation. */
export function place(g: THREE.BufferGeometry, pos: [number, number, number], rotDeg: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  _e.set(rotDeg[0] * THREE.MathUtils.DEG2RAD, rotDeg[1] * THREE.MathUtils.DEG2RAD, rotDeg[2] * THREE.MathUtils.DEG2RAD);
  _q.setFromEuler(_e);
  _m.compose(new THREE.Vector3(...pos), _q, new THREE.Vector3(...scale));
  g.applyMatrix4(_m);
  return g;
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d).toNonIndexed();
/** Cylinder along Z. */
export function cylZ(r: number, len: number, seg = 10, rTop = r, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, r, len, seg, 1, open);
  g.rotateX(Math.PI / 2); // +Y → +Z, so rTop sits at +Z
  return g.toNonIndexed();
}
/** Cone pointing −Z. */
export function coneNegZ(r: number, h: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.rotateX(-Math.PI / 2); // apex (+Y) → −Z
  return g.toNonIndexed();
}
export function sphere(r: number, w = 16, h = 10): THREE.BufferGeometry { return new THREE.SphereGeometry(r, w, h).toNonIndexed(); }
export function hemisphere(r: number, down: boolean, w = 14, h = 6): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, Math.PI / 2);
  if (down) g.rotateX(Math.PI);
  return g.toNonIndexed();
}
/** Disc facing +Z. */
export function discZ(r: number, seg = 14): THREE.BufferGeometry { return new THREE.CircleGeometry(r, seg).toNonIndexed(); }
export function torusZ(R: number, tube: number, seg = 14): THREE.BufferGeometry { return new THREE.TorusGeometry(R, tube, 5, seg).toNonIndexed(); }

export function anchor(group: THREE.Object3D, name: string, pos: [number, number, number]): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(...pos);
  group.add(o);
  return o;
}

export function triangleCount(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      const g = m.geometry;
      n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    }
  });
  return n;
}

import * as THREE from 'three';
import { BRUTE_HULL_EXPONENT, BRUTE_HULL_SECTIONS, CLASSES, MULE_BODY_SECTIONS, type ClassId } from '@orange/shared';
import {
  anchor, box, coneNegZ, cylZ, discZ, extrudeOutline, hemisphere, lathe, loft, mergeByMaterial, mirrorX, place,
  roundedBox, sphere, taperAndDroop, torusZ, type Part,
} from './builders';
import { shipMaterials, type ShipMaterials } from './materials';

export interface ShipModel {
  classId: ClassId;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  mats: ShipMaterials;
  muzzles: THREE.Object3D[];
  engines: THREE.Object3D[];
  rcs: THREE.Object3D[];
  cockpit: THREE.Object3D;
  eye: THREE.Mesh | null;
  /** animate the scanner eye etc. */
  animate(t: number): void;
  dispose(): void;
}

type P3 = [number, number, number];
const both = (x: number, f: (sx: number) => void) => { f(x); f(-x); };

function finish(classId: ClassId, parts: Part[], mats: ShipMaterials, extra: (g: THREE.Group) => { eye: THREE.Mesh | null; animate: (t: number) => void }): ShipModel {
  const group = new THREE.Group();
  group.name = classId;
  const meshes = mergeByMaterial(parts);
  for (const m of meshes) group.add(m);
  const def = CLASSES[classId];
  const muzzles = def.muzzles.map((m, i) => anchor(group, `muzzle_${i}`, [m.x, m.y, m.z]));
  const cockpit = anchor(group, 'cockpit', [def.cockpit.x, def.cockpit.y, def.cockpit.z]);
  const { eye, animate } = extra(group);
  const engines: THREE.Object3D[] = [];
  const rcs: THREE.Object3D[] = [];
  group.traverse((o) => {
    if (o.name.startsWith('engine_')) engines.push(o);
    if (o.name.startsWith('rcs_')) rcs.push(o);
  });
  for (const p of parts) p.geom.dispose();
  return {
    classId, group, meshes, mats, muzzles, engines, rcs, cockpit, eye, animate,
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      eye?.geometry.dispose();
      for (const m of mats.all) m.dispose();
    },
  };
}

// ------------------------------------------------------------------ Dart
function buildDart(mats: ShipMaterials): ShipModel {
  const { hull, dark, canopy, accent, glow } = mats;
  const parts: Part[] = [];
  const add = (geom: THREE.BufferGeometry, mat: THREE.Material) => parts.push({ geom, mat });

  add(lathe([[-4.3, 0], [-3.9, 0.22], [-3.2, 0.45], [-2.2, 0.62], [-1.0, 0.74], [0.5, 0.82], [2.0, 0.8], [3.0, 0.72], [3.4, 0.7]], 10, 0.8), hull);
  add(place(discZ(0.7, 10), [0, 0, 3.4], [0, 0, 0], [1, 0.8, 1]), dark);
  add(place(coneNegZ(0.22, 0.7, 10), [0, 0, -4.0]), dark);
  add(place(sphere(1, 16, 10), [0, 0.48, -1.5], [0, 0, 0], [0.42, 0.36, 1.5]), canopy);

  const wing = extrudeOutline([[0.6, -0.2], [2.9, 1.9], [2.9, 2.8], [0.6, 3.0]], 0.16, 0.04, 'xz');
  place(wing, [0, -0.15, 0], [0, 0, -8]);
  add(wing, hull); add(mirrorX(wing), hull);
  both(2.95, (x) => add(place(box(0.12, 0.2, 0.9), [x, -0.55, 2.35], [0, 0, x > 0 ? -8 : 8]), accent));

  add(place(extrudeOutline([[1.1, 0.6], [2.7, 2.0], [3.4, 2.0], [3.4, 0.6]], 0.12, 0, 'zy'), [0, 0, 0]), hull);
  add(place(box(0.14, 0.1, 0.7), [0, 2.0, 3.05]), accent);

  const engines: P3[] = [[0.52, -0.18, 3.75], [-0.52, -0.18, 3.75], [0, 0.52, 3.75]];
  for (const [x, y, z] of engines) {
    add(place(cylZ(0.4, 1.5, 10, 0.4, true), [x, y, z]), dark);
    add(place(torusZ(0.38, 0.06, 12), [x, y, 4.5]), dark);
    add(place(discZ(0.32, 12), [x, y, 4.42]), glow);
  }
  both(0.8, (x) => add(place(box(0.35, 0.5, 1.2), [x, 0, 0.6]), dark));
  both(0.42, (x) => add(place(cylZ(0.06, 1.6, 6), [x, -0.2, -3.0]), dark));
  both(0.82, (x) => add(place(box(0.02, 0.18, 4.0), [x, 0.1, 0.8]), accent));

  return finish('dart', parts, mats, (g) => {
    engines.forEach(([x, y], i) => anchor(g, `engine_${i}`, [x, y, 4.55]));
    return { eye: null, animate: () => {} };
  });
}

// ------------------------------------------------------------------ Mule
function buildMule(mats: ShipMaterials): ShipModel {
  const { hull, dark, canopy, accent, glow } = mats;
  const parts: Part[] = [];
  const add = (geom: THREE.BufferGeometry, mat: THREE.Material) => parts.push({ geom, mat });

  add(loft(MULE_BODY_SECTIONS, 20, 4), hull);
  // windscreen sits on the sloped nose (the spec's placement is buried inside the boxy loft)
  add(place(box(1.9, 0.05, 1.25), [0, 0.6, -4.15], [-23, 0, 0]), canopy);
  add(place(box(0.08, 0.07, 1.3), [0, 0.62, -4.15], [-23, 0, 0]), dark);
  both(1.37, (x) => add(place(box(0.05, 0.35, 0.8), [x, 0.35, -2.2]), canopy));

  both(2.3, (x) => {
    add(place(roundedBox(1.0, 1.1, 5.4, 0.25), [x, -0.25, 0.9]), hull);
    add(place(box(0.02, 0.2, 3.5), [x + Math.sign(x) * 0.51, -0.1, 0.9]), accent);
    add(place(box(0.9, 0.35, 1.6), [Math.sign(x) * 1.75, -0.2, 0.9]), dark);
    for (const y of [0.0, -0.5]) {
      add(place(cylZ(0.28, 0.5, 10, 0.28, true), [x, y, 3.7]), dark);
      add(place(discZ(0.22, 10), [x, y, 3.85]), glow);
    }
    for (const z of [-1.6, 3.3]) for (const y of [0.2, -0.7]) add(place(box(0.2, 0.2, 0.2), [x + Math.sign(x) * 0.55, y, z]), dark);
  });
  add(place(box(2.2, 1.6, 0.05), [0, 0.05, 3.22]), dark);
  add(place(hemisphere(0.5, true), [0, -1.0, -1.2]), canopy);
  add(place(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6).toNonIndexed(), [0.6, 1.6, 1.0]), dark);
  add(place(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 12).toNonIndexed(), [0.6, 2.05, 1.0], [30, 0, 0]), dark);
  both(0.35, (x) => add(place(cylZ(0.07, 1.2, 6), [x, -0.75, -4.3]), dark));
  both(1.0, (x) => {
    add(place(box(0.08, 0.08, 3.0), [x, -1.35, 0]), dark);
    for (const z of [-0.9, 0.9]) add(place(box(0.06, 0.4, 0.06), [x, -1.15, z]), dark);
  });

  return finish('mule', parts, mats, (g) => {
    let i = 0;
    both(2.3, (x) => { for (const y of [0.0, -0.5]) anchor(g, `engine_${i++}`, [x, y, 3.96]); });
    let r = 0;
    both(2.3, (x) => { for (const z of [-1.6, 3.3]) for (const y of [0.2, -0.7]) anchor(g, `rcs_${r++}`, [x + Math.sign(x) * 0.65, y, z]); });
    return { eye: null, animate: () => {} };
  });
}

// ------------------------------------------------------------------ Scythe
function scytheLeading(): THREE.CatmullRomCurve3 {
  const pts: [number, number][] = [[0.9, -1.2], [2.2, -0.9], [3.4, -0.2], [4.3, 0.9], [4.6, 2.6]];
  return new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, -0.05 * x * x, z)));
}

function buildScythe(mats: ShipMaterials): ShipModel {
  const { hull, dark, accent, glow, eye: eyeMat } = mats;
  const parts: Part[] = [];
  const add = (geom: THREE.BufferGeometry, mat: THREE.Material) => parts.push({ geom, mat });

  add(place(sphere(1, 20, 14), [0, 0.1, -0.4], [0, 0, 0], [1.25, 0.85, 2.0]), hull);
  add(extrudeOutline([[-1.8, 0.75], [0, 1.05], [1.6, 0.8], [1.6, 0.6], [-1.8, 0.6]], 0.12, 0, 'zy'), dark);
  // visor band hugging the head front: an open cylinder arc scaled to the head ellipse
  const band = new THREE.CylinderGeometry(1, 1, 0.18, 16, 1, true, Math.PI - Math.PI / 3, (Math.PI * 2) / 3).toNonIndexed();
  add(place(band, [0, 0.15, -0.4], [0, 0, 0], [1.27, 1, 2.02]), dark);

  const wing = extrudeOutline([
    { spline: [[0.9, -1.2], [2.2, -0.9], [3.4, -0.2], [4.3, 0.9], [4.6, 2.6]] },
    { spline: [[4.0, 1.9], [3.0, 1.2], [1.9, 0.9], [0.9, 1.0]] },
  ], 0.28, 0.08, 'xz');
  taperAndDroop(wing, 0.05, 0.6, 4.6);
  add(wing, hull); add(mirrorX(wing), hull);

  const lead = scytheLeading();
  const leadTube = new THREE.TubeGeometry(lead, 24, 0.03, 4, false).toNonIndexed();
  add(leadTube, accent); add(mirrorX(leadTube), accent);
  for (const dz of [0.35, 0.7, 1.05]) {
    const ptsRib = lead.getPoints(16).map((p) => {
      const x = p.x * (1 - dz * 0.08);
      const top = 0.14 * Math.max(0.15, 1 - (0.6 * x) / 4.6) - 0.05 * x * x + 0.02;
      return new THREE.Vector3(x, top, p.z + dz);
    }).filter((p) => p.x < 4.2);
    const rib = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ptsRib), 16, 0.03, 3, false).toNonIndexed();
    add(rib, dark); add(mirrorX(rib), dark);
  }
  both(0.45, (x) => {
    add(place(box(0.5, 0.25, 0.3), [x, 0.05, 1.55]), dark);
    add(place(new THREE.PlaneGeometry(0.42, 0.18).toNonIndexed(), [x, 0.05, 1.71]), glow);
  });
  both(1.2, (x) => add(place(coneNegZ(0.08, 0.9, 8), [x, -0.1, -1.3]), dark));

  return finish('scythe', parts, mats, (g) => {
    let i = 0;
    both(0.45, (x) => anchor(g, `engine_${i++}`, [x, 0.05, 1.75]));
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), eyeMat);
    eye.name = 'eye';
    g.add(eye);
    const animate = (t: number) => {
      const a = (50 * Math.PI / 180) * Math.sin((t * Math.PI * 2) / 1.6);
      eye.position.set(1.28 * Math.sin(a), 0.15, -0.4 - 2.03 * Math.cos(a));
    };
    animate(0);
    return { eye, animate };
  });
}

// ------------------------------------------------------------------ Brute
function buildBrute(mats: ShipMaterials): ShipModel {
  const { hull, dark, accent, glow, eye: eyeMat } = mats;
  const parts: Part[] = [];
  const add = (geom: THREE.BufferGeometry, mat: THREE.Material) => parts.push({ geom, mat });

  add(loft(BRUTE_HULL_SECTIONS, 20, BRUTE_HULL_EXPONENT), hull);
  const mandible = loft([
    { z: -3.6, halfW: 0.7, halfH: 0.7, yOff: -0.5, xOff: 1.5 },
    { z: -5.2, halfW: 0.55, halfH: 0.55, yOff: -0.5, xOff: 1.38 },
    { z: -6.4, halfW: 0.3, halfH: 0.3, yOff: -0.5, xOff: 1.15 },
    { z: -7.0, halfW: 0.05, halfH: 0.05, yOff: -0.5, xOff: 1.0 },
  ], 12, 2);
  add(mandible, dark); add(mirrorX(mandible), dark);
  add(place(box(2.4, 0.3, 0.1), [0, 0.1, -4.66]), dark);

  both(1, (s) => {
    add(place(box(0.3, 1.6, 3.0), [2.85 * s, 0.2, -1.0], [0, 0, -15 * s]), dark);
    add(place(box(0.3, 1.6, 3.0), [2.75 * s, 0.0, 2.0], [0, 0, -15 * s]), dark);
  });
  const stub = extrudeOutline([[2.4, 0.5], [3.7, 2.2], [3.7, 3.6], [2.4, 4.2]], 0.4, 0.05, 'xz');
  stub.translate(-2.4, 0, 0);
  place(stub, [2.4, -0.6, 0], [0, 0, -25]);
  add(stub, hull); add(mirrorX(stub), hull);
  const tipY = -0.6 - Math.sin(25 * Math.PI / 180) * 1.3, tipX = 2.4 + Math.cos(25 * Math.PI / 180) * 1.3;
  both(tipX, (x) => add(place(box(0.2, 0.45, 1.4), [x, tipY, 2.9], [0, 0, x > 0 ? -25 : 25]), accent));

  add(place(hemisphere(0.9, false), [0, 1.85, 0]), dark);
  both(0.25, (x) => add(place(cylZ(0.12, 2.0, 8), [x, 2.0, -1.4]), dark));
  for (const x of [0.75, -0.75]) for (const y of [0.45, -0.45]) {
    add(place(box(0.9, 0.6, 0.4), [x, y, 5.6]), dark);
    add(place(new THREE.PlaneGeometry(0.78, 0.48).toNonIndexed(), [x, y, 5.81]), glow);
  }
  for (const z of [-2, -0.75, 0.5, 1.75, 3]) add(place(box(4.4, 0.15, 0.3), [0, -1.75, z]), dark);

  return finish('brute', parts, mats, (g) => {
    let i = 0;
    for (const x of [0.75, -0.75]) for (const y of [0.45, -0.45]) anchor(g, `engine_${i++}`, [x, y, 5.85]);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), eyeMat);
    eye.name = 'eye';
    g.add(eye);
    const animate = (t: number) => { eye.position.set(1.0 * Math.sin((t * Math.PI * 2) / 2.2), 0.1, -4.72); };
    animate(0);
    return { eye, animate };
  });
}

export function buildShip(classId: ClassId, accentIndex: number): ShipModel {
  const mats = shipMaterials(CLASSES[classId].faction, accentIndex);
  switch (classId) {
    case 'dart': return buildDart(mats);
    case 'mule': return buildMule(mats);
    case 'scythe': return buildScythe(mats);
    case 'brute': return buildBrute(mats);
  }
}

import * as THREE from 'three';
import { BRUTE_HULL_EXPONENT, BRUTE_HULL_SECTIONS, CLASSES, MULE_BODY_SECTIONS, type ClassId } from '@orange/shared';
import {
  anchor, arch, bellNozzle, box, chamferBox, coneNegZ, cylZ, discZ, extrudeOutline, grille, hemisphere, lathe, loft, mergeByMaterial,
  mirrorX, place, roundedBox, sphere, taperAndDroop, torusZ, type Part,
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
  // sensor band behind the nose cone
  add(place(torusZ(0.47, 0.035, 10), [0, 0, -3.15], [0, 0, 0], [1, 0.8, 1]), dark);

  // canopy: glass bubble on a dark sill, two frame hoops and a spine down the middle
  const CZ = -1.5, CY = 0.48, CRX = 0.42, CRY = 0.36, CRZ = 1.5;
  add(place(sphere(1, 18, 12), [0, CY, CZ], [0, 0, 0], [CRX, CRY, CRZ]), canopy);
  add(place(new THREE.TorusGeometry(1, 0.05, 4, 28).toNonIndexed(), [0, CY + 0.01, CZ], [90, 0, 0], [CRX + 0.02, CRZ + 0.02, 1]), dark);
  for (const dz of [-0.75, 0.35]) {
    const k = Math.sqrt(1 - (dz / CRZ) ** 2);
    add(place(arch(CRX * k + 0.012, CRY * k + 0.012, 0.09, 12), [0, CY, CZ + dz]), dark);
  }
  const spine = new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, i) => {
    const dz = -1.3 + (2.6 * i) / 8;
    return new THREE.Vector3(0, CY + CRY * Math.sqrt(Math.max(0, 1 - (dz / CRZ) ** 2)) + 0.008, CZ + dz);
  }));
  add(new THREE.TubeGeometry(spine, 16, 0.024, 4, false).toNonIndexed(), dark);
  // dorsal spine from the canopy back to the fin
  add(place(chamferBox(0.22, 0.14, 2.3, 0.05), [0, 0.66, 0.15]), hull);

  const wing = extrudeOutline([[0.6, -0.2], [2.9, 1.9], [2.9, 2.8], [0.6, 3.0]], 0.16, 0.04, 'xz');
  place(wing, [0, -0.15, 0], [0, 0, -8]);
  add(wing, hull); add(mirrorX(wing), hull);
  // trailing-edge flaps and a root fairing, laid out in the wing's own plane before the anhedral
  const flap = place(chamferBox(1.9, 0.05, 0.32, 0.015), [1.72, 0.085, 2.72]);
  place(flap, [0, -0.15, 0], [0, 0, -8]);
  add(flap, dark); add(mirrorX(flap), dark);
  const root = place(chamferBox(0.42, 0.22, 2.6, 0.06), [0.72, 0.0, 1.35]);
  place(root, [0, -0.15, 0], [0, 0, -8]);
  add(root, hull); add(mirrorX(root), hull);
  both(2.95, (x) => add(place(chamferBox(0.12, 0.2, 0.9, 0.03), [x, -0.55, 2.35], [0, 0, x > 0 ? -8 : 8]), accent));

  add(place(extrudeOutline([[1.1, 0.6], [2.7, 2.0], [3.4, 2.0], [3.4, 0.6]], 0.12, 0, 'zy'), [0, 0, 0]), hull);
  add(place(box(0.14, 0.1, 0.7), [0, 2.0, 3.05]), accent);
  // rudder panel along the fin's trailing edge
  add(place(chamferBox(0.15, 1.15, 0.34, 0.03), [0, 1.3, 3.22]), dark);

  const engines: P3[] = [[0.52, -0.18, 3.75], [-0.52, -0.18, 3.75], [0, 0.52, 3.75]];
  for (const [x, y, z] of engines) {
    add(place(cylZ(0.4, 1.5, 12, 0.4, true), [x, y, z]), dark);
    // raised bands along the housing, then a bell with petals around the lip
    for (const bz of [3.25, 3.95]) add(place(torusZ(0.405, 0.035, 12), [x, y, bz]), dark);
    const n = bellNozzle(0.38, 0.4, 4.55, 14);
    add(place(n.shell, [x, y, 0]), dark);
    add(place(n.glow, [x, y, 0]), glow);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      add(place(box(0.13, 0.03, 0.24), [x + Math.cos(a) * 0.43, y + Math.sin(a) * 0.43, 4.38], [0, 0, (a * 180) / Math.PI - 90]), dark);
    }
  }
  // intakes: chamfered shells with dark mouths facing forward
  both(0.8, (x) => {
    add(place(chamferBox(0.36, 0.5, 1.2, 0.07), [x, 0, 0.6]), dark);
    add(place(box(0.26, 0.38, 0.02), [x, 0, -0.005]), canopy);
  });
  // guns: barrels with a fairing at the root and a muzzle brake at the tip
  both(0.42, (x) => {
    add(place(cylZ(0.06, 1.6, 8), [x, -0.2, -3.0]), dark);
    add(place(chamferBox(0.18, 0.16, 0.8, 0.04), [x, -0.2, -2.3]), dark);
    add(place(cylZ(0.085, 0.16, 8), [x, -0.2, -3.7]), dark);
  });
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
  /** geometry offset in a part's own frame, then posed like that part */
  const local = (g: THREE.BufferGeometry, off: P3, pos: P3, rot: P3) => place(g.translate(...off), pos, rot);

  add(loft(MULE_BODY_SECTIONS, 20, 4), hull);
  // windscreen sits on the sloped nose (the spec's placement is buried inside the boxy loft), framed all round
  const WS: P3 = [0, 0.6, -4.15], WR: P3 = [-23, 0, 0];
  add(place(box(1.9, 0.05, 1.25), WS, WR), canopy);
  add(local(chamferBox(0.08, 0.07, 1.3, 0.02), [0, 0.02, 0], WS, WR), dark);
  both(0.97, (x) => add(local(chamferBox(0.09, 0.08, 1.33, 0.025), [x, 0.02, 0], WS, WR), dark));
  for (const z of [-0.66, 0.66]) add(local(chamferBox(2.03, 0.08, 0.09, 0.025), [0, 0.02, z], WS, WR), dark);
  both(1.37, (x) => {
    add(place(box(0.05, 0.35, 0.8), [x, 0.35, -2.2]), canopy);
    add(place(chamferBox(0.04, 0.45, 0.9, 0.012), [x + Math.sign(x) * 0.012, 0.35, -2.2]), dark);
  });
  // side hatch and its handle, roof vents, a sensor blister and rails along the roof edges
  both(1.5, (x) => {
    add(place(chamferBox(0.04, 1.0, 1.35, 0.012), [x, 0.08, -0.25]), dark);
    add(place(box(0.03, 0.08, 0.3), [x + Math.sign(x) * 0.03, 0.15, 0.1]), hull);
  });
  both(0.62, (x) => {
    add(place(chamferBox(0.75, 0.08, 0.9, 0.02), [x, 1.2, 1.7]), dark);
    add(place(grille(0.62, 0.7, 5, 0.04, 30), [x, 1.25, 1.7], [-90, 0, 0]), hull);
  });
  add(place(hemisphere(0.28, false, 12, 5), [-0.6, 1.16, -1.6]), canopy);
  both(1.25, (x) => add(place(chamferBox(0.08, 0.08, 4.6, 0.02), [x, 1.15, 0.3]), hull));

  both(2.3, (x) => {
    add(place(roundedBox(1.0, 1.1, 5.4, 0.25), [x, -0.25, 0.9]), hull);
    add(place(box(0.02, 0.2, 3.5), [x + Math.sign(x) * 0.51, -0.1, 0.9]), accent);
    // panel bands round the nacelle, an intake grille in its nose
    for (const z of [-0.2, 2.3]) add(place(chamferBox(1.05, 1.15, 0.14, 0.04), [x, -0.25, z]), dark);
    add(place(box(0.72, 0.78, 0.02), [x, -0.25, -1.8]), canopy);
    add(place(grille(0.7, 0.76, 5, 0.05, 25), [x, -0.25, -1.79]), dark);
    add(place(chamferBox(0.9, 0.35, 1.6, 0.06), [Math.sign(x) * 1.75, -0.2, 0.9]), dark);
    for (const y of [0.0, -0.5]) {
      add(place(cylZ(0.28, 0.3, 12, 0.28, true), [x, y, 3.65]), dark);
      const n = bellNozzle(0.28, 0.32, 3.96, 12);
      add(place(n.shell, [x, y, 0]), dark);
      add(place(n.glow, [x, y, 0]), glow);
    }
    // RCS quads: a block with a dark thruster port on its outboard face (kept inside the old envelope)
    for (const z of [-1.6, 3.3]) for (const y of [0.2, -0.7]) {
      const sx = Math.sign(x);
      add(place(chamferBox(0.2, 0.2, 0.2, 0.035), [x + sx * 0.55, y, z]), dark);
      add(place(discZ(0.06, 8), [x + sx * 0.652, y, z], [0, sx * 90, 0]), canopy);
    }
  });
  // rear hatch: ribs, a hinge along the top and nav lights in its corners
  add(place(box(2.2, 1.6, 0.05), [0, 0.05, 3.22]), dark);
  for (const y of [-0.4, 0.05, 0.5]) add(place(chamferBox(1.9, 0.1, 0.06, 0.02), [0, y, 3.26]), hull);
  add(place(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 8).toNonIndexed(), [0, 0.85, 3.24], [0, 0, 90]), dark);
  both(0.95, (x) => add(place(box(0.1, 0.1, 0.04), [x, -0.62, 3.26]), accent));
  add(place(hemisphere(0.5, true), [0, -1.0, -1.2]), canopy);
  add(place(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6).toNonIndexed(), [0.6, 1.6, 1.0]), dark);
  add(place(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 12).toNonIndexed(), [0.6, 2.05, 1.0], [30, 0, 0]), dark);
  // chin guns in a housing under the nose
  add(place(chamferBox(0.95, 0.24, 0.7, 0.05), [0, -0.74, -3.55]), dark);
  both(0.35, (x) => {
    add(place(cylZ(0.07, 1.2, 8), [x, -0.75, -4.3]), dark);
    add(place(cylZ(0.095, 0.14, 8), [x, -0.75, -4.84]), dark);
  });
  both(1.0, (x) => {
    add(place(box(0.08, 0.08, 3.0), [x, -1.35, 0]), dark);
    for (const z of [-0.9, 0.9]) add(place(box(0.06, 0.4, 0.06), [x, -1.15, z]), dark);
    for (const z of [-1.45, 1.45]) add(place(chamferBox(0.22, 0.06, 0.3, 0.02), [x, -1.4, z]), dark);
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

  const HEAD: P3 = [0, 0.1, -0.4], HR: P3 = [1.25, 0.85, 2.0];
  add(place(sphere(1, 28, 18), HEAD, [0, 0, 0], HR), hull);
  // segment grooves round the back of the head (behind the eye's sweep)
  for (const dz of [0.75, 1.35]) {
    const k = Math.sqrt(1 - (dz / HR[2]) ** 2);
    add(place(torusZ(1, 0.035, 26), [HEAD[0], HEAD[1], HEAD[2] + dz], [0, 0, 0], [HR[0] * k + 0.01, HR[1] * k + 0.01, 1]), dark);
  }
  add(extrudeOutline([[-1.8, 0.75], [0, 1.05], [1.6, 0.8], [1.6, 0.6], [-1.8, 0.6]], 0.12, 0, 'zy'), dark);
  // spines raking back off the ridge
  for (const [z, top] of [[-1.0, 0.88], [-0.2, 1.02], [0.6, 0.96]] as const) {
    add(place(coneNegZ(0.05, 0.26, 6), [0, top + 0.05, z + 0.1], [148, 0, 0]), dark);
  }
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
  // one more rib further back, short of the narrowing tip
  {
    const dz = 1.4;
    const ptsRib = lead.getPoints(16).map((p) => {
      const x = p.x * (1 - dz * 0.08);
      const top = 0.14 * Math.max(0.15, 1 - (0.6 * x) / 4.6) - 0.05 * x * x + 0.02;
      return new THREE.Vector3(x, top, p.z + dz);
    }).filter((p) => p.x < 3.5);
    const rib = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ptsRib), 12, 0.026, 3, false).toNonIndexed();
    add(rib, dark); add(mirrorX(rib), dark);
  }
  // sinews from the sides of the head out along each wing root
  const sinew = (pts: [number, number, number, number, number][]) =>
    loft(pts.map(([z, x, y, hw, hh]) => ({ z, xOff: x, yOff: y, halfW: hw, halfH: hh })), 10, 2);
  for (const sw of [
    sinew([[-0.9, 0.9, 0.12, 0.2, 0.15], [-0.2, 1.3, 0.07, 0.16, 0.11], [0.5, 1.75, 0.0, 0.1, 0.07], [1.0, 2.05, -0.06, 0.04, 0.03]]),
    sinew([[-0.1, 0.95, 0.1, 0.12, 0.09], [0.5, 1.6, 0.04, 0.09, 0.06], [1.15, 2.4, -0.12, 0.03, 0.025]]),
  ]) { add(sw, dark); add(mirrorX(sw), dark); }
  both(0.45, (x) => {
    add(place(chamferBox(0.52, 0.27, 0.32, 0.05), [x, 0.05, 1.55]), dark);
    add(place(new THREE.PlaneGeometry(0.42, 0.18).toNonIndexed(), [x, 0.05, 1.715]), glow);
  });
  both(1.2, (x) => {
    add(place(coneNegZ(0.08, 0.9, 8), [x, -0.1, -1.3]), dark);
    add(place(torusZ(0.095, 0.028, 8), [x, -0.1, -0.88]), dark);
  });

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

  add(loft(BRUTE_HULL_SECTIONS, 32, BRUTE_HULL_EXPONENT), hull);
  /** height of the hull's top centerline at z (sections interpolated) */
  const hullTop = (z: number) => {
    const S = BRUTE_HULL_SECTIONS;
    for (let i = 0; i < S.length - 1; i++) {
      const a = S[i]!, b = S[i + 1]!;
      if (z >= a.z && z <= b.z) { const t = (z - a.z) / (b.z - a.z); return a.yOff + a.halfH + t * (b.yOff + b.halfH - a.yOff - a.halfH); }
    }
    return 0;
  };
  const mandible = loft([
    { z: -3.6, halfW: 0.7, halfH: 0.7, yOff: -0.5, xOff: 1.5 },
    { z: -5.2, halfW: 0.55, halfH: 0.55, yOff: -0.5, xOff: 1.38 },
    { z: -6.4, halfW: 0.3, halfH: 0.3, yOff: -0.5, xOff: 1.15 },
    { z: -7.0, halfW: 0.05, halfH: 0.05, yOff: -0.5, xOff: 1.0 },
  ], 12, 2);
  // teeth along each mandible's inner edge, pointing across the gap
  for (const [z, x] of [[-4.4, 0.7], [-5.2, 0.71], [-6.0, 0.73]] as const) {
    const tooth = place(coneNegZ(0.07, 0.3, 6), [x, -0.5, z], [0, 90, 0]);
    add(tooth, dark); add(mirrorX(tooth), dark);
  }
  add(mandible, dark); add(mirrorX(mandible), dark);
  add(place(box(2.4, 0.3, 0.1), [0, 0.1, -4.66]), dark);
  // hull-colored lips framing the scanner band (clear of the eye's path)
  for (const y of [-0.1, 0.3]) add(place(chamferBox(2.6, 0.08, 0.16, 0.025), [0, y, -4.66]), hull);

  both(1, (s) => {
    add(place(chamferBox(0.3, 1.6, 3.0, 0.07), [2.85 * s, 0.2, -1.0], [0, 0, -15 * s]), dark);
    add(place(chamferBox(0.3, 1.6, 3.0, 0.07), [2.75 * s, 0.0, 2.0], [0, 0, -15 * s]), dark);
    // upper row, laid along the shoulder where the hull's surface normal leans ~37° up
    add(place(chamferBox(0.22, 1.0, 2.6, 0.05), [2.5 * s, 1.1, -0.6], [0, 0, 37 * s]), dark);
    add(place(chamferBox(0.22, 1.0, 2.4, 0.05), [2.42 * s, 1.05, 2.1], [0, 0, 37 * s]), dark);
    // gill slats low on the aft flank
    add(place(grille(1.2, 0.7, 4, 0.05, 22), [2.33 * s, -0.55, 3.4], [0, 90 * s, 0]), dark);
  });
  // dorsal armor plates down the spine, pitched to follow the hull's slope
  for (const z of [-2.5, -1.55, 1.5, 2.45, 3.4]) {
    const y = hullTop(z), slope = (hullTop(z + 0.3) - hullTop(z - 0.3)) / 0.6;
    add(place(chamferBox(1.3, 0.16, 0.85, 0.04), [0, y + 0.03, z], [(-Math.atan(slope) * 180) / Math.PI, 0, 0]), dark);
  }
  const stub = extrudeOutline([[2.4, 0.5], [3.7, 2.2], [3.7, 3.6], [2.4, 4.2]], 0.4, 0.05, 'xz');
  stub.translate(-2.4, 0, 0);
  place(stub, [2.4, -0.6, 0], [0, 0, -25]);
  add(stub, hull); add(mirrorX(stub), hull);
  const tipY = -0.6 - Math.sin(25 * Math.PI / 180) * 1.3, tipX = 2.4 + Math.cos(25 * Math.PI / 180) * 1.3;
  both(tipX, (x) => add(place(chamferBox(0.2, 0.45, 1.4, 0.05), [x, tipY, 2.9], [0, 0, x > 0 ? -25 : 25]), accent));

  add(place(hemisphere(0.9, false, 18, 7), [0, 1.85, 0]), dark);
  add(place(new THREE.TorusGeometry(0.95, 0.07, 4, 24).toNonIndexed(), [0, 1.87, 0], [90, 0, 0]), dark);
  add(place(chamferBox(0.75, 0.3, 0.5, 0.06), [0, 2.0, -0.78]), dark);
  both(0.25, (x) => {
    add(place(cylZ(0.12, 2.0, 8), [x, 2.0, -1.4]), dark);
    add(place(cylZ(0.17, 0.25, 8), [x, 2.0, -2.27]), dark);
  });
  for (const x of [0.75, -0.75]) for (const y of [0.45, -0.45]) {
    add(place(chamferBox(0.9, 0.6, 0.4, 0.06), [x, y, 5.6]), dark);
    add(place(new THREE.PlaneGeometry(0.78, 0.48).toNonIndexed(), [x, y, 5.81]), glow);
    // two thin bars across each vent: enough to read as a grate, not enough to dim it
    add(place(grille(0.8, 0.48, 2, 0.03, 0, 0.3), [x, y, 5.835]), dark);
  }
  for (const z of [-2, -0.75, 0.5, 1.75, 3]) add(place(chamferBox(4.4, 0.15, 0.3, 0.04), [0, -1.75, z]), dark);

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

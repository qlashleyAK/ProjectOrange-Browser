import * as THREE from 'three';
import type { Faction } from '@orange/shared';

/** 10 saturated accents around the hue wheel, skipping the reserved orange band (10°–50°). */
export const ACCENT_HUES = [55, 90, 125, 160, 192, 222, 255, 285, 318, 350];
export function accentColor(i: number): THREE.Color {
  const h = ACCENT_HUES[((i % ACCENT_HUES.length) + ACCENT_HUES.length) % ACCENT_HUES.length]!;
  return new THREE.Color().setHSL(h / 360, 0.85, 0.55);
}
export function accentCss(i: number): string { return `#${accentColor(i).getHexString()}`; }

const NOISE_GLSL = /* glsl */ `
float po_hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float po_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float po_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(po_hash13(i), po_hash13(i + vec3(1,0,0)), f.x), mix(po_hash13(i + vec3(0,1,0)), po_hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(po_hash13(i + vec3(0,0,1)), po_hash13(i + vec3(1,0,1)), f.x), mix(po_hash13(i + vec3(0,1,1)), po_hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float po_fbm(vec3 p) { return po_noise(p) * 0.55 + po_noise(p * 2.07) * 0.3 + po_noise(p * 4.3) * 0.15; }
`;

const PANEL_GLSL = /* glsl */ `
// returns x: panel line mask, y: hatch mask
vec2 po_panels(vec2 uv) {
  float rowH = 0.85;
  float row = floor(uv.y / rowH);
  float w = 0.6 + 0.8 * po_hash12(vec2(row, 7.0));
  float xs = uv.x / w + po_hash12(vec2(row, 3.0));
  float col = floor(xs);
  vec2 f = vec2(fract(xs) * w, fract(uv.y / rowH) * rowH);
  vec2 d = min(f, vec2(w, rowH) - f);
  float line = 1.0 - smoothstep(0.004, 0.015, min(d.x, d.y));
  float h = po_hash12(vec2(col, row) + 11.0);
  vec2 c = abs(f - vec2(w, rowH) * 0.5);
  float hatch = h < 0.1 ? (1.0 - step(0.16, c.x)) * (1.0 - step(0.1, c.y)) : 0.0;
  return vec2(line, hatch);
}
`;

export interface HullUniforms {
  uDamage: { value: number };
  uTime: { value: number };
}

/** MeshStandardMaterial with the procedural hull detail shader (object-space triplanar, no UVs). */
export function hullMaterial(name: string, faction: Faction, color: number, metal: number, rough: number): THREE.MeshStandardMaterial & { userData: { uniforms: HullUniforms } } {
  const mat = new THREE.MeshStandardMaterial({ name, color, metalness: metal, roughness: rough });
  const uniforms: HullUniforms = { uDamage: { value: 0 }, uTime: { value: 0 } };
  mat.userData.uniforms = uniforms;
  const machine = faction === 'machine';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDamage = uniforms.uDamage;
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;\nuniform float uDamage;\nuniform float uTime;\n${NOISE_GLSL}\n${PANEL_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 an = abs(normalize(vObjNormal));
        vec3 tw = an / (an.x + an.y + an.z);
        float detailDark = 0.0;
        ${machine ? `
        float ridge = sin(vObjPos.z * 4.0 + po_noise(vec3(vObjPos.xy * 1.3, 0.0)) * 2.0);
        diffuseColor.rgb *= 0.9 + 0.12 * ridge;
        ` : `
        vec2 px = po_panels(vObjPos.zy); vec2 py = po_panels(vObjPos.xz); vec2 pz = po_panels(vObjPos.xy);
        vec2 pm = px * tw.x + py * tw.y + pz * tw.z;
        detailDark = max(pm.x * 0.45, pm.y * 0.35);
        float grime = smoothstep(1.0, 4.5, vObjPos.z) * (0.5 + 0.5 * po_noise(vObjPos * 3.0));
        diffuseColor.rgb *= 1.0 - grime * 0.25;
        `}
        diffuseColor.rgb *= 1.0 - detailDark;
        float scorchN = po_fbm(vObjPos * 1.4 + 3.1);
        float scorch = uDamage > 0.0 ? smoothstep(0.75 - uDamage * 0.35, 0.8 - uDamage * 0.3, scorchN) : 0.0;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.025, 0.02), scorch * 0.85);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${machine ? `roughnessFactor = clamp(roughnessFactor + (po_noise(vObjPos * 9.0) - 0.5) * 0.25, 0.04, 1.0);`
          : `roughnessFactor = clamp(roughnessFactor + (po_noise(vObjPos * 6.0) - 0.5) * 0.12 + detailDark * 0.2, 0.04, 1.0);`}
        roughnessFactor = mix(roughnessFactor, 0.95, scorch);
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        ${machine ? `
        float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
        vec3 irid = mix(vec3(0.25, 0.35, 1.0), vec3(0.65, 0.3, 1.0), 0.5 + 0.5 * sin(uTime * 0.4 + vObjPos.z * 0.8));
        totalEmissiveRadiance += irid * fres * 0.12;
        ` : ''}
      `);
  };
  mat.customProgramCacheKey = () => `hull-${faction}`;
  return mat as THREE.MeshStandardMaterial & { userData: { uniforms: HullUniforms } };
}

export interface ShipMaterials {
  hull: THREE.MeshStandardMaterial & { userData: { uniforms: HullUniforms } };
  dark: THREE.MeshStandardMaterial & { userData: { uniforms: HullUniforms } };
  canopy: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
  eye: THREE.MeshBasicMaterial;
  all: THREE.Material[];
}

export function shipMaterials(faction: Faction, accentIndex: number): ShipMaterials {
  const machine = faction === 'machine';
  const acc = accentColor(accentIndex);
  const hull = machine ? hullMaterial('machineHull', faction, 0x4a4f57, 0.95, 0.28) : hullMaterial('fleetHull', faction, 0xd9dce0, 0.3, 0.55);
  const dark = machine ? hullMaterial('machineDark', faction, 0x1c1f24, 0.8, 0.5) : hullMaterial('fleetDark', faction, 0x3a3f46, 0.6, 0.45);
  const canopy = new THREE.MeshStandardMaterial({
    name: 'canopy', color: 0x0b1a24, metalness: 0.9, roughness: 0.08, emissive: new THREE.Color(0x0a2030), emissiveIntensity: 0.2,
  });
  const accent = new THREE.MeshStandardMaterial({ name: 'accent', color: acc, metalness: 0.3, roughness: 0.4, emissive: acc, emissiveIntensity: 0.6 });
  const glowC = new THREE.Color(machine ? 0xc04bff : 0x9fe8ff).multiplyScalar(6);
  const glow = new THREE.MeshBasicMaterial({ name: machine ? 'glowMachine' : 'glowFleet', color: glowC });
  const eye = new THREE.MeshBasicMaterial({ name: 'scannerRed', color: new THREE.Color(0xff2030).multiplyScalar(8) });
  return { hull, dark, canopy, accent, glow, eye, all: [hull, dark, canopy, accent, glow, eye] };
}

/** Cloak shimmer: fresnel rim, low alpha, slight vertex wobble. */
export function cloakMaterial(): THREE.ShaderMaterial & { uniforms: { uTime: { value: number }; uAlpha: { value: number } } } {
  return new THREE.ShaderMaterial({
    name: 'cloak',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uAlpha: { value: 0.12 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 p = position + normal * (0.04 * sin(uTime * 9.0 + position.z * 3.0 + position.x * 2.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal); vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.5);
        gl_FragColor = vec4(vec3(0.55, 0.75, 1.0) * (f * 1.6 + 0.1), uAlpha + f * 0.25);
      }`,
  }) as THREE.ShaderMaterial & { uniforms: { uTime: { value: number }; uAlpha: { value: number } } };
}

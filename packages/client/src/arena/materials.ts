import * as THREE from 'three';
import type { PropMaterial, Theme } from '@orange/shared';

const NOISE = /* glsl */ `
float pa_hash(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float pa_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(pa_hash(i), pa_hash(i + vec3(1,0,0)), f.x), mix(pa_hash(i + vec3(0,1,0)), pa_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(pa_hash(i + vec3(0,0,1)), pa_hash(i + vec3(1,0,1)), f.x), mix(pa_hash(i + vec3(0,1,1)), pa_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float pa_fbm(vec3 p) { return pa_noise(p) * 0.5 + pa_noise(p * 2.1) * 0.3 + pa_noise(p * 4.7) * 0.2; }
// fw = noise cycles per pixel; octaves finer than a pixel settle to their mean instead of sparkling
float pa_noiseAA(vec3 x, float fw) { return mix(pa_noise(x), 0.5, smoothstep(0.25, 0.7, fw)); }
float pa_fbmAA(vec3 p, float fw) { return pa_noiseAA(p, fw) * 0.5 + pa_noiseAA(p * 2.1, fw * 2.1) * 0.3 + pa_noiseAA(p * 4.7, fw * 4.7) * 0.2; }
float pa_grid(vec2 uv, float cell, float w) {
  vec2 px = max(fwidth(uv), vec2(1e-4));
  vec2 f = fract(uv / cell) * cell; vec2 d = min(f, cell - f);
  vec2 ww = max(vec2(w), px);
  vec2 l = (1.0 - smoothstep(ww * 0.5, ww, d)) * (w / ww) * (1.0 - smoothstep(0.12, 0.35, px / cell));
  return max(l.x, l.y);
}
// box-filtered 50% square wave
float pa_stripe(float t) {
  float fw = max(fwidth(t), 1e-4);
  vec2 e = vec2(t - fw * 0.5, t + fw * 0.5);
  vec2 i = floor(e) * 0.5 + max(fract(e) - 0.5, 0.0);
  return clamp((i.y - i.x) / fw, 0.0, 1.0);
}
`;

/**
 * At most one star per cell (so none straddles a border), `density` of cells lit. A star never shrinks below a
 * pixel: it spreads over one and dims to match, so distant stars fade out instead of sparkling.
 */
const STARS = /* glsl */ `
float pa_stars(vec2 p, float px, float density, float rad) {
  vec3 k = vec3(floor(p), 0.0);
  if (pa_hash(k + vec3(0.0, 0.0, 1.0)) > density) return 0.0;
  vec2 c = vec2(pa_hash(k + vec3(0.0, 0.0, 2.0)), pa_hash(k + vec3(0.0, 0.0, 3.0))) * 0.6 + 0.2;
  float r = rad * (0.6 + 0.8 * pa_hash(k + vec3(0.0, 0.0, 4.0)));
  float rr = max(r, px);
  float b = (1.0 - smoothstep(rr * 0.35, rr, length(fract(p) - c))) * (r * r) / (rr * rr);
  float m = pa_hash(k + vec3(0.0, 0.0, 5.0));
  return b * (0.25 + 1.5 * m * m * m) * (1.0 - smoothstep(0.25, 0.5, px));
}
`;

export type ArenaSurface = 'metal' | 'rock' | 'hazard' | 'concrete' | 'plaster' | 'carpet' | 'tiles' | 'membrane' | 'fabric';

export interface ArenaMatOpts {
  name: string; color: number; surface: ArenaSurface; metal?: number; rough?: number; panel?: number; emissive?: number; emissiveIntensity?: number;
  /** texture in the mesh's own space, so the pattern rides along with moving fixtures */
  objectSpace?: boolean;
  /** concrete only: dark oil stains on upward faces */
  stains?: boolean;
}

/** Per-surface detail, modulating `diffuseColor` and setting `detail` (roughness wobble). */
function surfaceGlsl(o: ArenaMatOpts, panel: string): string {
  switch (o.surface) {
    case 'rock': return `
      float n1 = pa_fbmAA(vWPos * 0.12, pxw * 0.12);
      float n2 = pa_fbmAA(vWPos * 0.9 + 7.0, pxw * 0.9);
      diffuseColor.rgb *= 0.6 + 0.6 * n1;
      diffuseColor.rgb *= 0.85 + 0.3 * n2;
      float strata = 0.5 + 0.5 * sin(vWPos.y * 0.7 + n1 * 6.0);
      diffuseColor.rgb *= 0.9 + 0.12 * strata;
      detail = n2;`;
    case 'hazard': return `
      float s = pa_stripe((vWPos.x + vWPos.y + vWPos.z) * 0.25);
      diffuseColor.rgb = mix(vec3(0.02), diffuseColor.rgb, s);`;
    case 'concrete': return `
      float big = pa_fbm(vWPos * 0.035);
      float mid = pa_fbmAA(vWPos * 0.25, pxw * 0.25);
      float pores = pa_noiseAA(vWPos * 2.3, pxw * 2.3);
      // rain streaks run down walls, not across floors
      float streak = pa_noiseAA(vec3(vWPos.x * 0.35, vWPos.y * 0.025, vWPos.z * 0.35), pxw * 0.35) * (1.0 - dom.y);
      float seams = pa_grid(puv, ${panel}, 0.08);
      diffuseColor.rgb *= 0.72 + 0.4 * big;
      diffuseColor.rgb *= 0.88 + 0.2 * mid;
      diffuseColor.rgb *= 0.92 + 0.12 * pores;
      diffuseColor.rgb *= 1.0 - smoothstep(0.55, 0.8, streak) * 0.25;
      diffuseColor.rgb *= 1.0 - seams * 0.25;
      detail = mid;
      ${o.stains ? `
      float oil = smoothstep(0.6, 0.7, pa_fbm(vWPos * 0.06 + 3.0)) * dom.y;
      diffuseColor.rgb *= 1.0 - oil * 0.55;
      detail -= oil * 1.2;` : ''}`;
    case 'plaster': return `
      float big = pa_fbm(vWPos * 0.05);
      float fine = pa_noiseAA(vWPos * 1.3, pxw * 1.3);
      float damp = smoothstep(0.55, 0.85, pa_fbm(vec3(vWPos.x * 0.08, vWPos.y * 0.03, vWPos.z * 0.08) + 11.0));
      diffuseColor.rgb *= 0.85 + 0.25 * big;
      diffuseColor.rgb *= 0.95 + 0.08 * fine;
      diffuseColor.rgb *= 1.0 - damp * 0.35;
      detail = 0.5 + fine * 0.3;`;
    case 'carpet': return `
      // 4 m carpet tiles laid in alternating pile directions read as a faint checker
      float sx = pa_stripe(vWPos.x / 8.0), sz = pa_stripe(vWPos.z / 8.0);
      float chk = sx + sz - 2.0 * sx * sz;
      float pile = pa_noiseAA(vWPos * 3.1, pxw * 3.1);
      float stain = smoothstep(0.6, 0.75, pa_fbm(vWPos * 0.05 + 5.0));
      diffuseColor.rgb *= 0.9 + 0.12 * chk;
      diffuseColor.rgb *= 0.85 + 0.25 * pile;
      diffuseColor.rgb *= 1.0 - stain * 0.4;
      detail = 0.6;`;
    case 'tiles': return `
      // 6 m drop-ceiling tiles on dark T-bars; some missing (the plenum shows through), some water-stained
      float bars = pa_grid(vWPos.xz, 6.0, 0.35);
      float h = pa_hash(vec3(floor(vWPos.xz / 6.0), 7.0));
      float far = smoothstep(0.1, 0.3, pxw / 6.0);
      float missing = step(h, 0.1) * (1.0 - far);
      float stained = step(0.82, h) * (1.0 - far);
      diffuseColor.rgb *= 1.0 - missing * 0.85;
      diffuseColor.rgb *= 1.0 - stained * 0.22;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.17, 0.18), bars * 0.8);
      diffuseColor.rgb *= 0.9 + 0.15 * pa_noiseAA(vWPos * 2.0, pxw * 2.0);
      detail = 0.5;`;
    case 'membrane': return `
      // tar-and-gravel roofing in 14 m sheets of slightly different age, lap seams, puddles
      float big = pa_fbm(vWPos * 0.03);
      float gravel = pa_noiseAA(vWPos * 1.9, pxw * 1.9);
      float gravel2 = pa_noiseAA(vWPos * 4.3 + 2.0, pxw * 4.3);
      float sheet = mix(pa_hash(vec3(floor(vWPos.xz / 14.0), 2.0)), 0.5, smoothstep(0.1, 0.3, pxw / 14.0));
      float seam = pa_grid(vWPos.xz, 14.0, 0.25);
      float puddle = smoothstep(0.66, 0.74, pa_fbm(vWPos * 0.045 + 9.0));
      diffuseColor.rgb *= 0.75 + 0.35 * big;
      diffuseColor.rgb *= 0.85 + 0.2 * sheet;
      diffuseColor.rgb *= 0.8 + 0.15 * gravel + 0.15 * gravel2;
      diffuseColor.rgb *= 1.0 - seam * 0.3;
      diffuseColor.rgb *= 1.0 - puddle * 0.45;
      detail = gravel - puddle * 1.5;`;
    case 'fabric': return `
      diffuseColor.rgb *= 0.85 + 0.2 * pa_noiseAA(vWPos * 2.7, pxw * 2.7);
      diffuseColor.rgb *= 0.85 + 0.3 * pa_fbm(vWPos * 0.09);
      detail = 0.7;`;
    case 'metal': return `
      float gx = pa_grid(vWPos.zy, ${panel}, 0.06), gy = pa_grid(vWPos.xz, ${panel}, 0.06), gz = pa_grid(vWPos.xy, ${panel}, 0.06);
      float lines = gx * tw.x + gy * tw.y + gz * tw.z;
      // leave out the face's own axis: a wall lying exactly on a panel boundary would pick a cell per pixel
      vec3 cell = floor(vWPos * (1.0 - dom) / ${panel});
      float tint = mix(pa_hash(cell + vec3(3.0)), 0.5, smoothstep(0.1, 0.3, pxw / ${panel}));
      diffuseColor.rgb *= 0.86 + 0.22 * tint;
      float grime = pa_fbm(vWPos * 0.08) * 0.6 + pa_noiseAA(vWPos * 1.7, pxw * 1.7) * 0.4;
      diffuseColor.rgb *= 1.0 - lines * 0.5;
      diffuseColor.rgb *= 0.75 + 0.35 * grime;
      detail = grime;`;
  }
}

/** Triplanar material for arena geometry (no UVs); world-space unless `objectSpace`. */
export function arenaMaterial(o: ArenaMatOpts): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: o.name, color: o.color, metalness: o.metal ?? (o.surface === 'rock' ? 0.05 : 0.55), roughness: o.rough ?? (o.surface === 'rock' ? 0.92 : 0.6),
    emissive: o.emissive ?? 0x000000, emissiveIntensity: o.emissiveIntensity ?? 1,
  });
  const panel = (o.panel ?? 3).toFixed(2);
  const space = o.objectSpace
    ? 'vWPos = position;\nvWNormal = normalize(normal);'
    : 'vWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * normal);';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${space}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 an = abs(vWNormal); vec3 tw = an / (an.x + an.y + an.z);
        vec3 dom = step(vec3(max(max(an.x, an.y), an.z)), an);
        vec2 puv = dom.x > 0.5 ? vWPos.zy : dom.y > 0.5 ? vWPos.xz : vWPos.xy;
        vec3 fwp = fwidth(vWPos);
        float pxw = max(max(fwp.x, fwp.y), fwp.z);
        float detail = 0.0;
        ${surfaceGlsl(o, panel)}
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (detail - 0.5) * 0.3, 0.05, 1.0);
      `);
  };
  mat.customProgramCacheKey = () => `arena-${o.surface}-${panel}${o.objectSpace ? '-obj' : ''}${o.stains ? '-stains' : ''}`;
  return mat;
}

/** The rooftop's black box: stars painted on its real walls (so you can see them coming), and a faint grid up close. */
export function skyBoxMaterial(floorY: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'sky-box',
    uniforms: { uFloorY: { value: floorY } },
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFloorY; varying vec3 vW; varying vec3 vN;
      ${NOISE}
      ${STARS}
      void main() {
        vec3 an = abs(vN);
        vec2 uv = an.y > 0.5 ? vW.xz : (an.x > 0.5 ? vW.zy : vW.xy);
        vec2 fw = fwidth(uv); float px = max(fw.x, fw.y);
        float s = pa_stars(uv / 9.0, px / 9.0, 0.32, 0.035) + 0.5 * pa_stars(uv / 3.6 + 41.0, px / 3.6, 0.22, 0.03);
        float h = clamp((vW.y - uFloorY) / 110.0, 0.0, 1.0);
        vec3 col = vec3(0.004, 0.006, 0.016) * (1.0 - h) * (1.0 - an.y) + vec3(0.82, 0.88, 1.0) * s;
        float near = 1.0 - smoothstep(18.0, 70.0, length(cameraPosition - vW));
        col += vec3(0.18, 0.34, 0.75) * pa_grid(uv, 10.0, 0.15) * near * 0.4;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/** Window glass onto the night sky: stars by view direction (infinitely far), black below the horizon. */
export function skyWindowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'sky-window',
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW;
      ${NOISE}
      ${STARS}
      void main() {
        vec3 dir = normalize(vW - cameraPosition);
        vec3 ad = abs(dir);
        vec2 uv; float face;
        if (ad.x >= ad.y && ad.x >= ad.z) { uv = dir.zy / ad.x; face = dir.x > 0.0 ? 0.0 : 1.0; }
        else if (ad.y >= ad.z) { uv = dir.xz / ad.y; face = dir.y > 0.0 ? 2.0 : 3.0; }
        else { uv = dir.xy / ad.z; face = dir.z > 0.0 ? 4.0 : 5.0; }
        vec2 q = uv * 40.0 + face * 97.0;
        vec2 fw = fwidth(q); float px = max(fw.x, fw.y);
        float s = pa_stars(q, px, 0.3, 0.05) + 0.5 * pa_stars(q * 2.6 + 13.0, px * 2.6, 0.2, 0.05);
        float sky = smoothstep(-0.03, 0.04, dir.y);
        vec3 col = vec3(0.006, 0.009, 0.022) * (1.0 - smoothstep(0.0, 0.35, abs(dir.y))) + vec3(0.82, 0.88, 1.0) * s * sky;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

export function glowMaterial(color: number, intensity: number, name = 'glow'): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ name, color: new THREE.Color(color).multiplyScalar(intensity) });
}

type SurfaceSpec = { color: number; surface: ArenaSurface; panel: number; metal: number; rough: number; stains?: boolean };
const THEME_COLORS: Record<Theme, SurfaceSpec> = {
  refinery: { color: 0x5c626a, surface: 'metal', panel: 4, metal: 0.6, rough: 0.55 },
  industrial: { color: 0x4a4b50, surface: 'metal', panel: 3, metal: 0.65, rough: 0.6 },
  hangar: { color: 0x7e868f, surface: 'metal', panel: 5, metal: 0.5, rough: 0.45 },
  reactor: { color: 0x4a5752, surface: 'metal', panel: 2.5, metal: 0.7, rough: 0.5 },
  rock: { color: 0x494c52, surface: 'rock', panel: 3, metal: 0.05, rough: 0.92 },
  machinery: { color: 0x51565a, surface: 'metal', panel: 3.5, metal: 0.6, rough: 0.65 },
  tunnel: { color: 0x4c5158, surface: 'metal', panel: 2, metal: 0.55, rough: 0.6 },
  sewer: { color: 0x37403a, surface: 'metal', panel: 1.8, metal: 0.4, rough: 0.8 },
  office: { color: 0x6c7075, surface: 'plaster', panel: 4, metal: 0, rough: 0.85 },
  garage: { color: 0x66686b, surface: 'concrete', panel: 6, metal: 0.02, rough: 0.9 },
  roof: { color: 0x45474b, surface: 'membrane', panel: 4, metal: 0.02, rough: 0.9 },
  shaft: { color: 0x5c5f63, surface: 'concrete', panel: 4, metal: 0.02, rough: 0.88 },
};

export type WallPart = 'wall' | 'floor' | 'ceiling';
/** Where a theme's floor or ceiling differs from its walls; 'sky' is the rooftop's starry box. */
const THEME_PARTS: Partial<Record<Theme, Partial<Record<WallPart, SurfaceSpec | 'sky'>>>> = {
  refinery: { floor: THEME_COLORS.rock, ceiling: THEME_COLORS.rock },
  office: {
    floor: { color: 0x3a414d, surface: 'carpet', panel: 4, metal: 0, rough: 0.95 },
    ceiling: { color: 0x74777a, surface: 'tiles', panel: 6, metal: 0, rough: 0.9 },
  },
  garage: { floor: { color: 0x58595c, surface: 'concrete', panel: 6, metal: 0.02, rough: 0.85, stains: true } },
  roof: { wall: 'sky', ceiling: 'sky' },
};

export class ArenaMaterials {
  private cache = new Map<string, THREE.Material>();

  private get<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.cache.get(key) as T | undefined;
    if (!m) { m = make(); this.cache.set(key, m); }
    return m;
  }

  /** `floorY` sets where the sky box's horizon haze starts. */
  wall(theme: Theme, part: WallPart, floorY = 0): THREE.Material {
    const spec = THEME_PARTS[theme]?.[part] ?? THEME_COLORS[theme];
    if (spec === 'sky') return this.get(`sky-box-${floorY}`, () => skyBoxMaterial(floorY));
    const key = `wall-${spec.surface}-${spec.color.toString(16)}-${spec.panel}${spec.stains ? '-s' : ''}`;
    return this.get(key, () => arenaMaterial({ name: key, ...spec }));
  }

  prop(m: PropMaterial, emissive?: number, moving = false, color?: number): THREE.Material {
    const sp = moving ? '-obj' : '';
    switch (m) {
      case 'metal': return this.get(`p-metal${sp}`, () => arenaMaterial({ name: 'p-metal', color: 0x6b7179, surface: 'metal', panel: 2, metal: 0.7, rough: 0.45, objectSpace: moving }));
      case 'darkMetal': return this.get(`p-dark${sp}`, () => arenaMaterial({ name: 'p-dark', color: 0x2e3238, surface: 'metal', panel: 1.5, metal: 0.75, rough: 0.5, objectSpace: moving }));
      case 'rock': return this.get(`p-rock${sp}`, () => arenaMaterial({ name: 'p-rock', color: 0x4d5056, surface: 'rock', objectSpace: moving }));
      case 'hazard': return this.get(`p-hazard${sp}`, () => arenaMaterial({
        name: 'p-hazard', color: 0xc8ff3a, surface: 'hazard', metal: 0.2, rough: 0.6, emissive: 0xc8ff3a, emissiveIntensity: 0.25, objectSpace: moving,
      }));
      case 'crystal': return this.get(`p-crystal-${emissive ?? 0x9a6bff}`, () => new THREE.MeshStandardMaterial({
        name: 'p-crystal', color: emissive ?? 0x9a6bff, metalness: 0.1, roughness: 0.15, emissive: emissive ?? 0x9a6bff, emissiveIntensity: 2.2,
        flatShading: true,
      }));
      case 'emissive': return this.get(`p-emissive-${emissive ?? 0xffffff}`, () => glowMaterial(emissive ?? 0xffffff, 2.5, 'p-emissive'));
      case 'concrete': return this.get(`p-concrete${sp}`, () => arenaMaterial({ name: 'p-concrete', color: 0x75777a, surface: 'concrete', panel: 6, metal: 0.02, rough: 0.9, objectSpace: moving }));
      case 'plaster': return this.get(`p-plaster${sp}`, () => arenaMaterial({ name: 'p-plaster', color: 0x74787c, surface: 'plaster', metal: 0, rough: 0.85, objectSpace: moving }));
      case 'fabric': {
        const c = color ?? 0x4f5a66;
        return this.get(`p-fabric-${c}${sp}`, () => arenaMaterial({ name: 'p-fabric', color: c, surface: 'fabric', metal: 0, rough: 0.95, objectSpace: moving }));
      }
      case 'paint': {
        // a touch of self-light keeps floor markings readable in the dark
        const c = color ?? 0xd0d4da;
        return this.get(`p-paint-${c}`, () => new THREE.MeshStandardMaterial({
          name: 'p-paint', color: c, metalness: 0.1, roughness: 0.6, emissive: c, emissiveIntensity: 0.06,
        }));
      }
      case 'sky': return this.get('p-sky', () => skyWindowMaterial());
    }
  }

  glow(color: number, intensity: number): THREE.MeshBasicMaterial {
    return this.get(`glow-${color}-${intensity}`, () => glowMaterial(color, intensity));
  }

  dispose(): void { for (const m of this.cache.values()) m.dispose(); this.cache.clear(); }
}

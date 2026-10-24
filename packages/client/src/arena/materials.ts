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
float pa_grid(vec2 uv, float cell, float w) {
  vec2 f = fract(uv / cell) * cell; vec2 d = min(f, cell - f);
  return 1.0 - smoothstep(w * 0.5, w, min(d.x, d.y));
}
`;

export type ArenaSurface = 'metal' | 'rock' | 'hazard';

export interface ArenaMatOpts { name: string; color: number; surface: ArenaSurface; metal?: number; rough?: number; panel?: number; emissive?: number; emissiveIntensity?: number }

/** World-space triplanar material for static arena geometry (no UVs). */
export function arenaMaterial(o: ArenaMatOpts): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: o.name, color: o.color, metalness: o.metal ?? (o.surface === 'rock' ? 0.05 : 0.55), roughness: o.rough ?? (o.surface === 'rock' ? 0.92 : 0.6),
    emissive: o.emissive ?? 0x000000, emissiveIntensity: o.emissiveIntensity ?? 1,
  });
  const panel = (o.panel ?? 3).toFixed(2);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * normal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 an = abs(vWNormal); vec3 tw = an / (an.x + an.y + an.z);
        float detail = 0.0;
        ${o.surface === 'rock' ? `
          float n1 = pa_fbm(vWPos * 0.12);
          float n2 = pa_fbm(vWPos * 0.9 + 7.0);
          diffuseColor.rgb *= 0.6 + 0.6 * n1;
          diffuseColor.rgb *= 0.85 + 0.3 * n2;
          float strata = 0.5 + 0.5 * sin(vWPos.y * 0.7 + n1 * 6.0);
          diffuseColor.rgb *= 0.9 + 0.12 * strata;
          detail = n2;
        ` : o.surface === 'hazard' ? `
          float s = step(0.5, fract((vWPos.x + vWPos.y + vWPos.z) * 0.25));
          diffuseColor.rgb = mix(vec3(0.02), diffuseColor.rgb, s);
        ` : `
          float gx = pa_grid(vWPos.zy, ${panel}, 0.06), gy = pa_grid(vWPos.xz, ${panel}, 0.06), gz = pa_grid(vWPos.xy, ${panel}, 0.06);
          float lines = gx * tw.x + gy * tw.y + gz * tw.z;
          vec3 cell = floor(vWPos / ${panel});
          float tint = pa_hash(cell + vec3(3.0));
          diffuseColor.rgb *= 0.86 + 0.22 * tint;
          float grime = pa_fbm(vWPos * 0.08) * 0.6 + pa_noise(vWPos * 1.7) * 0.4;
          diffuseColor.rgb *= 1.0 - lines * 0.5;
          diffuseColor.rgb *= 0.75 + 0.35 * grime;
          detail = grime;
        `}
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (detail - 0.5) * 0.3, 0.05, 1.0);
      `);
  };
  mat.customProgramCacheKey = () => `arena-${o.surface}-${panel}`;
  return mat;
}

export function glowMaterial(color: number, intensity: number, name = 'glow'): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ name, color: new THREE.Color(color).multiplyScalar(intensity) });
}

const THEME_COLORS: Record<Theme, { color: number; surface: ArenaSurface; panel: number; metal: number; rough: number }> = {
  refinery: { color: 0x5c626a, surface: 'metal', panel: 4, metal: 0.6, rough: 0.55 },
  industrial: { color: 0x4a4b50, surface: 'metal', panel: 3, metal: 0.65, rough: 0.6 },
  hangar: { color: 0x7e868f, surface: 'metal', panel: 5, metal: 0.5, rough: 0.45 },
  reactor: { color: 0x4a5752, surface: 'metal', panel: 2.5, metal: 0.7, rough: 0.5 },
  rock: { color: 0x494c52, surface: 'rock', panel: 3, metal: 0.05, rough: 0.92 },
  machinery: { color: 0x51565a, surface: 'metal', panel: 3.5, metal: 0.6, rough: 0.65 },
  tunnel: { color: 0x4c5158, surface: 'metal', panel: 2, metal: 0.55, rough: 0.6 },
  sewer: { color: 0x37403a, surface: 'metal', panel: 1.8, metal: 0.4, rough: 0.8 },
};

export class ArenaMaterials {
  private cache = new Map<string, THREE.Material>();

  private get<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.cache.get(key) as T | undefined;
    if (!m) { m = make(); this.cache.set(key, m); }
    return m;
  }

  wall(theme: Theme, floorOrCeiling: boolean): THREE.Material {
    // the hub mixes refinery metal walls with rock floor/ceiling
    const t = theme === 'refinery' && floorOrCeiling ? 'rock' : theme;
    const c = THEME_COLORS[t];
    return this.get(`wall-${t}`, () => arenaMaterial({ name: `wall-${t}`, ...c }));
  }

  prop(m: PropMaterial, emissive?: number): THREE.Material {
    switch (m) {
      case 'metal': return this.get('p-metal', () => arenaMaterial({ name: 'p-metal', color: 0x6b7179, surface: 'metal', panel: 2, metal: 0.7, rough: 0.45 }));
      case 'darkMetal': return this.get('p-dark', () => arenaMaterial({ name: 'p-dark', color: 0x2e3238, surface: 'metal', panel: 1.5, metal: 0.75, rough: 0.5 }));
      case 'rock': return this.get('p-rock', () => arenaMaterial({ name: 'p-rock', color: 0x4d5056, surface: 'rock' }));
      case 'hazard': return this.get('p-hazard', () => arenaMaterial({ name: 'p-hazard', color: 0xc8ff3a, surface: 'hazard', metal: 0.2, rough: 0.6, emissive: 0xc8ff3a, emissiveIntensity: 0.25 }));
      case 'crystal': return this.get(`p-crystal-${emissive ?? 0x9a6bff}`, () => new THREE.MeshStandardMaterial({
        name: 'p-crystal', color: emissive ?? 0x9a6bff, metalness: 0.1, roughness: 0.15, emissive: emissive ?? 0x9a6bff, emissiveIntensity: 2.2,
        flatShading: true,
      }));
      case 'emissive': return this.get(`p-emissive-${emissive ?? 0xffffff}`, () => glowMaterial(emissive ?? 0xffffff, 2.5, 'p-emissive'));
    }
  }

  glow(color: number, intensity: number): THREE.MeshBasicMaterial {
    return this.get(`glow-${color}-${intensity}`, () => glowMaterial(color, intensity));
  }

  dispose(): void { for (const m of this.cache.values()) m.dispose(); this.cache.clear(); }
}

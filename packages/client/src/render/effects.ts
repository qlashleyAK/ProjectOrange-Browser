import * as THREE from 'three';
import { settings } from '../settings';

const TELL_MIN_DURATION = 0.12;
const WHITE = new THREE.Color(1, 1, 1);

function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Billowy smoke puff: tileable value-noise fbm under a soft round mask, so the edge breaks up into wisps instead
 * of reading as a disc. Alpha only; color and shading come from the shader.
 */
function smokeTexture(): THREE.CanvasTexture {
  const N = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const G = 16;
  const lattice = new Float32Array(G * G).map(() => Math.random());
  const val = (x: number, y: number, f: number) => {
    const gx = (x * f) % G, gy = (y * f) % G;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (i: number, j: number) => lattice[((j % G) * G + (i % G))]!;
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const n = val(u, v, 4) * 0.5 + val(u, v, 8) * 0.3 + val(u, v, 16) * 0.2;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      const mask = Math.max(0, 1 - r * (0.75 + 0.6 * n));
      const a = Math.min(1, Math.pow(mask, 1.4) * (0.55 + 0.9 * n));
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FX_NOISE = /* glsl */ `
float fx_hash(vec3 p) { p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float fx_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fx_hash(i), fx_hash(i + vec3(1,0,0)), f.x), mix(fx_hash(i + vec3(0,1,0)), fx_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(fx_hash(i + vec3(0,0,1)), fx_hash(i + vec3(1,0,1)), f.x), mix(fx_hash(i + vec3(0,1,1)), fx_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fx_fbm(vec3 p) { return fx_noise(p) * 0.5 + fx_noise(p * 2.03) * 0.3 + fx_noise(p * 4.1) * 0.2; }
`;

/**
 * Plasma fireball: a noise-displaced sphere that burns white at its heart, through the core color, to the edge
 * color, then breaks up and cools as `uLife` runs 0 → 1. Colors stay off the reserved orange band.
 */
function fireballMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uLife: { value: 0 }, uSeed: { value: 0 }, uAlpha: { value: 1 },
      uCore: { value: new THREE.Color() }, uEdge: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      uniform float uLife; uniform float uSeed;
      varying vec3 vN; varying vec3 vV; varying vec3 vO;
      ${FX_NOISE}
      void main() {
        vec3 p = position;
        float n = fx_fbm(p * 1.6 + uSeed + vec3(0.0, -uLife * 2.0, 0.0));
        // lumpy at first, smoothing as it swells and burns out
        p *= 1.0 + (n - 0.5) * mix(0.75, 0.35, uLife);
        vO = p;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal); vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uLife; uniform float uSeed; uniform float uAlpha; uniform vec3 uCore; uniform vec3 uEdge;
      varying vec3 vN; varying vec3 vV; varying vec3 vO;
      ${FX_NOISE}
      void main() {
        float facing = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        float n = fx_fbm(vO * 2.6 + uSeed * 1.7 + vec3(0.0, -uLife * 3.0, 0.0));
        float heat = facing * 0.75 + n * 0.55 - uLife * 1.05;
        // the cooling shell tears open where the noise is low
        float keep = smoothstep(uLife * 0.95 - 0.1, uLife * 0.95 + 0.12, n * 0.85 + facing * 0.3);
        vec3 col = mix(uEdge * 0.55, uCore, smoothstep(0.05, 0.65, heat));
        col = mix(col, vec3(1.0), smoothstep(0.7, 1.05, heat));
        float a = keep * uAlpha * (0.25 + 0.75 * facing) * (1.0 - uLife * uLife);
        gl_FragColor = vec4(col * a * 2.6, a);
      }`,
  });
}

export interface EffectOpts { tell?: boolean; intensity?: number }

interface Timed { t: number; dur: number }
interface SpriteFx extends Timed { obj: THREE.Sprite; r0: number; r1: number; color: THREE.Color; intensity: number; follow?: THREE.Object3D }
interface MeshFx extends Timed { obj: THREE.Mesh; r0: number; r1: number; color: THREE.Color; opacity: number; faceCamera: boolean }
interface ShieldFx extends Timed { obj: THREE.Mesh; follow: () => THREE.Vector3 | null; intensity: number }
interface FireballFx extends Timed { obj: THREE.Mesh; r0: number; r1: number; intensity: number; delay: number }
interface Particle {
  pos: THREE.Vector3; vel: THREE.Vector3; life: number; max: number; size: number; color: THREE.Color; spin: THREE.Vector3; rot: THREE.Euler; drag: number; grow: number;
  /** downward pull, m/s² */
  gravity?: number;
  /** 0..1 glow at birth (debris: white-hot metal; smoke: lit by the blast inside it) */
  heat?: number;
  /** seconds to the next smoke puff a burning piece of debris leaves behind */
  trailT?: number;
}

/** sparks and debris fall a little: the arenas have a floor, and arcs read as physical where straight lines read as lasers */
const SPARK_GRAVITY = 9;
const DEBRIS_GRAVITY = 5;
const HOT = new THREE.Color(0.55, 0.8, 1.0);
const DUST_COUNT = 420;
const DUST_BOX = 44;
export interface LightRequest { pos: THREE.Vector3; color: THREE.Color; intensity: number; t: number; dur: number; range: number }

export class Effects {
  readonly group = new THREE.Group();
  private sprites: SpriteFx[] = [];
  private spritePool: THREE.Sprite[] = [];
  private meshes: MeshFx[] = [];
  private spherePool: THREE.Mesh[] = [];
  private ringPool: THREE.Mesh[] = [];
  private shields: ShieldFx[] = [];
  private shieldPool: THREE.Mesh[] = [];
  private flashTex = radialTexture();
  private sphereGeo = new THREE.SphereGeometry(1, 24, 16);
  private ringGeo = new THREE.RingGeometry(0.86, 1, 64);
  private shieldMat: THREE.ShaderMaterial;
  private fireballs: FireballFx[] = [];
  private fireballPool: THREE.Mesh[] = [];
  private fireballGeo = new THREE.IcosahedronGeometry(1, 4);
  private debrisHeat: THREE.InstancedBufferAttribute;
  private smokeHeat: THREE.InstancedBufferAttribute;
  private dust: THREE.Points;
  private dustMat: THREE.ShaderMaterial;
  private time = 0;
  /** quality multiplier on spark and debris counts */
  private budget = 1;

  private sparks: Particle[] = [];
  private sparkMesh: THREE.InstancedMesh;
  private debris: Particle[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private smoke: Particle[] = [];
  private smokeMesh: THREE.InstancedMesh;
  private smokeAlpha: THREE.InstancedBufferAttribute;
  private motes: Particle[] = [];
  private moteMesh: THREE.InstancedMesh;
  private moteAlpha: THREE.InstancedBufferAttribute;
  readonly lightRequests: LightRequest[] = [];
  maxSparks = 600;
  maxDebris = 240;
  maxSmoke = 300;
  maxMotes = 700;
  debrisEnabled = true;

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private zAxis = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const sparkGeo = new THREE.BoxGeometry(0.07, 0.07, 1);
    this.sparkMesh = new THREE.InstancedMesh(sparkGeo, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), 600);
    this.sparkMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(600 * 3), 3);
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.count = 0;
    this.group.add(this.sparkMesh);

    const debGeo = new THREE.DodecahedronGeometry(0.5, 0);
    this.debrisHeat = new THREE.InstancedBufferAttribute(new Float32Array(240), 1);
    debGeo.setAttribute('aHeat', this.debrisHeat);
    const debMat = new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.5, flatShading: true });
    // freshly torn plating glows white-blue and cools to bare metal
    debMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aHeat;\nvarying float vHeat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = aHeat;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHeat;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += mix(vec3(0.3, 0.55, 1.0), vec3(1.0), vHeat * vHeat) * vHeat * vHeat * 7.0;`);
    };
    debMat.customProgramCacheKey = () => 'fx-debris-heat';
    this.debrisMesh = new THREE.InstancedMesh(debGeo, debMat, 240);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(240 * 3), 3);
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.count = 0;
    this.group.add(this.debrisMesh);

    const smokeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: smokeTexture() }, uHot: { value: HOT.clone().multiplyScalar(3) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha; attribute float aHeat; varying vec3 vC; varying float vA; varying float vH; varying vec2 vUv; varying float vUp;
        void main() {
          vUv = uv; vC = instanceColor; vA = aAlpha; vH = aHeat;
          vec4 w = instanceMatrix * vec4(position, 1.0);
          // the puff is rolled, so light it by which way this corner faces in the world, not by its uv
          vUp = normalize(mat3(instanceMatrix) * vec3(position.xy, 0.0) + vec3(0.0, 1e-4, 0.0)).y;
          gl_Position = projectionMatrix * modelViewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform vec3 uHot; varying vec3 vC; varying float vA; varying float vH; varying vec2 vUv; varying float vUp;
        void main() {
          float t = texture2D(map, vUv).a;
          float a = t * vA;
          if (a < 0.005) discard;
          // lit from above, self-shadowed below; the dense middle of a hot puff glows
          vec3 col = vC * (0.85 + 0.3 * vUp) + uHot * vH * t * t;
          gl_FragColor = vec4(col, a);
        }`,
    });
    const smokeGeo = new THREE.PlaneGeometry(1, 1);
    this.smokeAlpha = new THREE.InstancedBufferAttribute(new Float32Array(300), 1);
    smokeGeo.setAttribute('aAlpha', this.smokeAlpha);
    this.smokeHeat = new THREE.InstancedBufferAttribute(new Float32Array(300), 1);
    smokeGeo.setAttribute('aHeat', this.smokeHeat);

    this.smokeMesh = new THREE.InstancedMesh(smokeGeo, smokeMat, 300);
    this.smokeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(300 * 3), 3);
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.count = 0;
    this.group.add(this.smokeMesh);

    const moteMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { map: { value: this.flashTex } },
      vertexShader: /* glsl */ `
        attribute float aAlpha; varying vec3 vC; varying float vA; varying vec2 vUv;
        void main() { vUv = uv; vC = instanceColor; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; varying vec3 vC; varying float vA; varying vec2 vUv;
        void main() { float a = texture2D(map, vUv).a * vA; if (a < 0.004) discard; gl_FragColor = vec4(vC * a, a); }`,
    });
    const moteGeo = new THREE.PlaneGeometry(1, 1);
    this.moteAlpha = new THREE.InstancedBufferAttribute(new Float32Array(this.maxMotes), 1);
    moteGeo.setAttribute('aAlpha', this.moteAlpha);
    this.moteMesh = new THREE.InstancedMesh(moteGeo, moteMat, this.maxMotes);
    this.moteMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxMotes * 3), 3);
    this.moteMesh.frustumCulled = false;
    this.moteMesh.count = 0;
    this.group.add(this.moteMesh);

    this.shieldMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uImpact: { value: new THREE.Vector3(0, 0, 1) }, uAmount: { value: 1 }, uColor: { value: new THREE.Color(0.45, 0.8, 1.0) } },
      vertexShader: /* glsl */ `
        varying vec3 vP; varying vec3 vN; varying vec3 vV;
        void main() { vP = normalize(position); vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uImpact; uniform float uAmount; uniform vec3 uColor;
        varying vec3 vP; varying vec3 vN; varying vec3 vV;
        float hex(vec2 p) {
          p *= vec2(1.0, 1.1547); p.x += mod(floor(p.y), 2.0) * 0.5;
          vec2 f = abs(fract(p) - 0.5);
          return smoothstep(0.38, 0.48, max(f.x * 1.5 + f.y, f.y * 2.0) * 0.5 + 0.25);
        }
        void main() {
          float d = dot(vP, normalize(uImpact));
          float spot = smoothstep(0.2, 1.0, d);
          float rim = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.0);
          vec2 uv = vec2(atan(vP.z, vP.x) * 4.0, vP.y * 6.0);
          float h = hex(uv);
          float a = (spot * (0.6 + h * 0.8) + rim * 0.25) * uAmount;
          gl_FragColor = vec4(uColor * a * 2.0, a);
        }`,
    });

    // Ambient dust: a fixed cloud of points in a box that wraps around the camera, so it costs one draw and
    // never needs respawning. Specks drift slowly and fade at the box edge and right in front of the lens.
    const dustPos = new Float32Array(DUST_COUNT * 3);
    const dustSeed = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i++) {
      dustPos[i * 3] = Math.random() * DUST_BOX; dustPos[i * 3 + 1] = Math.random() * DUST_BOX; dustPos[i * 3 + 2] = Math.random() * DUST_BOX;
      dustSeed[i] = Math.random();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1));
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uScale: { value: 400 } },
      vertexShader: /* glsl */ `
        uniform vec3 uCam; uniform float uTime; uniform float uScale;
        attribute float aSeed; varying float vA;
        void main() {
          const float B = ${DUST_BOX.toFixed(1)};
          vec3 drift = vec3(sin(uTime * 0.11 + aSeed * 40.0), sin(uTime * 0.07 + aSeed * 23.0) * 0.6 - 0.25 * uTime * (0.3 + aSeed), cos(uTime * 0.09 + aSeed * 31.0));
          vec3 p = position + drift;
          vec3 w = uCam + mod(p - uCam, B) - B * 0.5;
          vec4 mv = viewMatrix * vec4(w, 1.0);
          float d = -mv.z;
          vA = smoothstep(B * 0.5, B * 0.3, length(w - uCam)) * smoothstep(0.8, 3.0, d) * (0.35 + 0.65 * aSeed);
          gl_PointSize = uScale * (0.025 + 0.03 * aSeed) / max(d, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.2, 1.0, r)) * vA * 0.28;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * a, a);
        }`,
    });
    this.dust = new THREE.Points(dustGeo, this.dustMat);
    this.dust.frustumCulled = false;
    this.dust.visible = false;
    this.group.add(this.dust);
  }

  /** Ambient dust around the camera (default and high quality). */
  setDust(on: boolean): void { this.dust.visible = on; }

  /** Quality multiplier on spark and debris counts. */
  setBudget(k: number): void { this.budget = k; }

  private scaleDur(dur: number, o?: EffectOpts): number {
    let d = settings.reduceFlashing ? dur * 1.3 : dur;
    if (o?.tell) d = Math.max(d, TELL_MIN_DURATION);
    return d;
  }
  private scaleIntensity(i: number, o?: EffectOpts): number {
    let v = settings.reduceFlashing ? i * 0.45 : i;
    if (o?.tell) v = Math.max(v, 0.35);
    return v;
  }

  /** Additive billboard flash; optionally requests a pooled dynamic light. */
  flash(pos: THREE.Vector3, color: THREE.ColorRepresentation, r0: number, r1: number, dur: number, o?: EffectOpts & { light?: number; follow?: THREE.Object3D }): void {
    const sp = this.spritePool.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.position.copy(pos);
    sp.visible = true;
    this.group.add(sp);
    const c = new THREE.Color(color);
    const intensity = this.scaleIntensity(o?.intensity ?? 1, o);
    const d = this.scaleDur(dur, o);
    this.sprites.push({ obj: sp, r0, r1, color: c, intensity, t: 0, dur: d, follow: o?.follow });
    if (o?.light) this.light(pos, c, o.light * intensity, d * 1.5, Math.max(r1 * 10, 20));
  }

  light(pos: THREE.Vector3, color: THREE.Color, intensity: number, dur: number, range: number): void {
    this.lightRequests.push({ pos: pos.clone(), color: color.clone(), intensity, t: 0, dur, range });
    if (this.lightRequests.length > 32) this.lightRequests.shift();
  }

  /** Expanding additive sphere (fireball, splash, sweep front). */
  sphere(pos: THREE.Vector3, color: THREE.ColorRepresentation, r0: number, r1: number, dur: number, opacity = 0.8, o?: EffectOpts): void {
    const m = this.spherePool.pop() ?? new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.position.copy(pos);
    m.visible = true;
    this.group.add(m);
    this.meshes.push({ obj: m, r0, r1, color: new THREE.Color(color), opacity: this.scaleIntensity(opacity, o), t: 0, dur: this.scaleDur(dur, o), faceCamera: false });
  }

  /**
   * Plasma fireball swelling from r0 to r1 over `dur`, white at the heart through `core` to `edge`.
   * `delay` holds it back, so one blast can be built from a few staggered bursts.
   */
  fireball(pos: THREE.Vector3, core: THREE.ColorRepresentation, edge: THREE.ColorRepresentation, r0: number, r1: number, dur: number, o?: EffectOpts & { delay?: number }): void {
    const m = this.fireballPool.pop() ?? new THREE.Mesh(this.fireballGeo, fireballMaterial());
    const u = (m.material as THREE.ShaderMaterial).uniforms;
    (u.uCore!.value as THREE.Color).set(core);
    (u.uEdge!.value as THREE.Color).set(edge);
    u.uSeed!.value = Math.random() * 100;
    u.uLife!.value = 0;
    m.position.copy(pos);
    m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, 0);
    m.scale.setScalar(r0);
    const delay = o?.delay ?? 0;
    m.visible = delay <= 0;
    this.group.add(m);
    this.fireballs.push({ obj: m, r0, r1, intensity: this.scaleIntensity(o?.intensity ?? 1, o), t: 0, dur: this.scaleDur(dur, o), delay });
  }

  /** Expanding ring; faces the camera when `normal` is null. */
  ring(pos: THREE.Vector3, normal: THREE.Vector3 | null, color: THREE.ColorRepresentation, r0: number, r1: number, dur: number, opacity = 1, o?: EffectOpts): void {
    const m = this.ringPool.pop() ?? new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.userData.ring = true;
    m.position.copy(pos);
    if (normal) m.quaternion.setFromUnitVectors(this.zAxis, this.tmp.copy(normal).normalize());
    m.visible = true;
    this.group.add(m);
    this.meshes.push({ obj: m, r0, r1, color: new THREE.Color(color), opacity: this.scaleIntensity(opacity, o), t: 0, dur: this.scaleDur(dur, o), faceCamera: !normal });
  }

  shieldHit(follow: () => THREE.Vector3 | null, radius: number, impactDir: THREE.Vector3, intensity: number): void {
    const m = this.shieldPool.pop() ?? new THREE.Mesh(this.sphereGeo, this.shieldMat.clone());
    m.scale.setScalar(radius);
    (m.material as THREE.ShaderMaterial).uniforms.uImpact!.value.copy(impactDir);
    m.visible = true;
    this.group.add(m);
    const p = follow();
    if (p) m.position.copy(p);
    this.shields.push({ obj: m, follow, intensity: this.scaleIntensity(intensity, { tell: true }), t: 0, dur: this.scaleDur(0.25, { tell: true }) });
  }

  sparksAt(pos: THREE.Vector3, dir: THREE.Vector3 | null, color: THREE.ColorRepresentation, count: number, speed: number, life = 0.35): void {
    const c = new THREE.Color(color);
    const n = Math.max(1, Math.round(count * this.budget));
    for (let i = 0; i < n; i++) {
      if (this.sparks.length >= this.maxSparks) this.sparks.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (dir) v.addScaledVector(dir, 1.2).normalize();
      v.multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      const l = life * (0.5 + Math.random() * 0.7);
      this.sparks.push({ pos: pos.clone(), vel: v, life: l, max: l, size: 0.5 + Math.random() * 0.8, color: c, spin: new THREE.Vector3(), rot: new THREE.Euler(), drag: 2.5, grow: 0, gravity: SPARK_GRAVITY });
    }
  }

  debrisAt(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.ColorRepresentation, count: number, spread: number, size = 1): void {
    if (!this.debrisEnabled) return;
    const c = new THREE.Color(color);
    const n = Math.max(1, Math.round(count * this.budget));
    for (let i = 0; i < n; i++) {
      if (this.debris.length >= this.maxDebris) this.debris.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(spread * (0.3 + Math.random()));
      v.add(vel);
      const l = 2.2 + Math.random() * 0.8;
      this.debris.push({
        pos: pos.clone().addScaledVector(v, 0.02), vel: v, life: l, max: l, size: size * (0.3 + Math.random() * 0.9), color: c,
        spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4), rot: new THREE.Euler(), drag: 0.4, grow: 0,
        gravity: DEBRIS_GRAVITY, heat: 0.55 + Math.random() * 0.45, trailT: Math.random() * 0.1,
      });
    }
  }

  /** `heat` 0..1 makes the puff glow from inside early in its life (smoke rolling off a blast). */
  smokeAt(pos: THREE.Vector3, vel: THREE.Vector3, size: number, life: number, color: THREE.ColorRepresentation = 0x707780, grow = 1.5, heat = 0): void {
    if (this.smoke.length >= this.maxSmoke) this.smoke.shift();
    this.smoke.push({
      pos: pos.clone(), vel: vel.clone(), life, max: life, size, color: new THREE.Color(color),
      spin: new THREE.Vector3(0, 0, (Math.random() - 0.5) * 1.2), rot: new THREE.Euler(0, 0, Math.random() * 6.28), drag: 1.2, grow, heat,
    });
  }

  /** Additive glowing billboard mote that drifts, shrinks and fades. */
  moteAt(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life: number, drag = 1.5): void {
    if (this.motes.length >= this.maxMotes) this.motes.shift();
    this.motes.push({ pos: pos.clone(), vel: vel.clone(), life, max: life, size, color: new THREE.Color(color), spin: new THREE.Vector3(), rot: new THREE.Euler(), drag, grow: 0 });
  }

  update(dt: number, camera: THREE.Camera): void {
    // sprites
    for (let i = this.sprites.length - 1; i >= 0; i--) {
      const f = this.sprites[i]!;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { f.obj.visible = false; this.group.remove(f.obj); this.spritePool.push(f.obj); this.sprites.splice(i, 1); continue; }
      if (f.follow) f.obj.position.copy(f.follow.getWorldPosition(this.tmp));
      const r = f.r0 + (f.r1 - f.r0) * k;
      f.obj.scale.setScalar(r * 2);
      const mat = f.obj.material as THREE.SpriteMaterial;
      mat.color.copy(f.color).multiplyScalar(3 * f.intensity);
      mat.opacity = (1 - k) * (1 - k);
    }
    // spheres & rings
    for (let i = this.meshes.length - 1; i >= 0; i--) {
      const f = this.meshes[i]!;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        f.obj.visible = false; this.group.remove(f.obj);
        (f.obj.userData.ring ? this.ringPool : this.spherePool).push(f.obj);
        this.meshes.splice(i, 1);
        continue;
      }
      const e = 1 - Math.pow(1 - k, 2.2);
      f.obj.scale.setScalar(f.r0 + (f.r1 - f.r0) * e);
      if (f.faceCamera) f.obj.quaternion.copy(camera.quaternion);
      const mat = f.obj.material as THREE.MeshBasicMaterial;
      mat.color.copy(f.color).multiplyScalar(2);
      mat.opacity = f.opacity * (1 - k);
    }
    // fireballs
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i]!;
      if (f.delay > 0) { f.delay -= dt; if (f.delay > 0) continue; f.obj.visible = true; }
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { f.obj.visible = false; this.group.remove(f.obj); this.fireballPool.push(f.obj); this.fireballs.splice(i, 1); continue; }
      // fast swell, slow settle
      const e = 1 - Math.pow(1 - k, 3);
      f.obj.scale.setScalar(f.r0 + (f.r1 - f.r0) * e);
      f.obj.rotation.y += dt * 0.6;
      const u = (f.obj.material as THREE.ShaderMaterial).uniforms;
      u.uLife!.value = k;
      u.uAlpha!.value = f.intensity * Math.min(1, f.t / 0.04);
    }
    // ambient dust
    this.time += dt;
    if (this.dust.visible) {
      this.dustMat.uniforms.uCam!.value.copy(camera.position);
      this.dustMat.uniforms.uTime!.value = this.time;
      // point size is in pixels: world size × focal length in pixels / distance
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 70;
      const px = window.innerHeight * Math.min(2, window.devicePixelRatio || 1);
      this.dustMat.uniforms.uScale!.value = px / (2 * Math.tan((fov * Math.PI) / 360));
    }
    // shield bubbles
    for (let i = this.shields.length - 1; i >= 0; i--) {
      const f = this.shields[i]!;
      f.t += dt;
      const k = f.t / f.dur;
      const p = f.follow();
      if (k >= 1 || !p) { f.obj.visible = false; this.group.remove(f.obj); this.shieldPool.push(f.obj); this.shields.splice(i, 1); continue; }
      f.obj.position.copy(p);
      (f.obj.material as THREE.ShaderMaterial).uniforms.uAmount!.value = f.intensity * (1 - k);
    }
    // lights
    for (let i = this.lightRequests.length - 1; i >= 0; i--) {
      const l = this.lightRequests[i]!;
      l.t += dt;
      if (l.t >= l.dur) this.lightRequests.splice(i, 1);
    }
    this.updateParticles(dt, camera);
  }

  private updateParticles(dt: number, camera: THREE.Camera): void {
    let n = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i]!;
      p.life -= dt;
      if (p.life <= 0) { this.sparks.splice(i, 1); continue; }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.y -= (p.gravity ?? 0) * dt;
      const k = p.life / p.max;
      const speed = p.vel.length();
      this.q.setFromUnitVectors(this.zAxis, this.tmp.copy(p.vel).divideScalar(speed || 1));
      this.s.set(k + 0.2, k + 0.2, Math.max(0.15, speed * 0.04) * p.size);
      this.m.compose(p.pos, this.q, this.s);
      this.sparkMesh.setMatrixAt(n, this.m);
      // born white-hot, cooling into their own color
      this.sparkMesh.setColorAt(n, this.tmpColor.copy(p.color).lerp(WHITE, k * k * 0.75).multiplyScalar(4 * k));
      n++;
    }
    this.sparkMesh.count = n;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;

    n = 0;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const p = this.debris[i]!;
      p.life -= dt;
      if (p.life <= 0) { this.debris.splice(i, 1); continue; }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.y -= (p.gravity ?? 0) * dt;
      p.rot.x += p.spin.x * dt; p.rot.y += p.spin.y * dt; p.rot.z += p.spin.z * dt;
      this.q.setFromEuler(p.rot);
      const fade = Math.min(1, p.life / 0.6);
      this.s.setScalar(p.size * fade);
      this.m.compose(p.pos, this.q, this.s);
      this.debrisMesh.setMatrixAt(n, this.m);
      this.debrisMesh.setColorAt(n, p.color);
      // glow cools over the first second; big burning chunks leave a thin smoke trail while they're hot
      const age = p.max - p.life;
      const heat = (p.heat ?? 0) * Math.max(0, 1 - age / 1.1);
      this.debrisHeat.setX(n, heat);
      if (heat > 0.15 && p.size > 0.5) {
        p.trailT = (p.trailT ?? 0) - dt;
        if (p.trailT <= 0) {
          p.trailT = 0.05;
          this.smokeAt(p.pos, this.tmp.copy(p.vel).multiplyScalar(0.1), 0.35 + p.size * 0.5, 0.7, 0x4a4e56, 2.2, heat * 0.6);
        }
      }
      n++;
    }
    this.debrisMesh.count = n;
    this.debrisHeat.needsUpdate = true;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;

    n = 0;
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const p = this.smoke[i]!;
      p.life -= dt;
      if (p.life <= 0) { this.smoke.splice(i, 1); continue; }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      const k = 1 - p.life / p.max;
      // billboard, rolled slowly about the view axis so overlapping puffs don't line up
      p.rot.z += p.spin.z * dt;
      this.q.copy(camera.quaternion).multiply(this.roll.setFromAxisAngle(this.zAxis, p.rot.z));
      this.s.setScalar(p.size * (1 + k * p.grow));
      this.m.compose(p.pos, this.q, this.s);
      this.smokeMesh.setMatrixAt(n, this.m);
      this.smokeMesh.setColorAt(n, p.color);
      this.smokeAlpha.setX(n, Math.sin(Math.min(1, k * 4) * Math.PI / 2) * (1 - k) * 0.85);
      this.smokeHeat.setX(n, (p.heat ?? 0) * Math.max(0, 1 - k * 3.5));
      n++;
    }
    this.smokeMesh.count = n;
    this.smokeAlpha.needsUpdate = true;
    this.smokeHeat.needsUpdate = true;
    this.smokeMesh.instanceMatrix.needsUpdate = true;
    if (this.smokeMesh.instanceColor) this.smokeMesh.instanceColor.needsUpdate = true;

    n = 0;
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const p = this.motes[i]!;
      p.life -= dt;
      if (p.life <= 0) { this.motes.splice(i, 1); continue; }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      const k = p.life / p.max;
      this.s.setScalar(p.size * (0.35 + 0.65 * k));
      this.m.compose(p.pos, camera.quaternion, this.s);
      this.moteMesh.setMatrixAt(n, this.m);
      this.moteMesh.setColorAt(n, this.tmpColor.copy(p.color).multiplyScalar(2.5));
      this.moteAlpha.setX(n, Math.min(1, (1 - k) * 8) * k);
      n++;
    }
    this.moteMesh.count = n;
    this.moteAlpha.needsUpdate = true;
    this.moteMesh.instanceMatrix.needsUpdate = true;
    if (this.moteMesh.instanceColor) this.moteMesh.instanceColor.needsUpdate = true;
  }
  private tmpColor = new THREE.Color();
  private roll = new THREE.Quaternion();

  clear(): void {
    for (const f of this.sprites) { f.obj.visible = false; this.group.remove(f.obj); this.spritePool.push(f.obj); }
    for (const f of this.meshes) { f.obj.visible = false; this.group.remove(f.obj); (f.obj.userData.ring ? this.ringPool : this.spherePool).push(f.obj); }
    for (const f of this.shields) { f.obj.visible = false; this.group.remove(f.obj); this.shieldPool.push(f.obj); }
    for (const f of this.fireballs) { f.obj.visible = false; this.group.remove(f.obj); this.fireballPool.push(f.obj); }
    this.sprites = []; this.meshes = []; this.shields = []; this.fireballs = [];
    this.sparks = []; this.debris = []; this.smoke = []; this.motes = [];
    this.lightRequests.length = 0;
  }
}

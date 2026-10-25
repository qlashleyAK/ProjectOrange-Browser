import * as THREE from 'three';
import { settings } from '../settings';

const TELL_MIN_DURATION = 0.12;

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

function smokeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < 18; i++) {
    const x = 20 + Math.random() * 24, y = 20 + Math.random() * 24, r = 8 + Math.random() * 14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface EffectOpts { tell?: boolean; intensity?: number }

interface Timed { t: number; dur: number }
interface SpriteFx extends Timed { obj: THREE.Sprite; r0: number; r1: number; color: THREE.Color; intensity: number; follow?: THREE.Object3D }
interface MeshFx extends Timed { obj: THREE.Mesh; r0: number; r1: number; color: THREE.Color; opacity: number; faceCamera: boolean }
interface ShieldFx extends Timed { obj: THREE.Mesh; follow: () => THREE.Vector3 | null; intensity: number }
interface Particle { pos: THREE.Vector3; vel: THREE.Vector3; life: number; max: number; size: number; color: THREE.Color; spin: THREE.Vector3; rot: THREE.Euler; drag: number; grow: number }
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
    this.debrisMesh = new THREE.InstancedMesh(debGeo, new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.5, flatShading: true }), 240);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(240 * 3), 3);
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.count = 0;
    this.group.add(this.debrisMesh);

    const smokeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: smokeTexture() } },
      vertexShader: /* glsl */ `
        attribute float aAlpha; varying vec3 vC; varying float vA; varying vec2 vUv;
        void main() { vUv = uv; vC = instanceColor; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; varying vec3 vC; varying float vA; varying vec2 vUv;
        void main() { float a = texture2D(map, vUv).a * vA; if (a < 0.005) discard; gl_FragColor = vec4(vC, a); }`,
    });
    const smokeGeo = new THREE.PlaneGeometry(1, 1);
    this.smokeAlpha = new THREE.InstancedBufferAttribute(new Float32Array(300), 1);
    smokeGeo.setAttribute('aAlpha', this.smokeAlpha);
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
  }

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
    for (let i = 0; i < count; i++) {
      if (this.sparks.length >= this.maxSparks) this.sparks.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (dir) v.addScaledVector(dir, 1.2).normalize();
      v.multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      const l = life * (0.5 + Math.random() * 0.7);
      this.sparks.push({ pos: pos.clone(), vel: v, life: l, max: l, size: 0.5 + Math.random() * 0.8, color: c, spin: new THREE.Vector3(), rot: new THREE.Euler(), drag: 2.5, grow: 0 });
    }
  }

  debrisAt(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.ColorRepresentation, count: number, spread: number, size = 1): void {
    if (!this.debrisEnabled) return;
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      if (this.debris.length >= this.maxDebris) this.debris.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(spread * (0.3 + Math.random()));
      v.add(vel);
      const l = 2.2 + Math.random() * 0.8;
      this.debris.push({
        pos: pos.clone().addScaledVector(v, 0.02), vel: v, life: l, max: l, size: size * (0.3 + Math.random() * 0.9), color: c,
        spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4), rot: new THREE.Euler(), drag: 0.4, grow: 0,
      });
    }
  }

  smokeAt(pos: THREE.Vector3, vel: THREE.Vector3, size: number, life: number, color: THREE.ColorRepresentation = 0x707780, grow = 1.5): void {
    if (this.smoke.length >= this.maxSmoke) this.smoke.shift();
    this.smoke.push({ pos: pos.clone(), vel: vel.clone(), life, max: life, size, color: new THREE.Color(color), spin: new THREE.Vector3(), rot: new THREE.Euler(0, 0, Math.random() * 6.28), drag: 1.2, grow });
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
      const k = p.life / p.max;
      const speed = p.vel.length();
      this.q.setFromUnitVectors(this.zAxis, this.tmp.copy(p.vel).divideScalar(speed || 1));
      this.s.set(k + 0.2, k + 0.2, Math.max(0.15, speed * 0.04) * p.size);
      this.m.compose(p.pos, this.q, this.s);
      this.sparkMesh.setMatrixAt(n, this.m);
      this.sparkMesh.setColorAt(n, this.tmpColor.copy(p.color).multiplyScalar(4 * k));
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
      p.rot.x += p.spin.x * dt; p.rot.y += p.spin.y * dt; p.rot.z += p.spin.z * dt;
      this.q.setFromEuler(p.rot);
      const fade = Math.min(1, p.life / 0.6);
      this.s.setScalar(p.size * fade);
      this.m.compose(p.pos, this.q, this.s);
      this.debrisMesh.setMatrixAt(n, this.m);
      this.debrisMesh.setColorAt(n, p.color);
      n++;
    }
    this.debrisMesh.count = n;
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
      this.q.copy(camera.quaternion);
      this.s.setScalar(p.size * (1 + k * p.grow));
      this.m.compose(p.pos, this.q, this.s);
      this.smokeMesh.setMatrixAt(n, this.m);
      this.smokeMesh.setColorAt(n, p.color);
      this.smokeAlpha.setX(n, Math.sin(Math.min(1, k * 4) * Math.PI / 2) * (1 - k) * 0.85);
      n++;
    }
    this.smokeMesh.count = n;
    this.smokeAlpha.needsUpdate = true;
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

  clear(): void {
    for (const f of this.sprites) { f.obj.visible = false; this.group.remove(f.obj); this.spritePool.push(f.obj); }
    for (const f of this.meshes) { f.obj.visible = false; this.group.remove(f.obj); (f.obj.userData.ring ? this.ringPool : this.spherePool).push(f.obj); }
    for (const f of this.shields) { f.obj.visible = false; this.group.remove(f.obj); this.shieldPool.push(f.obj); }
    this.sprites = []; this.meshes = []; this.shields = [];
    this.sparks = []; this.debris = []; this.smoke = []; this.motes = [];
    this.lightRequests.length = 0;
  }
}

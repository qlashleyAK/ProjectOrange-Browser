import * as THREE from 'three';
import { POWERUP_KINDS, POWERUPS, type PowerupKind } from '@orange/shared';
import type { PowerupView } from '../view';
import type { Effects } from './effects';

const BEAM_H = 90;

function haloTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,0.55)'); g.addColorStop(0.5, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function coreGeometry(k: PowerupKind): THREE.BufferGeometry {
  switch (k) {
    case 'quad': return new THREE.OctahedronGeometry(1.6, 0);
    case 'reflect': return new THREE.IcosahedronGeometry(1.5, 0);
    case 'haste': return new THREE.TetrahedronGeometry(1.8, 0);
    case 'speed': { const g = new THREE.OctahedronGeometry(1.3, 0); g.scale(0.8, 1.9, 0.8); return g; }
  }
}

function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float y = abs(vUv.y - 0.5) * 2.0;
        float fall = pow(1.0 - y, 2.5);
        float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
        float flow = 0.75 + 0.25 * sin(vUv.y * 90.0 - uTime * 6.0);
        float a = fall * core * flow * 0.32 * uAlpha;
        gl_FragColor = vec4(uColor * a * 2.0, a);
      }`,
  });
}

/** The live powerup (spinning crystal, rings, halo, light pillar, point light) and a ghost where the next one will appear. */
export class PowerupRenderer {
  readonly group = new THREE.Group();
  private cores = new Map<PowerupKind, THREE.Mesh>();
  private coreMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.6, roughness: 0.15, metalness: 0.6, flatShading: true });
  private shell: THREE.LineSegments;
  private rings: THREE.Mesh[] = [];
  private ringMat = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  private halo: THREE.Sprite;
  private beam: THREE.Mesh;
  private ghost: THREE.LineSegments;
  readonly light = new THREE.PointLight(0xffffff, 0, 70, 2);
  private liveId = -1;
  private kind: PowerupKind | null = null;
  private spawnT = 0;
  private moteT = 0;
  private sparkT = 0;
  private pos = new THREE.Vector3();
  private color = new THREE.Color();

  constructor(scene: THREE.Scene, private effects: Effects) {
    scene.add(this.group);
    scene.add(this.light);
    for (const k of POWERUP_KINDS) {
      const m = new THREE.Mesh(coreGeometry(k), this.coreMat);
      m.visible = false;
      this.cores.set(k, m);
      this.group.add(m);
    }
    this.shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(3.2, 1)),
      new THREE.LineBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.55 }));
    this.group.add(this.shell);
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(3.6 + i * 0.9, 0.07, 6, 72), this.ringMat);
      this.rings.push(r);
      this.group.add(r);
    }
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    this.group.add(this.halo);
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, BEAM_H, 20, 1, true), beamMaterial());
    this.group.add(this.beam);
    this.ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.6, 0)),
      new THREE.LineBasicMaterial({ color: 0xcfd8e6, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.25 }));
    this.group.add(this.ghost);
    this.hideLive();
    this.ghost.visible = false;
  }

  private hideLive(): void {
    for (const m of this.cores.values()) m.visible = false;
    this.shell.visible = this.halo.visible = this.beam.visible = false;
    for (const r of this.rings) r.visible = false;
    this.light.intensity = 0;
  }

  update(pv: PowerupView, t: number, dt: number): void {
    const live = pv.live;
    if (!live) {
      this.liveId = -1; this.kind = null;
      this.hideLive();
    } else {
      if (live.id !== this.liveId) { this.liveId = live.id; this.spawnT = 0; }
      if (live.kind !== this.kind) {
        this.kind = live.kind;
        this.color.setHex(POWERUPS[live.kind].color);
        this.coreMat.color.copy(this.color);
        this.coreMat.emissive.copy(this.color);
        (this.shell.material as THREE.LineBasicMaterial).color.copy(this.color).multiplyScalar(1.6);
        this.ringMat.color.copy(this.color).multiplyScalar(2.2);
        (this.halo.material as THREE.SpriteMaterial).color.copy(this.color).multiplyScalar(1.4);
        ((this.beam.material as THREE.ShaderMaterial).uniforms.uColor!.value as THREE.Color).copy(this.color);
        this.light.color.copy(this.color);
      }
      this.spawnT += dt;
      const grow = Math.min(1, this.spawnT / 0.6), ease = 1 - Math.pow(1 - grow, 3);
      const bob = Math.sin(t * 1.6) * 0.6;
      this.pos.set(live.pos.x, live.pos.y + bob, live.pos.z);
      for (const [k, m] of this.cores) {
        m.visible = k === live.kind;
        if (!m.visible) continue;
        m.position.copy(this.pos);
        m.rotation.set(Math.sin(t * 0.7) * 0.4, t * (k === 'haste' ? 3.2 : 1.4), Math.cos(t * 0.9) * 0.3);
        m.scale.setScalar(ease * (1 + 0.06 * Math.sin(t * 5)));
      }
      this.shell.visible = true;
      this.shell.position.copy(this.pos);
      this.shell.rotation.set(t * 0.3, -t * 0.5, 0);
      this.shell.scale.setScalar(ease);
      this.rings.forEach((r, i) => {
        r.visible = true;
        r.position.copy(this.pos);
        r.rotation.set(t * (0.6 + i * 0.35) + i, t * (0.4 - i * 0.25), i * 1.1);
        r.scale.setScalar(ease * (1 + 0.04 * Math.sin(t * 3 + i)));
      });
      this.halo.visible = true;
      this.halo.position.copy(this.pos);
      this.halo.scale.setScalar(ease * (17 + 2 * Math.sin(t * 4)));
      this.beam.visible = true;
      this.beam.position.set(live.pos.x, live.pos.y, live.pos.z);
      const bu = (this.beam.material as THREE.ShaderMaterial).uniforms;
      bu.uTime!.value = t;
      bu.uAlpha!.value = ease;
      this.light.position.copy(this.pos);
      this.light.intensity = ease * (1500 + 300 * Math.sin(t * 4));

      this.moteT -= dt;
      if (this.moteT <= 0) {
        this.moteT = 0.04;
        const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 4;
        const p = new THREE.Vector3(this.pos.x + Math.cos(a) * r, this.pos.y - 3 + Math.random() * 6, this.pos.z + Math.sin(a) * r);
        const v = new THREE.Vector3(-Math.sin(a) * 3, 2 + Math.random() * 2, Math.cos(a) * 3).addScaledVector(new THREE.Vector3(this.pos.x - p.x, 0, this.pos.z - p.z), 0.25);
        this.effects.moteAt(p, v, this.color, 0.8 + Math.random() * 0.8, 1.2 + Math.random() * 0.6, 0.6);
      }
    }

    const next = !live ? pv.next : null;
    this.ghost.visible = !!next;
    if (next) {
      const soon = 1 - Math.min(1, next.in / 10);
      this.ghost.position.set(next.pos.x, next.pos.y, next.pos.z);
      this.ghost.rotation.set(t * 0.4, t * (0.5 + soon * 3), 0);
      this.ghost.scale.setScalar(1 + soon * 0.4);
      (this.ghost.material as THREE.LineBasicMaterial).opacity = 0.18 + soon * 0.4 + (next.in < 3 ? 0.2 * Math.sin(t * 20) : 0);
      this.sparkT -= dt;
      if (next.in < 3 && this.sparkT <= 0) {
        this.sparkT = 0.05;
        const c = new THREE.Vector3(next.pos.x, next.pos.y, next.pos.z);
        const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        this.effects.moteAt(c.clone().addScaledVector(d, 12), d.multiplyScalar(-14), 0xe8f0ff, 0.7, 0.8, 0);
      }
    }
  }
}

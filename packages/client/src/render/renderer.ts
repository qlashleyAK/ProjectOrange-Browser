import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode,
} from 'postprocessing';
import { settings, type Quality } from '../settings';

export interface QualityProfile { bloom: boolean; scale: number; dynamicLights: number; debris: boolean; particles: number; maxDpr: number }

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { bloom: false, scale: 0.75, dynamicLights: 2, debris: false, particles: 0.5, maxDpr: 1 },
  default: { bloom: true, scale: 1, dynamicLights: 4, debris: true, particles: 1, maxDpr: 1.5 },
  high: { bloom: true, scale: 1, dynamicLights: 4, debris: true, particles: 1.5, maxDpr: 2 },
};

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloomPass: EffectPass;
  private plainPass: EffectPass;
  private bloom: BloomEffect;
  quality: Quality = 'default';
  profile: QualityProfile = QUALITY.default;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.info.autoReset = false;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2500);
    this.scene.background = new THREE.Color(0x020306);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new BloomEffect({ intensity: 1.15, luminanceThreshold: 0.85, luminanceSmoothing: 0.2, mipmapBlur: true, radius: 0.7 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const tone2 = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.bloomPass = new EffectPass(this.camera, this.bloom, tone);
    this.plainPass = new EffectPass(this.camera, tone2);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.plainPass);
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM })));
    this.setQuality(settings.quality === 'auto' ? 'default' : settings.quality);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.profile = QUALITY[q];
    this.bloomPass.enabled = this.profile.bloom;
    this.plainPass.enabled = !this.profile.bloom;
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.profile.maxDpr) * this.profile.scale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Horizontal FOV in degrees → vertical for the current aspect. */
  setHorizontalFov(deg: number): void {
    const v = 2 * Math.atan(Math.tan((deg * Math.PI) / 360) / this.camera.aspect) * (180 / Math.PI);
    if (Math.abs(v - this.camera.fov) > 0.01) {
      this.camera.fov = v;
      this.camera.updateProjectionMatrix();
    }
  }

  render(dt: number): void {
    this.renderer.info.reset();
    this.composer.render(dt);
  }

  get drawCalls(): number { return this.renderer.info.render.calls; }
  get triangles(): number { return this.renderer.info.render.triangles; }
}

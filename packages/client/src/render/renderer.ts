import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  BloomEffect, BrightnessContrastEffect, EffectComposer, EffectPass, HueSaturationEffect, RenderPass, SMAAEffect, SMAAPreset,
  ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { settings, type Quality } from '../settings';

export interface QualityProfile {
  bloom: boolean; scale: number; dynamicLights: number; debris: boolean; particles: number; maxDpr: number;
  /** shadow map size for the one shadow-casting light (0 = no shadows) */
  shadows: number;
  /** screen-space ambient occlusion (half resolution, depth-aware upsample) */
  ao: boolean;
  /** ambient dust drifting around the camera */
  dust: boolean;
}

/**
 * Default has to hold 60 FPS on a 2019 integrated GPU at 1080p (design doc §0.2), so shadows and AO are High
 * only; the grade, dust and the particle shaders cost next to nothing and run everywhere but Low.
 */
export const QUALITY: Record<Quality, QualityProfile> = {
  low: { bloom: false, scale: 0.75, dynamicLights: 2, debris: false, particles: 0.5, maxDpr: 1, shadows: 0, ao: false, dust: false },
  default: { bloom: true, scale: 1, dynamicLights: 4, debris: true, particles: 1, maxDpr: 1.5, shadows: 0, ao: false, dust: true },
  high: { bloom: true, scale: 1, dynamicLights: 4, debris: true, particles: 1.5, maxDpr: 2, shadows: 1024, ao: true, dust: true },
};

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private aoPass: N8AOPostPass;
  private bloomPass: EffectPass;
  private plainPass: EffectPass;
  private bloom: BloomEffect;
  quality: Quality = 'default';
  profile: QualityProfile = QUALITY.default;
  private qualityListeners = new Set<(p: QualityProfile) => void>();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.info.autoReset = false;
    // Stays on at every tier: low quality just has no shadow-casting light, so toggling quality never
    // flips this flag (which would force every material to recompile).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2500);
    this.scene.background = new THREE.Color(0x020306);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Ambient occlusion from the depth buffer (normals reconstructed, no second geometry pass). Corners,
    // floor contact under props and crevices in the rock darken, so props stop looking pasted on.
    this.aoPass = new N8AOPostPass(this.scene, this.camera, 512, 512);
    // Additive effects never write depth, so AO only darkens them a little where they overlap walls. Auto-detecting
    // transparency would traverse the whole scene and re-render every transparent object each frame.
    this.aoPass.autoDetectTransparency = false;
    this.aoPass.configuration.transparencyAware = false;
    // world-space radius sized for these rooms: props are meters across, halls hundreds
    this.aoPass.configuration.aoRadius = 10;
    this.aoPass.configuration.distanceFalloff = 1;
    this.aoPass.configuration.intensity = 3;
    this.aoPass.configuration.color = new THREE.Color(0x05070c);
    this.aoPass.configuration.gammaCorrection = false;
    // 16 samples at half resolution with a depth-aware upsample: close to full-res quality at a quarter of the cost
    this.aoPass.setQualityMode('Medium');
    this.aoPass.configuration.halfRes = true;
    this.composer.addPass(this.aoPass);

    this.bloom = new BloomEffect({ intensity: 1.15, luminanceThreshold: 0.85, luminanceSmoothing: 0.2, mipmapBlur: true, radius: 0.7 });
    // grading after tone mapping: a touch more contrast and saturation lifts the flat grey look; the vignette
    // pulls the eye toward the reticle. Hue is left alone so the reserved orange band stays reserved.
    const grade = () => [
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
      new HueSaturationEffect({ saturation: 0.12 }),
      // most of the frame sits below mid-grey, where contrast darkens; the brightness lift keeps ships readable
      new BrightnessContrastEffect({ brightness: 0.02, contrast: 0.06 }),
      new VignetteEffect({ offset: 0.35, darkness: 0.4 }),
    ];
    this.bloomPass = new EffectPass(this.camera, this.bloom, ...grade());
    this.plainPass = new EffectPass(this.camera, ...grade());
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.plainPass);
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM })));
    this.setQuality(settings.quality === 'auto' ? 'default' : settings.quality);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Called with the new profile whenever the quality tier changes. */
  onQuality(fn: (p: QualityProfile) => void): void { this.qualityListeners.add(fn); }

  setQuality(q: Quality): void {
    this.quality = q;
    this.profile = QUALITY[q];
    this.bloomPass.enabled = this.profile.bloom;
    this.plainPass.enabled = !this.profile.bloom;
    this.aoPass.enabled = this.profile.ao;
    this.resize();
    for (const l of this.qualityListeners) l(this.profile);
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

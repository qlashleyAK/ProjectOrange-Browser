import { settings } from '../settings';
import {
  REVERB_OF, renderAmbience, renderMatchMusic, renderMenuMusic, renderReverb, renderSounds,
  type AmbienceId, type ReverbId, type SoundName,
} from './sounds';
import { SR } from './synth';

export interface PlayOpts {
  pos?: { x: number; y: number; z: number };
  gain?: number;
  rate?: number;
  bus?: 'sfx' | 'ui';
  /** reverb send amount 0..1 (world sounds default 0.35) */
  wet?: number;
}

const MAX_VOICES = 40;

/** WebAudio graph: master(compressor) ← sfx / ui / music / ambience buses; positional HRTF voices. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private master!: GainNode;
  private sfx!: GainNode;
  private ui!: GainNode;
  private music!: GainNode;
  private musicDuck!: GainNode;
  private ambience!: GainNode;
  private reverbIn!: GainNode;
  private convA!: ConvolverNode;
  private convB!: ConvolverNode;
  private convAGain!: GainNode;
  private convBGain!: GainNode;
  private activeConv: 'A' | 'B' = 'A';
  private reverbBuffers = new Map<ReverbId, AudioBuffer>();
  private currentReverb: ReverbId | null = null;
  private ambBuffers = new Map<AmbienceId, AudioBuffer>();
  private ambSource: { src: AudioBufferSourceNode; gain: GainNode; id: AmbienceId } | null = null;
  private musicSource: { src: AudioBufferSourceNode; gain: GainNode; kind: 'match' | 'menu' } | null = null;
  private musicBuffers: { match?: AudioBuffer; menu?: AudioBuffer } = {};
  private wantMusic: 'match' | 'menu' | null = null;
  private voices: { src: AudioBufferSourceNode; end: number; prio: number }[] = [];
  private loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();
  private engineNodes: { oscA: OscillatorNode; oscB: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode; filter: BiquadFilterNode; gain: GainNode; boost: GainNode; boostSrc: AudioBufferSourceNode; faction: string } | null = null;
  private lastPlayed = new Map<string, number>();
  private duck = 0;
  ready = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain(); this.master.connect(comp);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.ui = ctx.createGain(); this.ui.connect(this.master);
    this.musicDuck = ctx.createGain(); this.musicDuck.connect(this.master);
    this.music = ctx.createGain(); this.music.connect(this.musicDuck);
    this.ambience = ctx.createGain(); this.ambience.connect(this.master);
    this.reverbIn = ctx.createGain(); this.reverbIn.gain.value = 1;
    this.convA = ctx.createConvolver(); this.convB = ctx.createConvolver();
    this.convAGain = ctx.createGain(); this.convBGain = ctx.createGain();
    this.convAGain.gain.value = 0; this.convBGain.gain.value = 0;
    this.reverbIn.connect(this.convA); this.reverbIn.connect(this.convB);
    this.convA.connect(this.convAGain).connect(this.sfx);
    this.convB.connect(this.convBGain).connect(this.sfx);
    this.applyVolumes();

    const sounds = renderSounds();
    for (const [name, data] of Object.entries(sounds) as [SoundName, Float32Array][]) {
      const b = ctx.createBuffer(1, data.length, SR);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(name, b);
    }
    this.ready = true;
    // heavier assets are rendered in idle slices so the first click doesn't hitch
    const jobs: (() => void)[] = [
      () => { this.musicBuffers.menu = this.stereo(renderMenuMusic()); if (this.wantMusic === 'menu') this.startMusic('menu'); },
      ...(['hall', 'metal', 'hangar', 'reactor', 'cave', 'machinery', 'tight'] as ReverbId[]).map((id) => () => { this.reverbBuffers.set(id, this.stereo(renderReverb(id))); }),
      ...(['hub', 'foundry', 'dock', 'reactor', 'gallery', 'crusher', 'tunnel'] as AmbienceId[]).map((id) => () => {
        const d = renderAmbience(id);
        const b = ctx.createBuffer(1, d.length, SR); b.copyToChannel(d as Float32Array<ArrayBuffer>, 0); this.ambBuffers.set(id, b);
      }),
      () => { this.musicBuffers.match = this.stereo(renderMatchMusic()); if (this.wantMusic === 'match') this.startMusic('match'); },
    ];
    const run = () => {
      const job = jobs.shift();
      if (!job) return;
      job();
      setTimeout(run, 30);
    };
    setTimeout(run, 50);
  }

  private stereo([l, r]: [Float32Array, Float32Array]): AudioBuffer {
    const b = this.ctx!.createBuffer(2, l.length, SR);
    b.copyToChannel(l as Float32Array<ArrayBuffer>, 0); b.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
    return b;
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    this.master.gain.value = settings.masterVolume;
    this.sfx.gain.value = settings.sfxVolume;
    this.ui.gain.value = settings.sfxVolume * 0.8;
    this.music.gain.value = settings.musicVolume * 0.55;
    this.ambience.gain.value = settings.sfxVolume * 0.5;
  }

  play(name: SoundName, o: PlayOpts = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready || ctx.state !== 'running') return;
    const b = this.buffers.get(name);
    if (!b) return;
    // de-duplicate identical sounds within 25 ms (e.g. multi-pellet spam)
    const key = `${name}:${o.pos ? `${Math.round(o.pos.x / 4)},${Math.round(o.pos.y / 4)},${Math.round(o.pos.z / 4)}` : 'ui'}`;
    const now = ctx.currentTime;
    if ((this.lastPlayed.get(key) ?? -1) > now - 0.025) return;
    this.lastPlayed.set(key, now);
    if (this.lastPlayed.size > 256) this.lastPlayed.clear();

    this.voices = this.voices.filter((v) => v.end > now);
    const prio = o.pos ? 0 : 1;
    if (this.voices.length >= MAX_VOICES) {
      const victim = this.voices.reduce((a, v) => (v.prio < a.prio || (v.prio === a.prio && v.end < a.end) ? v : a));
      try { victim.src.stop(); } catch { /* already stopped */ }
      this.voices.splice(this.voices.indexOf(victim), 1);
    }
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = o.rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g);
    const out = o.bus === 'ui' ? this.ui : this.sfx;
    if (o.pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 14;
      p.rolloffFactor = 1.1;
      p.maxDistance = 400;
      p.positionX.value = o.pos.x; p.positionY.value = o.pos.y; p.positionZ.value = o.pos.z;
      g.connect(p);
      p.connect(out);
      const wet = o.wet ?? 0.35;
      if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; p.connect(s).connect(this.reverbIn); }
    } else {
      g.connect(out);
      if (o.wet) { const s = ctx.createGain(); s.gain.value = o.wet; g.connect(s).connect(this.reverbIn); }
    }
    src.start();
    this.voices.push({ src, end: now + b.duration / (o.rate ?? 1), prio });
    if (o.bus !== 'ui' && (o.gain ?? 1) > 0.5) this.duck = Math.min(1, this.duck + 0.08);
  }

  /** Non-positional looped sound (lock tone, missile alarm). */
  loop(name: SoundName, on: boolean, gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready) return;
    const cur = this.loops.get(name);
    if (on && !cur) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.get(name)!;
      src.loop = true;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(g).connect(this.ui);
      src.start();
      this.loops.set(name, { src, gain: g });
    } else if (!on && cur) {
      cur.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      cur.src.stop(ctx.currentTime + 0.1);
      this.loops.delete(name);
    }
  }

  setListener(pos: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(up.x, t); l.upY.setValueAtTime(up.y, t); l.upZ.setValueAtTime(up.z, t);
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
      (l as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** Switch ambience loop and reverb preset for the current place. */
  setPlace(place: string | null, isTunnel: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const amb: AmbienceId = isTunnel || !place ? 'tunnel' : (['hub', 'foundry', 'dock', 'reactor', 'gallery', 'crusher'].includes(place) ? place as AmbienceId : 'tunnel');
    const rev = REVERB_OF[amb];
    if (rev !== this.currentReverb) {
      const b = this.reverbBuffers.get(rev);
      if (b) {
        this.currentReverb = rev;
        const t = ctx.currentTime;
        const [inConv, inGain, outGain] = this.activeConv === 'A' ? [this.convB, this.convBGain, this.convAGain] : [this.convA, this.convAGain, this.convBGain];
        inConv.buffer = b;
        inGain.gain.setTargetAtTime(1, t, 0.15);
        outGain.gain.setTargetAtTime(0, t, 0.15);
        this.activeConv = this.activeConv === 'A' ? 'B' : 'A';
      }
    }
    if (this.ambSource?.id !== amb) {
      const b = this.ambBuffers.get(amb);
      if (!b) return;
      const t = ctx.currentTime;
      if (this.ambSource) {
        const old = this.ambSource;
        old.gain.gain.setTargetAtTime(0, t, 0.4);
        old.src.stop(t + 2);
      }
      const src = ctx.createBufferSource();
      src.buffer = b; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0;
      g.gain.setTargetAtTime(1, t, 0.5);
      src.connect(g).connect(this.ambience);
      src.start();
      this.ambSource = { src, gain: g, id: amb };
    }
  }

  startMusic(kind: 'match' | 'menu' | null): void {
    this.wantMusic = kind;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.musicSource?.kind === kind) return;
    const t = ctx.currentTime;
    if (this.musicSource) {
      const old = this.musicSource;
      old.gain.gain.setTargetAtTime(0, t, 0.5);
      old.src.stop(t + 3);
      this.musicSource = null;
    }
    if (!kind) return;
    const b = this.musicBuffers[kind];
    if (!b) return;
    const src = ctx.createBufferSource();
    src.buffer = b; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(1, t, 0.8);
    src.connect(g).connect(this.music);
    src.start();
    this.musicSource = { src, gain: g, kind };
  }

  /** Local ship engine: Fleet turbine whine or Machine pulsing drone, pitched by speed, plus boost roar. */
  engine(state: { faction: 'fleet' | 'machine'; speed01: number; boosting: boolean; alive: boolean } | null): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready) return;
    if (!state || !state.alive) {
      if (this.engineNodes) this.engineNodes.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      return;
    }
    if (this.engineNodes && this.engineNodes.faction !== state.faction) {
      const e = this.engineNodes;
      e.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      setTimeout(() => { e.oscA.stop(); e.oscB.stop(); e.lfo.stop(); e.boostSrc.stop(); }, 300);
      this.engineNodes = null;
    }
    if (!this.engineNodes) {
      const machine = state.faction === 'machine';
      const oscA = ctx.createOscillator(); oscA.type = machine ? 'triangle' : 'sawtooth';
      const oscB = ctx.createOscillator(); oscB.type = machine ? 'sine' : 'square';
      const filter = ctx.createBiquadFilter(); filter.type = machine ? 'lowpass' : 'bandpass'; filter.Q.value = machine ? 2 : 6;
      const gain = ctx.createGain(); gain.gain.value = 0;
      const lfo = ctx.createOscillator(); lfo.frequency.value = machine ? 3.2 : 0.5;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = machine ? 0.05 : 0.004;
      const ampMod = ctx.createGain(); ampMod.gain.value = 0.08;
      lfo.connect(lfoGain).connect(ampMod.gain);
      oscA.connect(filter); oscB.connect(filter);
      filter.connect(ampMod).connect(gain).connect(this.sfx);
      const noiseBuf = ctx.createBuffer(1, SR * 2, SR);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const boostSrc = ctx.createBufferSource(); boostSrc.buffer = noiseBuf; boostSrc.loop = true;
      const bf = ctx.createBiquadFilter(); bf.type = 'lowpass'; bf.frequency.value = 700;
      const boost = ctx.createGain(); boost.gain.value = 0;
      boostSrc.connect(bf).connect(boost).connect(this.sfx);
      oscA.start(); oscB.start(); lfo.start(); boostSrc.start();
      this.engineNodes = { oscA, oscB, lfo, lfoGain, filter, gain, boost, boostSrc, faction: state.faction };
    }
    const e = this.engineNodes;
    const t = ctx.currentTime, s = Math.min(1.6, state.speed01);
    const machine = state.faction === 'machine';
    e.oscA.frequency.setTargetAtTime(machine ? 48 + s * 40 : 140 + s * 260, t, 0.08);
    e.oscB.frequency.setTargetAtTime(machine ? 96.5 + s * 80 : 281 + s * 520, t, 0.08);
    e.filter.frequency.setTargetAtTime(machine ? 300 + s * 500 : 900 + s * 2200, t, 0.08);
    e.gain.gain.setTargetAtTime(0.25 + s * 0.2, t, 0.1);
    e.boost.gain.setTargetAtTime(state.boosting ? 0.22 : 0, t, 0.08);
  }

  /** per-frame: release music duck */
  update(dt: number): void {
    if (!this.ctx) return;
    this.duck = Math.max(0, this.duck - dt * 0.6);
    this.musicDuck.gain.setTargetAtTime(1 - this.duck * 0.5, this.ctx.currentTime, 0.1);
  }

  stopAllLoops(): void {
    for (const k of [...this.loops.keys()]) this.loop(k as SoundName, false);
    this.engine(null);
  }
}

export const audio = new AudioEngine();

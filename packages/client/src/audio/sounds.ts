import {
  adsr, bandpass, bell, buf, expDecay, highpass, impulseResponse, lowpass, mix, noise, noiseBurst, normalize, osc, softClip, SR,
} from './synth';

export type SoundName =
  | 'zap' | 'shotgun' | 'shriek' | 'thump' | 'slug' | 'flakStorm'
  | 'missileLaunch' | 'swarmLaunch' | 'torpedoLaunch' | 'explosion' | 'bigExplosion' | 'splash'
  | 'shieldHit' | 'hullHit' | 'worldPing' | 'pickup' | 'tierUp' | 'tierDown' | 'dropTinkle'
  | 'repel' | 'overdrive' | 'sweep' | 'cloakOn' | 'cloakOff' | 'bulwarkUp' | 'bulwarkAbsorb' | 'bulwarkBreak'
  | 'lockBeep' | 'lockSolid' | 'missileAlarm' | 'scrape' | 'click' | 'beep' | 'go' | 'dodge' | 'spawn' | 'whir'
  | 'hitMarker' | 'killConfirm' | 'death';

/** Renders every SFX buffer; ~100 ms total. */
export function renderSounds(): Record<SoundName, Float32Array> {
  const s = {} as Record<SoundName, Float32Array>;
  s.zap = normalize(mix(
    osc(0.12, (t) => 2200 * Math.exp(-t * 28) + 500, 'square', expDecay(30), 0.5),
    [lowpass(noiseBurst(0.03, expDecay(120)), 6000), 0.6],
  ), 0.7);
  s.shotgun = normalize(softClip(mix(
    lowpass(noiseBurst(0.35, expDecay(12)), (t) => 5000 * Math.exp(-t * 10) + 300),
    [osc(0.25, (t) => 110 * Math.exp(-t * 8) + 40, 'sine', expDecay(14)), 1.2],
  ), 2), 0.85);
  s.shriek = normalize(mix(
    ...([2400, 3170, 4310, 5650] as const).map((f, i) => [osc(0.18, (t) => f * (1 - t * 1.4), 'saw', expDecay(18 + i * 4)), 0.4 / (i + 1)] as [Float32Array, number]),
    [highpass(noiseBurst(0.05, expDecay(60)), 3000), 0.4],
  ), 0.65);
  s.thump = normalize(softClip(mix(
    osc(0.45, (t) => 85 * Math.exp(-t * 6) + 35, 'sine', expDecay(7)),
    [bandpass(noiseBurst(0.3, expDecay(10)), (t) => 900 * Math.exp(-t * 5) + 200, 2), 0.6],
    [osc(0.2, (t) => 420 * Math.exp(-t * 20) + 90, 'tri', expDecay(16)), 0.4],
  ), 1.8), 0.9);
  s.slug = normalize(mix(
    osc(0.3, (t) => 600 * Math.exp(-t * 12) + 120, 'saw', expDecay(10), 0.5),
    [lowpass(noiseBurst(0.2, expDecay(16)), 2500), 0.7],
  ), 0.8);
  s.flakStorm = normalize(softClip(mix(
    osc(0.5, (t) => 70 * Math.exp(-t * 4) + 30, 'sine', expDecay(5)),
    [bandpass(noiseBurst(0.45, expDecay(7)), 500, 1.5), 0.8],
  ), 2), 0.9);

  s.missileLaunch = normalize(mix(
    bandpass(noiseBurst(0.7, adsr(0.02, 0.2, 0.5, 0.4, 0.7)), (t) => 300 + t * 2600, 3),
    [osc(0.3, (t) => 180 + t * 300, 'saw', expDecay(9)), 0.25],
  ), 0.75);
  s.swarmLaunch = normalize(mix(
    ...[0, 0.05, 0.1, 0.15, 0.2, 0.25].map((o) => [bandpass(noiseBurst(0.25, expDecay(14)), (t) => 800 + t * 4000, 3), 0.6, o] as [Float32Array, number, number]),
  ), 0.7);
  s.torpedoLaunch = normalize(softClip(mix(
    osc(1.0, () => 55, 'saw', adsr(0.05, 0.3, 0.6, 0.5, 1.0), 0.6),
    [lowpass(noiseBurst(1.0, adsr(0.01, 0.4, 0.4, 0.5, 1.0)), 600), 0.8],
    [osc(1.0, (t) => 220 - t * 100, 'sine', expDecay(3)), 0.4],
  ), 1.5), 0.85);
  s.explosion = normalize(softClip(mix(
    lowpass(noiseBurst(1.6, expDecay(2.8)), (t) => 3500 * Math.exp(-t * 3) + 150),
    [osc(1.2, (t) => 55 * Math.exp(-t * 1.5) + 28, 'sine', expDecay(2.5)), 1.4],
    [highpass(noiseBurst(0.08, expDecay(40)), 2000), 0.6],
  ), 2.2), 0.95);
  s.bigExplosion = normalize(softClip(mix(
    lowpass(noiseBurst(2.4, expDecay(1.8)), (t) => 2500 * Math.exp(-t * 2) + 100),
    [osc(2.0, (t) => 45 * Math.exp(-t * 1.2) + 22, 'sine', expDecay(1.6)), 1.6],
    [lowpass(noiseBurst(0.6, expDecay(6)), 6000), 0.5, 0.05],
  ), 2.4), 0.95);
  s.splash = normalize(mix(
    lowpass(noiseBurst(0.4, expDecay(10)), (t) => 2500 * Math.exp(-t * 8) + 200),
    [osc(0.3, (t) => 160 * Math.exp(-t * 10) + 50, 'sine', expDecay(10)), 0.9],
  ), 0.8);

  s.shieldHit = normalize(mix(
    highpass(noiseBurst(0.18, (t) => expDecay(22)(t) * (0.6 + 0.4 * Math.sin(t * 900))), 2500),
    [osc(0.15, (t) => 3200 - t * 6000, 'sine', expDecay(30)), 0.3],
  ), 0.6);
  s.hullHit = normalize(softClip(mix(
    bandpass(noiseBurst(0.25, expDecay(16)), 1200, 2),
    [bell(0.3, 410, 14, [[1, 1], [2.3, 0.6], [3.9, 0.4]]), 0.5],
    [osc(0.12, (t) => 140 - t * 300, 'square', expDecay(30)), 0.3],
  ), 1.6), 0.75);
  s.worldPing = normalize(mix(bell(0.25, 2100, 18), [highpass(noiseBurst(0.02, expDecay(150)), 4000), 0.5]), 0.45);
  s.pickup = normalize(mix(bell(0.5, 880, 6), [bell(0.4, 1320, 7), 0.5, 0.05]), 0.6);
  s.tierUp = normalize(mix(
    ...([523.25, 659.25, 783.99, 1046.5] as const).map((f, i) => [mix(osc(0.5, () => f, 'square', adsr(0.005, 0.1, 0.4, 0.3, 0.5), 0.25), bell(0.6, f, 5)), 0.7, i * 0.08] as [Float32Array, number, number]),
  ), 0.75);
  s.tierDown = normalize(mix(
    ...([392, 311.1, 261.6] as const).map((f, i) => [osc(0.35, () => f, 'tri', adsr(0.005, 0.1, 0.4, 0.2, 0.35)), 0.6, i * 0.09] as [Float32Array, number, number]),
  ), 0.5);
  s.dropTinkle = normalize(mix(
    ...[0, 0.04, 0.09, 0.13, 0.2, 0.27].map((o, i) => [bell(0.3, 1800 + i * 330, 12), 0.5, o] as [Float32Array, number, number]),
  ), 0.5);

  s.repel = normalize(softClip(mix(
    osc(0.7, (t) => 140 * Math.exp(-t * 4) + 35, 'sine', expDecay(4)),
    [bandpass(noiseBurst(0.7, adsr(0.01, 0.2, 0.4, 0.4, 0.7)), (t) => 3000 * Math.exp(-t * 4) + 200, 1.5), 0.7],
  ), 1.6), 0.9);
  s.overdrive = normalize(mix(
    osc(0.8, (t) => 90 + t * t * 900, 'saw', adsr(0.05, 0.2, 0.8, 0.3, 0.8), 0.4),
    [osc(0.8, (t) => 180 + t * t * 1800, 'sine', adsr(0.05, 0.2, 0.8, 0.3, 0.8)), 0.4],
  ), 0.7);
  s.sweep = normalize(mix(
    osc(1.6, () => 1180, 'sine', expDecay(3.2)),
    [osc(1.6, () => 1180, 'sine', expDecay(4)), 0.4, 0.32],
    [osc(1.6, () => 1180, 'sine', expDecay(5)), 0.2, 0.64],
  ), 0.6);
  const shimmer = (up: boolean) => normalize(mix(
    ...[1, 1.007, 1.5, 1.51, 2.01].map((m) => [osc(0.6, (t) => (up ? 400 + t * 900 : 1300 - t * 900) * m, 'sine', adsr(0.05, 0.2, 0.5, 0.3, 0.6)), 0.3] as [Float32Array, number]),
    [highpass(noiseBurst(0.6, adsr(0.05, 0.2, 0.3, 0.3, 0.6)), 5000), 0.2],
  ), 0.55);
  s.cloakOn = shimmer(false);
  s.cloakOff = shimmer(true);
  s.bulwarkUp = normalize(mix(
    osc(0.6, (t) => 120 + t * 300, 'saw', adsr(0.02, 0.2, 0.6, 0.3, 0.6), 0.4),
    [osc(0.6, (t) => 240 + t * 600, 'tri', adsr(0.02, 0.2, 0.6, 0.3, 0.6)), 0.4],
  ), 0.65);
  s.bulwarkAbsorb = normalize(mix(
    bandpass(noiseBurst(0.2, expDecay(20)), 700, 3),
    [osc(0.2, (t) => 300 - t * 600, 'square', expDecay(25)), 0.4],
  ), 0.6);
  s.bulwarkBreak = normalize(mix(
    highpass(noiseBurst(0.6, expDecay(6)), 2500),
    ...[0, 0.03, 0.07, 0.12].map((o, i) => [bell(0.4, 2400 + i * 520, 10), 0.4, o] as [Float32Array, number, number]),
  ), 0.7);

  s.lockBeep = normalize(osc(0.06, () => 1400, 'square', adsr(0.002, 0.01, 0.8, 0.02, 0.06), 0.4), 0.35);
  s.lockSolid = normalize(osc(0.25, () => 1860, 'square', () => 1, 0.4), 0.28);
  s.missileAlarm = normalize(mix(
    osc(0.2, () => 980, 'square', adsr(0.002, 0.02, 0.9, 0.02, 0.2), 0.5),
    [osc(0.2, () => 1320, 'square', adsr(0.002, 0.02, 0.9, 0.02, 0.2), 0.5), 1, 0.2],
  ), 0.4);
  s.scrape = normalize(bandpass(noiseBurst(0.35, adsr(0.01, 0.1, 0.6, 0.2, 0.35)), (t) => 900 + Math.sin(t * 90) * 300, 3), 0.55);
  s.click = normalize(mix(osc(0.03, () => 1800, 'sine', expDecay(150)), [highpass(noiseBurst(0.01, expDecay(400)), 3000), 0.5]), 0.4);
  s.beep = normalize(osc(0.14, () => 660, 'sine', adsr(0.005, 0.03, 0.7, 0.06, 0.14)), 0.5);
  s.go = normalize(mix(osc(0.4, () => 990, 'sine', adsr(0.005, 0.05, 0.7, 0.2, 0.4)), [osc(0.4, () => 1485, 'sine', adsr(0.005, 0.05, 0.7, 0.2, 0.4)), 0.5]), 0.55);
  s.dodge = normalize(bandpass(noiseBurst(0.3, adsr(0.01, 0.08, 0.5, 0.2, 0.3)), (t) => 600 + t * 4000, 2), 0.5);
  s.spawn = normalize(mix(
    ...[0, 0.06, 0.12].map((o, i) => [bell(0.5, 660 * Math.pow(1.5, i), 6), 0.4, o] as [Float32Array, number, number]),
    [highpass(noiseBurst(0.5, adsr(0.1, 0.2, 0.3, 0.2, 0.5)), 4000), 0.15],
  ), 0.5);
  s.whir = normalize(bandpass(noiseBurst(0.9, (t) => Math.pow(Math.sin(t * Math.PI * 2 * 1.11), 2) * expDecay(1.5)(t)), (t) => 1400 + Math.sin(t * 7) * 600, 6), 0.3);
  s.hitMarker = normalize(osc(0.05, () => 2600, 'sine', expDecay(80)), 0.35);
  s.killConfirm = normalize(mix(osc(0.25, () => 880, 'tri', expDecay(10)), [osc(0.25, () => 1320, 'tri', expDecay(10)), 0.8, 0.07]), 0.55);
  s.death = normalize(mix(osc(1.2, (t) => 300 * Math.exp(-t * 2), 'saw', expDecay(2), 0.4), [lowpass(noiseBurst(1.2, expDecay(2.5)), 900), 0.8]), 0.7);
  return s;
}

// ------------------------------------------------------------------ music
const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** Driving synth loop for matches: 8 bars at 124 BPM in A minor (stereo-ish via two channels). */
export function renderMatchMusic(): [Float32Array, Float32Array] {
  const bpm = 124, beat = 60 / bpm, bars = 8, len = bars * 4 * beat;
  const L = buf(len), R = buf(len);
  const add = (src: Float32Array, at: number, gl: number, gr: number) => {
    const o = Math.round(at * SR);
    for (let i = 0; i < src.length && i + o < L.length; i++) { L[i + o]! += src[i]! * gl; R[i + o]! += src[i]! * gr; }
  };
  const kick = osc(0.4, (t) => 120 * Math.exp(-t * 18) + 42, 'sine', expDecay(7));
  const hat = highpass(noiseBurst(0.05, expDecay(70)), 7000);
  const snare = mix(highpass(noiseBurst(0.2, expDecay(18)), 1500), [osc(0.15, () => 190, 'tri', expDecay(25)), 0.6]);
  const prog = [57, 57, 53, 53, 48, 48, 55, 55]; // A F C G (bass roots, two bars each... per bar)
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * beat;
    for (let b = 0; b < 4; b++) {
      add(kick, t0 + b * beat, 0.9, 0.9);
      add(hat, t0 + b * beat + beat / 2, 0.18, 0.28);
      if (b % 2 === 1) add(snare, t0 + b * beat, 0.35, 0.3);
    }
    const root = prog[bar]! - 24;
    for (let i = 0; i < 8; i++) {
      const n = root + [0, 12, 0, 12, 7, 12, 0, 10][i]!;
      const bass = lowpass(osc(beat / 2, () => NOTE(n), 'saw', adsr(0.005, 0.08, 0.5, 0.05, beat / 2), 0.5), 900);
      add(bass, t0 + i * beat / 2, 0.55, 0.55);
    }
    const chord = [0, 3, 7].map((iv) => prog[bar]! + iv + (iv === 3 && [53, 48].includes(prog[bar]!) ? 1 : 0));
    for (let k = 0; k < 16; k++) {
      const n = chord[k % 3]! + 12 + (k % 6 === 5 ? 12 : 0);
      const arp = lowpass(osc(beat / 4, () => NOTE(n), 'square', adsr(0.003, 0.05, 0.3, 0.05, beat / 4), 0.12), 2600);
      add(arp, t0 + k * beat / 4, k % 2 ? 0.25 : 0.6, k % 2 ? 0.6 : 0.25);
    }
    const pad = lowpass(mix(...chord.map((n) => [osc(4 * beat, () => NOTE(n), 'saw', adsr(0.4, 0.5, 0.6, 0.6, 4 * beat), 0.08), 1] as [Float32Array, number])), 1200);
    add(pad, t0, 0.5, 0.5);
  }
  normalize(L, 0.8); normalize(R, 0.8);
  return [L, R];
}

/** Calm menu loop: slow pad + soft bells. */
export function renderMenuMusic(): [Float32Array, Float32Array] {
  const len = 16;
  const L = buf(len), R = buf(len);
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  chords.forEach((c, i) => {
    const pad = lowpass(mix(...c.map((n) => [mix(osc(4.4, () => NOTE(n - 12), 'saw', adsr(1.2, 1, 0.7, 1.5, 4.4), 0.05), osc(4.4, () => NOTE(n) * 1.003, 'tri', adsr(1.2, 1, 0.7, 1.5, 4.4), 0.06)), 1] as [Float32Array, number])), 900);
    const o = Math.round(i * 4 * SR);
    for (let k = 0; k < pad.length && k + o < L.length; k++) { L[k + o]! += pad[k]!; R[k + o]! += pad[k]! * 0.9; }
    for (let j = 0; j < 3; j++) {
      const b = bell(1.5, NOTE(c[j]! + 12), 3);
      const ob = Math.round((i * 4 + j * 1.3 + 0.5) * SR);
      for (let k = 0; k < b.length && k + ob < L.length; k++) { L[k + ob]! += b[k]! * 0.08 * (j % 2 ? 0.5 : 1); R[k + ob]! += b[k]! * 0.08 * (j % 2 ? 1 : 0.5); }
    }
  });
  normalize(L, 0.6); normalize(R, 0.6);
  return [L, R];
}

// ------------------------------------------------------------------ ambience & reverbs
export type AmbienceId = 'hub' | 'foundry' | 'dock' | 'reactor' | 'gallery' | 'crusher' | 'tunnel';

export function renderAmbience(id: AmbienceId): Float32Array {
  const len = 6;
  switch (id) {
    case 'hub': return normalize(mix(lowpass(noiseBurst(len, () => 1), 180), [osc(len, () => 55, 'sine', () => 0.4 + 0.1 * Math.sin(0)), 0.3]), 0.35);
    case 'foundry': {
      const base = lowpass(noiseBurst(len, () => 1), 300);
      const clanks = buf(len);
      for (const at of [0.6, 2.1, 3.3, 4.9]) {
        const c = bell(0.6, 300 + noise() * 120, 9, [[1, 1], [2.4, 0.6], [4.1, 0.3]]);
        const o = Math.round(at * SR);
        for (let i = 0; i < c.length && i + o < clanks.length; i++) clanks[i + o]! += c[i]! * 0.5;
      }
      const steam = highpass(noiseBurst(len, (t) => (t > 1.4 && t < 2.6 ? Math.sin(((t - 1.4) / 1.2) * Math.PI) : 0)), 2500);
      return normalize(mix(base, [clanks, 0.6], [steam, 0.4]), 0.35);
    }
    case 'dock': return normalize(mix(lowpass(noiseBurst(len, () => 1), 400), [osc(len, () => 120, 'sine', () => 1), 0.15], [osc(len, () => 240.5, 'sine', () => 1), 0.06]), 0.3);
    case 'reactor': return normalize(mix(osc(len, () => 41, 'sine', (t) => 0.7 + 0.3 * Math.sin(t * Math.PI * 2 * (2 / 3))), [lowpass(noiseBurst(len, () => 1), 120), 0.8], [osc(len, () => 82, 'tri', () => 0.2), 0.3]), 0.4);
    case 'gallery': {
      const drips = buf(len);
      for (const at of [0.3, 1.7, 2.2, 3.9, 5.1]) {
        const d = bell(0.4, 1500 + noise() * 600, 14);
        const o = Math.round(at * SR);
        for (let i = 0; i < d.length && i + o < drips.length; i++) drips[i + o]! += d[i]! * 0.5;
      }
      const chime = mix(bell(2, 2093, 1.5), [bell(2, 2637, 1.6), 0.6, 2.8]);
      return normalize(mix(lowpass(noiseBurst(len, () => 1), 140), [drips, 0.5], [chime, 0.08]), 0.3);
    }
    case 'crusher': return normalize(softClip(mix(bandpass(noiseBurst(len, (t) => 0.6 + 0.4 * Math.sin(t * Math.PI * 2 * 1.5)), 260, 2), [osc(len, () => 47, 'saw', () => 0.3), 0.4]), 1.5), 0.35);
    case 'tunnel': return normalize(lowpass(noiseBurst(len, () => 1), 250), 0.22);
  }
}

export type ReverbId = 'hall' | 'metal' | 'hangar' | 'reactor' | 'cave' | 'machinery' | 'tight';
export const REVERB_OF: Record<AmbienceId, ReverbId> = { hub: 'hall', foundry: 'metal', dock: 'hangar', reactor: 'reactor', gallery: 'cave', crusher: 'machinery', tunnel: 'tight' };
export function renderReverb(id: ReverbId): [Float32Array, Float32Array] {
  switch (id) {
    case 'hall': return impulseResponse(2.6, 3, 5000);
    case 'metal': return impulseResponse(1.4, 2.5, 8000);
    case 'hangar': return impulseResponse(2.2, 3, 4500);
    case 'reactor': return impulseResponse(3.2, 3.5, 3500);
    case 'cave': return impulseResponse(2.4, 2.2, 6000);
    case 'machinery': return impulseResponse(1.1, 2.5, 5000);
    case 'tight': return impulseResponse(0.5, 3, 7000);
  }
}

/** Tiny offline synthesizer: renders sounds to Float32Arrays (mono or stereo). */
export const SR = 44100;

let seed = 1234567;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
export const noise = () => rnd() * 2 - 1;

export function buf(seconds: number): Float32Array { return new Float32Array(Math.ceil(seconds * SR)); }

export type Env = (t: number) => number;
export const expDecay = (k: number): Env => (t) => Math.exp(-t * k);
export const adsr = (a: number, d: number, s: number, r: number, len: number): Env => (t) => {
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < len - r) return s;
  return Math.max(0, s * (1 - (t - (len - r)) / r));
};

/** Oscillator with a frequency function; returns samples. */
export function osc(len: number, freq: (t: number) => number, shape: 'sine' | 'square' | 'saw' | 'tri', env: Env, gain = 1): Float32Array {
  const out = buf(len);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += freq(t) / SR;
    const p = ph - Math.floor(ph);
    let v: number;
    switch (shape) {
      case 'sine': v = Math.sin(p * Math.PI * 2); break;
      case 'square': v = p < 0.5 ? 1 : -1; break;
      case 'saw': v = p * 2 - 1; break;
      case 'tri': v = 1 - 4 * Math.abs(p - 0.5); break;
    }
    out[i] = v * env(t) * gain;
  }
  return out;
}

export function noiseBurst(len: number, env: Env, gain = 1): Float32Array {
  const out = buf(len);
  for (let i = 0; i < out.length; i++) out[i] = noise() * env(i / SR) * gain;
  return out;
}

/** One-pole lowpass with a (possibly time-varying) cutoff. */
export function lowpass(x: Float32Array, cutoff: number | ((t: number) => number)): Float32Array {
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const fc = typeof cutoff === 'number' ? cutoff : cutoff(i / SR);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
    y += a * (x[i]! - y);
    out[i] = y;
  }
  return out;
}
export function highpass(x: Float32Array, cutoff: number): Float32Array {
  const lp = lowpass(x, cutoff);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! - lp[i]!;
  return out;
}
/** Two-pole resonant bandpass (state-variable filter). */
export function bandpass(x: Float32Array, center: number | ((t: number) => number), q = 4): Float32Array {
  const out = new Float32Array(x.length);
  let low = 0, band = 0;
  for (let i = 0; i < x.length; i++) {
    const fc = typeof center === 'number' ? center : center(i / SR);
    const f = 2 * Math.sin((Math.PI * Math.min(fc, SR / 6)) / SR);
    low += f * band;
    const high = x[i]! - low - band / q;
    band += f * high;
    out[i] = band;
  }
  return out;
}

export function mix(...parts: (Float32Array | [Float32Array, number] | [Float32Array, number, number])[]): Float32Array {
  let len = 0;
  const norm = parts.map((p) => (Array.isArray(p) ? p : [p, 1, 0]) as [Float32Array, number, number?]);
  for (const [a, , off] of norm) len = Math.max(len, a.length + Math.round((off ?? 0) * SR));
  const out = new Float32Array(len);
  for (const [a, g, off] of norm) {
    const o = Math.round((off ?? 0) * SR);
    for (let i = 0; i < a.length; i++) out[i + o]! += a[i]! * g;
  }
  return out;
}

export function normalize(x: Float32Array, peak = 0.9): Float32Array {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i]! / m) * peak;
  return x;
}

export function softClip(x: Float32Array, drive = 1.5): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i]! * drive);
  return x;
}

/** Bell-ish tone: a few inharmonic partials with exponential decay. */
export function bell(len: number, f: number, decay: number, partials: [number, number][] = [[1, 1], [2.76, 0.4], [5.4, 0.2], [8.9, 0.08]]): Float32Array {
  return mix(...partials.map(([m, g]) => [osc(len, () => f * m, 'sine', expDecay(decay * (1 + m * 0.3))), g] as [Float32Array, number]));
}

/** Exponential-decay noise impulse response for a ConvolverNode (stereo). */
export function impulseResponse(seconds: number, decay: number, bright = 6000): [Float32Array, Float32Array] {
  const L = lowpass(noiseBurst(seconds, (t) => Math.pow(1 - t / seconds, decay)), bright);
  const R = lowpass(noiseBurst(seconds, (t) => Math.pow(1 - t / seconds, decay)), bright);
  return [L, R];
}

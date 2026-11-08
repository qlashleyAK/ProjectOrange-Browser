export type Quality = 'low' | 'default' | 'high';
export type MouseMode = 'direct' | 'joystick';
/** auto = touch controls on phones/tablets, keyboard + mouse elsewhere */
export type ControlScheme = 'auto' | 'touch' | 'kbm';

export interface Settings {
  name: string;
  sensitivity: number;
  invertPitch: boolean;
  invertYaw: boolean;
  invertRoll: boolean;
  fov: number;
  cameraShake: boolean;
  assistDefault: boolean;
  mouseMode: MouseMode;
  deadzone: number;
  responseCurve: number;
  quality: Quality | 'auto';
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  reduceFlashing: boolean;
  highContrastReticle: boolean;
  hudScale: number;
  leadPip: boolean;
  damageNumbers: boolean;
  autoLevel: boolean;
  botSkill: 'easy' | 'normal' | 'hard';
  lastClass: 'dart' | 'mule' | 'scythe' | 'brute';
  firstVisit: boolean;
  thirdPerson: boolean;
  /** map for practice, new private rooms and quick play */
  arena: string;
  /** anonymous identity token from the last welcome — keeps your pilot across visits */
  token: string;
  controls: ControlScheme;
  /** touch look speed (drag on the right half of the screen) */
  touchLook: number;
}

const DEFAULTS: Settings = {
  name: '',
  sensitivity: 1,
  invertPitch: false,
  invertYaw: false,
  invertRoll: false,
  fov: 95,
  cameraShake: true,
  assistDefault: true,
  mouseMode: 'direct',
  deadzone: 0.15,
  responseCurve: 1.6,
  quality: 'auto',
  masterVolume: 0.8,
  sfxVolume: 0.9,
  musicVolume: 0.45,
  reduceFlashing: false,
  highContrastReticle: false,
  hudScale: 1,
  leadPip: true,
  damageNumbers: true,
  autoLevel: false,
  botSkill: 'normal',
  lastClass: 'dart',
  firstVisit: true,
  thirdPerson: true,
  arena: 'hollowdeep',
  token: '',
  controls: 'auto',
  touchLook: 1,
};

const KEY = 'orange.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export const settings: Settings = load();
const listeners = new Set<() => void>();

export function saveSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  for (const l of listeners) l();
}
export function onSettings(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function resetSettings(): void {
  Object.assign(settings, DEFAULTS, { name: settings.name, token: settings.token, firstVisit: false });
  saveSettings();
}

/**
 * Phones and tablets: a coarse primary pointer and no fine pointer anywhere (a touchscreen laptop keeps its
 * mouse/trackpad, so it stays on keyboard + mouse), or a mobile user agent. iPadOS reports as a Mac but has
 * maxTouchPoints > 1 and a coarse pointer, so it lands here too.
 */
export function detectTouchDevice(): boolean {
  const mq = (q: string) => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
  const coarseOnly = (navigator.maxTouchPoints ?? 0) > 0 && mq('(pointer: coarse)') && !mq('(any-pointer: fine)');
  return coarseOnly || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Whether to show on-screen touch controls (and skip pointer lock). */
export function touchMode(): boolean {
  return settings.controls === 'touch' || (settings.controls === 'auto' && detectTouchDevice());
}

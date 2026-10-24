import { BUILD_VERSION } from '@orange/shared';
import { copyText } from '../hud/hud';
import { resetSettings, saveSettings, settings, type Settings } from '../settings';

export interface MainMenuActions {
  quickPlay: () => void;
  practice: () => void;
  createPrivate: () => void;
  joinPrivate: (code: string) => void;
}

export interface PauseActions {
  resume: () => void;
  leave: () => void;
  inviteLink: string | null;
  online: boolean;
}

const KEYS: [string, string][] = [
  ['W / S', 'Thrust forward / back'], ['A / D', 'Strafe (double-tap: dodge)'], ['Space / Z', 'Up / down (Ctrl also down)'],
  ['Mouse', 'Pitch / yaw'], ['Q / E', 'Roll'], ['Shift', 'Boost'], ['F', 'Brake'], ['V + dir', 'Dodge'],
  ['LMB', 'Primary fire'], ['RMB', 'Hold to lock, release to fire'], ['R / MMB', 'Repel'], ['G / Mouse 4', 'Class ability'],
  ['X', 'Flight Assist toggle'], ['C', '1st / 3rd person'], ['Tab', 'Scoreboard (hold)'], ['H', 'Debug overlay'],
  ['1–4', 'Pick ship (when dead)'], ['Esc', 'Menu / release mouse'],
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

function button(parent: HTMLElement, label: string, sub: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = h('button', primary ? 'btn primary' : 'btn', parent, `${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}`);
  b.addEventListener('click', onClick);
  return b;
}

/** Main menu, pause menu, settings and status screens (DOM overlay). */
export class Menu {
  private root: HTMLDivElement;
  private panel: HTMLDivElement;
  private back: (() => void) | null = null;
  regionText = '';
  isOpen = false;

  constructor(container: HTMLElement) {
    this.root = h('div', 'overlay hidden', container);
    this.root.style.zIndex = '20';
    this.panel = h('div', 'panel interactive', this.root);
    this.panel.style.minWidth = '420px';
  }

  private open(): HTMLDivElement {
    this.isOpen = true;
    this.root.classList.remove('hidden');
    this.panel.innerHTML = '';
    return this.panel;
  }

  hide(): void { this.isOpen = false; this.root.classList.add('hidden'); this.back = null; }

  /** Esc inside a sub-screen returns to the previous screen; returns false if there is none. */
  goBack(): boolean { if (!this.back) return false; const b = this.back; this.back = null; b(); return true; }

  showMain(a: MainMenuActions, roomFromUrl: string | null): void {
    const p = this.open();
    this.back = null;
    h('h1', '', p, 'PROJECT <span class="orange">ORANGE</span>');
    h('div', 'sub', p, 'Six-degrees-of-freedom arena combat in the Hollowdeep Mine.');
    const row = h('div', 'row', p);
    h('label', '', row, 'Pilot name');
    const name = h('input', '', row) as HTMLInputElement;
    name.type = 'text'; name.maxLength = 16; name.placeholder = 'Pilot'; name.value = settings.name;
    name.addEventListener('change', () => { settings.name = name.value.trim().slice(0, 16); saveSettings(); });
    const commit = () => { settings.name = name.value.trim().slice(0, 16); saveSettings(); };

    if (roomFromUrl) button(p, `Join room ${roomFromUrl}`, 'Private match from your invite link', () => { commit(); a.joinPrivate(roomFromUrl); }, true);
    button(p, 'Quick Play', this.regionText || 'Join the fullest public match', () => { commit(); a.quickPlay(); }, !roomFromUrl);
    button(p, 'Practice vs bots', `Offline · ${settings.botSkill} bots · pausable`, () => { commit(); a.practice(); });
    button(p, 'Create private room', 'Get a code and an invite link', () => { commit(); a.createPrivate(); });
    const jr = h('div', 'row', p);
    const code = h('input', '', jr) as HTMLInputElement;
    code.type = 'text'; code.placeholder = 'Room code'; code.maxLength = 12;
    code.style.textTransform = 'uppercase';
    const jb = h('button', 'btn', jr, 'Join');
    jb.style.width = 'auto'; jb.style.margin = '0';
    const join = () => { const c = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c) { commit(); a.joinPrivate(c); } };
    jb.addEventListener('click', join);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    button(p, 'Settings', '', () => this.showSettings(() => this.showMain(a, roomFromUrl)));
    h('div', 'sub', p, `<span style="font-size:11px">Build ${BUILD_VERSION} · ${__BUILD_TIME__}</span>`).style.marginTop = '12px';
  }

  showPause(a: PauseActions): void {
    const p = this.open();
    this.back = null;
    h('h2', '', p, a.online ? 'MENU' : 'PAUSED');
    if (a.online) h('div', 'sub', p, 'The match keeps running while this menu is open.');
    button(p, 'Resume', 'Click to recapture the mouse', a.resume, true);
    if (a.inviteLink) {
      const link = a.inviteLink;
      button(p, 'Copy invite link', link, () => void copyText(link).then(() => { const b = p.querySelector('.copied'); if (b) b.textContent = 'Copied!'; }));
      h('div', 'sub copied', p, '');
    }
    button(p, 'Settings', '', () => this.showSettings(() => this.showPause(a)));
    button(p, 'Controls', '', () => this.showControls(() => this.showPause(a)));
    button(p, 'Leave match', '', a.leave);
  }

  showControls(back: () => void): void {
    const p = this.open();
    this.back = back;
    h('h2', '', p, 'CONTROLS');
    const k = h('div', 'keys', p);
    k.innerHTML = KEYS.map(([a, b]) => `<div><b>${esc(a)}</b>${esc(b)}</div>`).join('');
    h('div', 'sub', p, 'Gamepad: standard mapping — sticks fly, triggers fire, bumpers climb/dive, A + stick dodges.').style.marginTop = '12px';
    button(p, 'Back', '', back);
  }

  showMessage(title: string, sub: string, actions: { label: string; fn: () => void }[] = []): void {
    const p = this.open();
    this.back = null;
    h('h2', 'connecting', p, esc(title));
    if (sub) h('div', 'sub', p, esc(sub));
    actions.forEach((x, i) => button(p, x.label, '', x.fn, i === 0));
  }

  showSettings(back: () => void, tab: 'controls' | 'video' | 'audio' | 'access' | 'game' = 'controls'): void {
    const p = this.open();
    this.back = back;
    h('h2', '', p, 'SETTINGS');
    const tabs = h('div', 'tabs', p);
    const names: [typeof tab, string][] = [['controls', 'Controls'], ['video', 'Video'], ['audio', 'Audio'], ['access', 'Accessibility'], ['game', 'Gameplay']];
    for (const [id, label] of names) {
      const b = h('button', id === tab ? 'on' : '', tabs, label);
      b.addEventListener('click', () => this.showSettings(back, id));
    }
    const body = h('div', '', p);
    const range = (label: string, key: keyof Settings, min: number, max: number, step: number, fmt = (v: number) => v.toFixed(2)) => {
      const row = h('div', 'row', body);
      h('label', '', row, esc(label));
      const inp = h('input', '', row) as HTMLInputElement;
      inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step);
      inp.value = String(settings[key]);
      const out = h('span', '', row, fmt(settings[key] as number));
      out.style.minWidth = '44px'; out.style.textAlign = 'right';
      inp.addEventListener('input', () => {
        (settings as unknown as Record<string, unknown>)[key] = Number(inp.value);
        out.textContent = fmt(Number(inp.value));
        saveSettings();
      });
    };
    const check = (label: string, key: keyof Settings) => {
      const row = h('div', 'row', body);
      const lab = h('label', '', row, esc(label));
      lab.style.cursor = 'pointer';
      const inp = h('input', '', row) as HTMLInputElement;
      inp.type = 'checkbox'; inp.checked = settings[key] as boolean;
      inp.addEventListener('change', () => { (settings as unknown as Record<string, unknown>)[key] = inp.checked; saveSettings(); });
      lab.addEventListener('click', () => inp.click());
    };
    const select = (label: string, key: keyof Settings, opts: [string, string][]) => {
      const row = h('div', 'row', body);
      h('label', '', row, esc(label));
      const sel = h('select', '', row) as HTMLSelectElement;
      for (const [v, l] of opts) { const o = h('option', '', sel, esc(l)) as HTMLOptionElement; o.value = v; }
      sel.value = String(settings[key]);
      sel.addEventListener('change', () => { (settings as unknown as Record<string, unknown>)[key] = sel.value; saveSettings(); });
    };

    switch (tab) {
      case 'controls':
        range('Mouse sensitivity', 'sensitivity', 0.05, 5, 0.05);
        select('Mouse mode', 'mouseMode', [['direct', 'Direct (default)'], ['joystick', 'Virtual joystick (trackpads)']]);
        check('Invert pitch', 'invertPitch');
        check('Invert yaw', 'invertYaw');
        check('Invert roll', 'invertRoll');
        check('Flight Assist on by default', 'assistDefault');
        check('Auto-level (gentle roll return)', 'autoLevel');
        range('Controller deadzone', 'deadzone', 0, 0.5, 0.01);
        range('Controller response curve', 'responseCurve', 1, 3, 0.05);
        break;
      case 'video':
        select('Quality', 'quality', [['auto', 'Auto'], ['low', 'Low'], ['default', 'Default'], ['high', 'High']]);
        range('Field of view (horizontal)', 'fov', 60, 120, 1, (v) => `${v}°`);
        check('Camera shake', 'cameraShake');
        check('Third-person camera by default', 'thirdPerson');
        break;
      case 'audio':
        range('Master volume', 'masterVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`);
        range('Effects volume', 'sfxVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`);
        range('Music volume', 'musicVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`);
        break;
      case 'access':
        check('Reduce flashing', 'reduceFlashing');
        check('High-contrast reticle', 'highContrastReticle');
        range('HUD scale', 'hudScale', 0.75, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`);
        check('Lead indicator', 'leadPip');
        check('Damage numbers', 'damageNumbers');
        break;
      case 'game':
        select('Practice bot skill', 'botSkill', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']]);
        break;
    }
    const row = h('div', 'row', p);
    const reset = h('button', 'btn', row, 'Reset to defaults');
    reset.addEventListener('click', () => { resetSettings(); this.showSettings(back, tab); });
    const done = h('button', 'btn primary', row, 'Back');
    done.addEventListener('click', back);
  }
}

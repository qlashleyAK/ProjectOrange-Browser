import { arenaInfo, ARENAS, BUILD_VERSION, CLASSES, todayChallenge, type ClassId } from '@orange/shared';
import { copyText } from '../hud/hud';
import type { LeaderboardWindow, PilotProfile, ServerApi } from '../net/api';
import { resetSettings, saveSettings, settings, touchMode, type Settings } from '../settings';

export interface MainMenuActions {
  quickPlay: () => void;
  /** join today's daily challenge room */
  daily: () => void;
  practice: () => void;
  createPrivate: () => void;
  joinPrivate: (code: string) => void;
  mapChanged: (id: string) => void;
  /** the reachable game server's API, or null when there is none (offline: practice still works) */
  api: () => ServerApi | null;
}

const DAILY_MODES: Record<string, string> = { survival: 'Survival', 'score-attack': 'Score Attack', 'mine-run': 'Mine Run' };
const DAILY_BLURB: Record<string, string> = {
  survival: 'outlast the waves, no respawns', 'score-attack': '5 minutes, highest score', 'mine-run': 'fly the checkpoints, weapons offline',
};
type BoardTab = LeaderboardWindow | 'daily';
const RANKS = ['Nugget', 'Ensign', 'Lieutenant JG', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'Commander', 'Admiral'];

export interface PauseActions {
  resume: () => void;
  leave: () => void;
  inviteLink: string | null;
  online: boolean;
}

const KEYS: [string, string][] = [
  ['W / S', 'Thrust forward / back'], ['A / D', 'Strafe (double-tap: dodge)'], ['Space / Z', 'Up / down'],
  ['Mouse', 'Pitch / yaw'], ['Q / E', 'Roll'], ['Shift', 'Boost'], ['F', 'Brake'], ['V + dir', 'Dodge'],
  ['LMB', 'Primary fire'], ['RMB', 'Hold to lock, release to fire'], ['R / MMB', 'Repel'], ['G / Mouse 4', 'Class ability'],
  ['X', 'Flight Assist toggle'], ['C', '1st / 3rd person'], ['Tab', 'Scoreboard (hold)'], ['H', 'Debug overlay'],
  ['1–4', 'Pick ship (when dead)'], ['Esc', 'Menu / release mouse'],
];

const TOUCH_HELP: [string, string][] = [
  ['Left thumb', 'Move stick — appears where you touch'], ['Right side', 'Drag to look'], ['FIRE', 'Hold to shoot — drag it to aim'],
  ['LOCK', 'Hold to lock, release to fire missiles'], ['BOOST / BRAKE', 'Hold'], ['UP / DOWN', 'Climb / dive'],
  ['DODGE', 'Toward the stick'], ['ABILITY / REPEL', 'Tap'], ['☰ / ≡', 'Menu / scoreboard'],
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
  /** "N pilots online · M in matches", or null when unknown (no server) */
  presenceText: string | null = null;
  isOpen = false;
  /** which screen is showing ('main', 'pause', 'settings', ...; null when hidden) — read by the repro harness probe */
  screen: string | null = null;

  constructor(container: HTMLElement) {
    this.root = h('div', 'overlay hidden', container);
    this.root.style.zIndex = '20';
    this.panel = h('div', 'panel interactive', this.root);
    this.panel.style.minWidth = 'min(420px, calc(100vw - 16px))';
    // keyboard-first: ↑/↓ walk the buttons and fields of the open screen, Enter/Space activate (native)
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      const t = e.target;
      if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === 'range')) return;
      const items = [...this.panel.querySelectorAll<HTMLElement>('button:not(:disabled), input[type=text]')].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]!.focus();
    });
  }

  private open(screen: string): HTMLDivElement {
    this.screen = screen;
    this.isOpen = true;
    this.root.classList.remove('hidden');
    this.panel.innerHTML = '';
    // focus the screen's main action once it's built, so Enter does the obvious thing
    queueMicrotask(() => {
      if (this.screen !== screen) return;
      (this.panel.querySelector<HTMLElement>('.btn.primary') ?? this.panel.querySelector<HTMLElement>('.btn'))?.focus({ preventScroll: true });
    });
    return this.panel;
  }

  /** Update the presence line in place (no re-render: keeps focus and typed text). */
  setPresence(text: string | null): void {
    this.presenceText = text;
    const el = this.panel.querySelector<HTMLElement>('.presence');
    if (el) { el.textContent = text ?? ''; el.classList.toggle('hidden', !text); }
  }

  hide(): void { this.isOpen = false; this.screen = null; this.root.classList.add('hidden'); this.back = null; }

  /** Esc inside a sub-screen returns to the previous screen; returns false if there is none. */
  goBack(): boolean { if (!this.back) return false; const b = this.back; this.back = null; b(); return true; }

  showMain(a: MainMenuActions, roomFromUrl: string | null): void {
    const p = this.open('main');
    this.back = null;
    h('h1', '', p, 'PROJECT <span class="orange">ORANGE</span>');
    h('div', 'sub', p, 'Six-degrees-of-freedom arena combat.');
    const pres = h('div', 'presence', p, esc(this.presenceText ?? ''));
    pres.classList.toggle('hidden', !this.presenceText);
    // name + map: stacked normally, side by side on short (phone landscape) screens
    const fields = h('div', 'fields', p);
    const commit = this.nameRow(fields);

    const map = arenaInfo(settings.arena);
    const mapRow = h('div', 'row', fields);
    h('label', '', mapRow, 'First map');
    const sel = h('select', '', mapRow) as HTMLSelectElement;
    for (const m of ARENAS) { const o = h('option', '', sel, esc(m.name)) as HTMLOptionElement; o.value = m.id; }
    sel.value = map.id;
    sel.addEventListener('change', () => {
      commit();
      settings.arena = sel.value; saveSettings();
      a.mapChanged(sel.value);
      this.showMain(a, roomFromUrl);
    });
    h('div', 'sub map-blurb', p, `${esc(map.blurb)} · maps rotate every match`);

    const toMain = () => this.showMain(a, roomFromUrl);
    const list = h('div', 'main-btns', p);
    if (roomFromUrl) button(list, `Join room ${roomFromUrl}`, 'Private match from your invite link', () => { commit(); a.joinPrivate(roomFromUrl); }, true);
    button(list, 'Quick Match', this.regionText || 'Join the fullest public match', () => { commit(); a.quickPlay(); }, !roomFromUrl);
    const today = todayChallenge();
    button(list, 'Daily challenge', `${DAILY_MODES[today.mode]} — ${DAILY_BLURB[today.mode]} · same seed for everyone today`, () => { commit(); a.daily(); });
    button(list, 'Ranked', '1v1 duels · rank ladder · season 1', () => { commit(); this.showRanked(toMain); });
    button(list, 'Practice vs bots', `Starts on ${map.name} · offline · ${settings.botSkill} bots · pausable`, () => { commit(); a.practice(); });
    button(list, 'Private match', `Starts on ${map.name} · create a room or join by code`, () => { commit(); this.showPrivate(a, toMain); });
    const more = h('div', 'btn-row', p);
    button(more, 'Leaderboards', '', () => { commit(); this.showLeaderboards(a, toMain); });
    button(more, 'Profile', '', () => { commit(); this.showProfile(a, toMain); });
    button(more, 'Settings', '', () => { commit(); this.showSettings(toMain); });
    h('div', 'sub menu-hint', p, '↑ ↓ choose · Enter select · Esc back');
    h('div', 'sub', p, `<span style="font-size:11px">Build ${BUILD_VERSION} · ${__BUILD_TIME__}</span>`).style.marginTop = '4px';
  }

  /** Pilot name field; returns a commit() that saves what's typed (call before leaving the screen). */
  private nameRow(p: HTMLElement): () => void {
    const row = h('div', 'row', p);
    h('label', '', row, 'Pilot name');
    const name = h('input', '', row) as HTMLInputElement;
    name.type = 'text'; name.maxLength = 16; name.placeholder = 'Pilot'; name.value = settings.name;
    const commit = () => { settings.name = name.value.trim().slice(0, 16); saveSettings(); };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); name.blur(); } });
    return commit;
  }

  showPrivate(a: MainMenuActions, back: () => void): void {
    const p = this.open('private');
    this.back = back;
    h('h2', '', p, 'PRIVATE MATCH');
    h('div', 'sub', p, 'Friends join with the code or the invite link. Bots fill empty slots until they arrive.');
    button(p, 'Create private room', `Starts on ${arenaInfo(settings.arena).name} · get a code and an invite link`, a.createPrivate, true);
    const jr = h('div', 'row', p);
    const code = h('input', '', jr) as HTMLInputElement;
    code.type = 'text'; code.placeholder = 'Room code'; code.maxLength = 12;
    code.style.textTransform = 'uppercase';
    const jb = h('button', 'btn', jr, 'Join');
    jb.style.width = 'auto'; jb.style.margin = '0';
    const join = () => { const c = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c) a.joinPrivate(c); };
    jb.addEventListener('click', join);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    button(p, 'Back', '', back);
  }

  showRanked(back: () => void): void {
    const p = this.open('ranked');
    this.back = back;
    h('h2', '', p, 'RANKED');
    h('div', 'sub', p, 'One on one, best pilot wins. A rating ladder with seasons — the season\'s #1 holds the CAG title.');
    h('div', 'ranks', p, RANKS.map((r) => `<span>${esc(r)}</span>`).join('<i>›</i>'));
    h('div', 'sub', p, 'The duel queue opens with season 1. Until then, Quick Match and the leaderboards are where reputations are made.');
    button(p, 'Back', '', back, true);
  }

  showLeaderboards(a: MainMenuActions, back: () => void, win: BoardTab = 'week'): void {
    const p = this.open('leaderboards');
    this.back = back;
    h('h2', '', p, 'LEADERBOARDS');
    const tabs = h('div', 'tabs', p);
    const names: [BoardTab, string][] = [['daily', 'Daily'], ['day', 'Today'], ['week', 'This week'], ['alltime', 'All time']];
    for (const [id, label] of names) {
      const b = h('button', id === win ? 'on' : '', tabs, label);
      b.addEventListener('click', () => this.showLeaderboards(a, back, id));
    }
    const body = h('div', 'board', p, '<div class="sub">Loading…</div>');
    const daily = h('div', 'sub daily', p, '');
    button(p, 'Back', '', back, true);
    const api = a.api();
    if (!api) { body.innerHTML = '<div class="sub">Leaderboards need the game server. Practice vs bots works offline.</div>'; return; }
    const screen = this.screen;
    if (win === 'daily') {
      const c = todayChallenge();
      api.dailyLeaderboard(c.date).then((rows) => {
        if (this.screen !== screen) return;
        if (!rows.length) { body.innerHTML = `<div class="sub">No runs on today's ${DAILY_MODES[c.mode]} yet. Set the score to beat.</div>`; return; }
        const me = settings.name.trim().toLowerCase();
        body.innerHTML = `<table><thead><tr><th>#</th><th>Pilot</th><th>Score</th><th>Kills</th><th>Deaths</th><th>Oranges</th></tr></thead><tbody>${
          rows.map((r, i) => `<tr${me && r.handle.toLowerCase() === me ? ' class="me"' : ''}><td>${i + 1}</td><td>${esc(r.handle)}</td><td>${r.score}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.oranges}</td></tr>`).join('')
        }</tbody></table>`;
      }).catch(() => { if (this.screen === screen) body.innerHTML = '<div class="sub">Couldn\'t reach the daily board. Try again in a moment.</div>'; });
    } else api.leaderboard(win).then((rows) => {
      if (this.screen !== screen) return;
      if (!rows.length) { body.innerHTML = '<div class="sub">No finished matches in this window yet. Be the first on the board.</div>'; return; }
      const me = settings.name.trim().toLowerCase();
      body.innerHTML = `<table><thead><tr><th>#</th><th>Pilot</th><th>Kills</th><th>Deaths</th><th>K/D</th><th>Wins</th><th>Matches</th></tr></thead><tbody>${
        rows.map((r, i) => `<tr${me && r.handle.toLowerCase() === me ? ' class="me"' : ''}><td>${i + 1}</td><td>${esc(r.handle)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${(r.kills / Math.max(1, r.deaths)).toFixed(2)}</td><td>${r.wins}</td><td>${r.matches}</td></tr>`).join('')
      }</tbody></table>`;
    }).catch(() => { if (this.screen === screen) body.innerHTML = '<div class="sub">Couldn\'t reach the leaderboards. Try again in a moment.</div>'; });
    api.daily().then((d) => {
      if (this.screen === screen) daily.textContent = `Today's daily challenge: ${DAILY_MODES[d.mode] ?? d.mode} · seed ${d.seed.toString(16).toUpperCase()}`;
    }).catch(() => {});
  }

  showProfile(a: MainMenuActions, back: () => void): void {
    const p = this.open('profile');
    this.back = back;
    h('h2', '', p, 'PROFILE');
    this.nameRow(p);
    const body = h('div', 'profile', p, '<div class="sub">Loading…</div>');
    h('div', 'sub', p, 'No account: your pilot lives in this browser. Clearing site data starts a new one.').style.fontSize = '12px';
    button(p, 'Back', '', back, true);
    const api = a.api();
    if (!settings.token) { body.innerHTML = '<div class="sub">Fly one online match and your stats start here.</div>'; return; }
    if (!api) { body.innerHTML = '<div class="sub">Your stats live on the game server, which isn\'t reachable right now.</div>'; return; }
    const screen = this.screen;
    api.profile(settings.token).then((pr) => {
      if (this.screen !== screen) return;
      body.innerHTML = pr ? profileHtml(pr) : '<div class="sub">No finished online matches yet. Your stats appear after your first one.</div>';
    }).catch(() => { if (this.screen === screen) body.innerHTML = '<div class="sub">Couldn\'t load your stats. Try again in a moment.</div>'; });
  }

  showPause(a: PauseActions): void {
    const p = this.open('pause');
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
    const p = this.open('controls');
    this.back = back;
    h('h2', '', p, 'CONTROLS');
    if (touchMode()) {
      h('div', 'keys', p).innerHTML = TOUCH_HELP.map(([a, b]) => `<div><b>${esc(a)}</b>${esc(b)}</div>`).join('');
      h('div', 'sub', p, 'Keyboard + mouse and gamepads work too — switch in Settings → Controls.').style.marginTop = '12px';
      button(p, 'Back', '', back);
      return;
    }
    const k = h('div', 'keys', p);
    k.innerHTML = KEYS.map(([a, b]) => `<div><b>${esc(a)}</b>${esc(b)}</div>`).join('');
    h('div', 'sub', p, 'Gamepad: standard mapping — sticks fly, triggers fire, bumpers climb/dive, A + stick dodges.').style.marginTop = '12px';
    button(p, 'Back', '', back);
  }

  showMessage(title: string, sub: string, actions: { label: string; fn: () => void }[] = []): void {
    const p = this.open(`message:${title}`);
    this.back = null;
    h('h2', 'connecting', p, esc(title));
    if (sub) h('div', 'sub', p, esc(sub));
    actions.forEach((x, i) => button(p, x.label, '', x.fn, i === 0));
  }

  showSettings(back: () => void, tab: 'controls' | 'video' | 'audio' | 'access' | 'game' = 'controls'): void {
    const p = this.open('settings');
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
        select('Control scheme', 'controls', [['auto', 'Auto (touch on phones)'], ['touch', 'Touch screen'], ['kbm', 'Keyboard + mouse']]);
        if (touchMode()) range('Touch look speed', 'touchLook', 0.3, 3, 0.05);
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

function profileHtml(p: PilotProfile): string {
  const fav = p.classes[0];
  const favName = fav && fav.classId in CLASSES ? CLASSES[fav.classId as ClassId].name : '—';
  const acc = p.shots > 0 ? `${Math.round((100 * p.hits) / p.shots)}%` : '—';
  const hours = p.seconds / 3600;
  const stat = (label: string, value: string | number) => `<div><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`;
  return `<div class="stats">${[
    stat('Matches', p.matches), stat('Wins', p.wins), stat('Kills', p.kills), stat('Deaths', p.deaths),
    stat('K/D', (p.kills / Math.max(1, p.deaths)).toFixed(2)), stat('Assists', p.assists), stat('Accuracy', acc),
    stat('Oranges', p.oranges), stat('Peak power', p.peak_power), stat('Best finish', p.best_placement ? `#${p.best_placement}` : '—'),
    stat('Favorite ship', favName), stat('Flight time', hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(p.seconds / 60)} min`),
  ].join('')}</div>`;
}

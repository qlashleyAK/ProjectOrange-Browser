import * as THREE from 'three';
import {
  CLASSES, CLASS_LIST, KILLS_TO_WIN, MAX_POWER, nextTierUnits, PRIMARY_TABLE,
  type ClassId, type GameEvent, type RosterEntry,
} from '@orange/shared';
import { settings } from '../settings';
import { accentCss } from '../ships/materials';
import type { LocalState, MatchView, MissileView, NetStats, ShipView } from '../view';

const SHAPES: Record<ClassId, string> = { dart: 'tri', mule: 'square', scythe: 'diamond', brute: 'circle' };
const WEAPON_NAMES: Record<string, string> = {
  ...Object.fromEntries(PRIMARY_TABLE.map((w) => [w.id, w.name])),
  ...Object.fromEntries(CLASS_LIST.map((c) => [c.secondary.id, c.secondary.name])),
  collision: 'Collision', world: 'Collision',
};

export interface HudFrame {
  dt: number;
  time: number;
  camera: THREE.PerspectiveCamera;
  local: LocalState | null;
  localView: ShipView | null;
  ships: ShipView[];
  missiles: MissileView[];
  roster: RosterEntry[];
  match: MatchView;
  place: string | null;
  placeSub: string | null;
  net: NetStats | null;
  warning: string | null;
  assist: boolean;
  firstPerson: boolean;
  joystick: { x: number; y: number; radius: number } | null;
  losTo: (id: number) => boolean;
  debug: Record<string, string | number>;
  online: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
}

function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

interface Floater { el: HTMLElement; pos: THREE.Vector3; t: number; dur: number; rise: number }

export class Hud {
  private root: HTMLElement;
  private layer: HTMLElement;
  private reticle: HTMLElement;
  private spreadEl: SVGElement;
  private joyRing: HTMLElement;
  private joyDot: HTMLElement;
  private markers: HTMLElement[] = [];
  private markerLayer: HTMLElement;
  private lead: HTMLElement;
  private lockEl: HTMLElement;
  private arrows: HTMLElement[] = [];
  private hitmark: HTMLElement;
  private hitT = 0;
  private dmgArc: HTMLElement;
  private dmgArcT = 0;
  private hurt: HTMLElement;
  private hurtT = 0;
  private vitals: HTMLElement;
  private shieldBar: HTMLElement;
  private hullBar: HTMLElement;
  private shieldShimmer: HTMLElement;
  private vitalsLabel: HTMLElement;
  private protectedEl: HTMLElement;
  private safeEl: HTMLElement;
  private energyBar: HTMLElement;
  private ammoEl: HTMLElement;
  private abilityIcon: HTMLElement;
  private repelIcon: HTMLElement;
  private dodgeTick: HTMLElement;
  private assistEl: HTMLElement;
  private weaponName: HTMLElement;
  private power: HTMLElement;
  private pips: HTMLElement[] = [];
  private tierName: HTMLElement;
  private tierNext: HTMLElement;
  private threats: HTMLElement;
  private timer: HTMLElement;
  private score: HTMLElement;
  private banner: HTMLElement;
  private bannerT = 0;
  private location: HTMLElement;
  private killfeed: HTMLElement;
  private toasts: HTMLElement;
  private netwarn: HTMLElement;
  private hint: HTMLElement;
  private subtitle: HTMLElement;
  private subtitleT = 0;
  private cockpit: HTMLElement;
  private deathVignette: HTMLElement;
  private death: HTMLElement;
  private deathTitle: HTMLElement;
  private deathSub: HTMLElement;
  private cards = new Map<ClassId, HTMLElement>();
  private launchHint: HTMLElement;
  private scoreboard: HTMLElement;
  private post: HTMLElement;
  private debugEl: HTMLElement;
  private floaters: Floater[] = [];
  private floaterLayer: HTMLElement;
  private lastTier = -1;
  private flourishT = 0;
  private matchPointShown = false;
  private lastPhase = '';
  private lastCountdown = -1;
  private hintUntil = 0;
  showScoreboard = false;
  showDebug = false;
  visible = true;
  pickerOpen = false;
  selectedClass: ClassId = settings.lastClass;
  onPickClass: (c: ClassId) => void = () => {};
  onLaunch: () => void = () => {};
  onCountdown: (n: number) => void = () => {};
  /** shareable room link, shown on the post-match screen (online only) */
  inviteLink: string | null = null;
  private tmp = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.root = el('div', 'hud-root', container);
    this.cockpit = el('div', 'hidden', this.root);
    this.deathVignette = el('div', 'death-vignette hidden', this.root);
    this.hurt = el('div', 'hurt-flash', this.root);
    this.markerLayer = el('div', 'hud-layer', this.root);
    this.floaterLayer = el('div', 'hud-layer', this.root);
    this.layer = el('div', 'hud-layer scaled', this.root);

    this.reticle = el('div', 'reticle', this.layer);
    this.reticle.innerHTML = `<svg viewBox="-40 -40 80 80">
      <path class="c" d="M-14 0 H-5 M5 0 H14 M0 -14 V-5 M0 5 V14"/>
      <circle class="c" r="1.2"/>
      <g class="spread"><path d="M-22 -10 L-26 -10 L-26 10 L-22 10 M22 -10 L26 -10 L26 10 L22 10"/></g>
    </svg>`;
    this.spreadEl = this.reticle.querySelector('.spread') as SVGElement;
    this.joyRing = el('div', 'joy-ring hidden', this.root);
    this.joyDot = el('div', 'joy-dot hidden', this.root);
    this.lead = el('div', 'lead hidden', this.markerLayer);
    this.lockEl = el('div', 'lock hidden', this.markerLayer);
    this.hitmark = el('div', 'hitmark', this.layer);
    this.dmgArc = el('div', 'dmg-arc', this.layer);

    this.vitals = el('div', 'vitals', this.layer);
    this.protectedEl = el('div', 'protected hidden', this.vitals, 'SPAWN PROTECTED');
    this.safeEl = el('div', 'safe-zone hidden', this.vitals);
    const sb = el('div', 'bar', this.vitals);
    this.shieldBar = el('i', '', sb); this.shieldBar.style.background = 'var(--shield)';
    this.shieldShimmer = el('div', 'shimmer hidden', sb);
    const hb = el('div', 'bar', this.vitals);
    this.hullBar = el('i', '', hb);
    this.vitalsLabel = el('div', 'bar-label', this.vitals);

    this.weapons = el('div', 'weapons', this.layer);
    this.weaponName = el('div', 'bar-label', this.weapons);
    const eb = el('div', 'bar', this.weapons);
    this.energyBar = el('i', '', eb); this.energyBar.style.background = 'var(--energy)'; this.energyBar.style.right = '0'; this.energyBar.style.left = 'auto';
    this.ammoEl = el('div', 'ammo', this.weapons);
    const icons = el('div', 'icons', this.weapons);
    this.repelIcon = el('div', 'icon', icons, '<div class="ring"></div>REPEL<span class="key">R</span>');
    this.abilityIcon = el('div', 'icon', icons, '<div class="ring"></div><span class="lbl"></span><span class="key">G</span>');
    this.dodgeTick = el('div', 'dodge-tick', this.weapons);
    this.assistEl = el('div', 'assist', this.weapons);

    this.power = el('div', 'power', this.layer);
    const pipRow = el('div', 'pips', this.power);
    for (let i = 0; i < MAX_POWER; i++) this.pips.push(el('i', '', pipRow));
    this.tierName = el('div', 'tier-name', this.power);
    this.tierNext = el('div', 'tier-next', this.power);

    this.threats = el('div', 'threats', this.layer);
    const match = el('div', 'match', this.layer);
    this.timer = el('div', 'timer', match);
    this.score = el('div', 'score', match);
    this.banner = el('div', 'banner hidden', this.layer);
    this.location = el('div', 'location', this.layer);
    this.killfeed = el('div', 'killfeed', this.layer);
    this.toasts = el('div', 'toasts', this.layer);
    this.netwarn = el('div', 'netwarn hidden', this.layer);
    this.hint = el('div', 'hint hidden', this.layer);
    this.subtitle = el('div', 'subtitle hidden', this.layer);
    this.debugEl = el('div', 'debug hidden', this.root);

    // death screen
    this.death = el('div', 'overlay hidden', this.root);
    this.death.style.background = 'transparent';
    this.death.style.pointerEvents = 'none';
    const dp = el('div', 'panel', this.death);
    dp.style.background = 'rgba(8,12,18,.78)';
    dp.style.pointerEvents = 'auto';
    this.deathTitle = el('div', 'death-title', dp);
    this.deathSub = el('div', 'sub', dp);
    const grid = el('div', 'classes', dp);
    CLASS_LIST.forEach((c, i) => {
      const card = el('div', 'card', grid);
      const bar = (label: string, v: number) => `<div class="stat"><span>${label}</span><i><b style="width:${Math.round(v * 100)}%"></b></i></div>`;
      card.innerHTML = `<h3>${i + 1}. ${c.name.toUpperCase()}</h3><div class="arch">${c.faction === 'fleet' ? 'Fleet' : 'Machine'} · ${esc(c.archetype)}</div>
        ${bar('Speed', c.stats.speed)}${bar('Agility', c.stats.agility)}${bar('Armor', c.stats.armor)}${bar('Firepower', c.stats.firepower)}
        <div class="kit">${esc(c.primary.name)} · ${esc(c.secondary.name)} · ${esc(c.ability.name)}</div>`;
      card.addEventListener('click', () => this.pick(c.id));
      this.cards.set(c.id, card);
    });
    this.launchHint = el('div', 'sub', dp);
    this.launchHint.style.marginTop = '12px';
    const launch = el('button', 'btn primary', dp, 'LAUNCH <small>Space / click</small>');
    launch.addEventListener('click', () => this.onLaunch());

    this.scoreboard = el('div', 'overlay hidden', this.root);
    this.scoreboard.style.background = 'rgba(2,4,8,.35)';
    this.scoreboard.style.pointerEvents = 'none';
    this.post = el('div', 'overlay hidden', this.root);
    this.post.style.pointerEvents = 'none';
    this.post.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-invite]');
      if (b && this.inviteLink) void copyText(this.inviteLink).then(() => this.toast('INVITE LINK COPIED', '#fff'));
    });
    if (settings.firstVisit) this.hintUntil = performance.now() + 25000;
  }
  private weapons: HTMLElement;

  pick(c: ClassId): void {
    this.selectedClass = c;
    this.pickerOpen = true;
    for (const [id, card] of this.cards) card.classList.toggle('sel', id === c);
    this.onPickClass(c);
  }

  setVisible(v: boolean): void { this.visible = v; this.root.classList.toggle('hidden', !v); }

  // ------------------------------------------------------------------ events
  private nameOf(roster: RosterEntry[], id: number): string {
    const r = roster.find((x) => x.id === id);
    return r ? r.name : id < 0 ? 'the mine' : `#${id}`;
  }
  private colorOf(roster: RosterEntry[], id: number): string {
    const r = roster.find((x) => x.id === id);
    return r ? accentCss(r.accent) : '#aaa';
  }

  handleEvent(e: GameEvent, f: { localId: number; roster: RosterEntry[]; camera: THREE.Camera; attackerPos?: THREE.Vector3 | null }): void {
    const me = f.localId;
    switch (e.t) {
      case 'death': {
        const killer = e.killerId >= 0 && e.killerId !== e.victimId ? this.nameOf(f.roster, e.killerId) : null;
        const victim = this.nameOf(f.roster, e.victimId);
        const div = el('div', e.killerId === me || e.victimId === me ? 'me' : '', this.killfeed);
        const w = WEAPON_NAMES[e.weapon] ?? e.weapon;
        div.innerHTML = killer
          ? `<b style="color:${this.colorOf(f.roster, e.killerId)}">${esc(killer)}</b> <span style="color:var(--dim)">[${esc(w)}]</span> <b style="color:${this.colorOf(f.roster, e.victimId)}">${esc(victim)}</b>`
          : `<b style="color:${this.colorOf(f.roster, e.victimId)}">${esc(victim)}</b> <span style="color:var(--dim)">crashed</span>`;
        setTimeout(() => div.remove(), 6000);
        while (this.killfeed.children.length > 5) this.killfeed.firstElementChild?.remove();
        if (e.killerId === me && e.victimId !== me) {
          this.hitmark.classList.add('kill');
          this.hitT = 0.35;
          this.toast(`DESTROYED ${victim.toUpperCase()}`, '#fff');
        }
        if (e.victimId === me) {
          this.pickerOpen = false;
          for (const [id, card] of this.cards) card.classList.toggle('sel', id === this.selectedClass);
        }
        break;
      }
      case 'hit':
        if (e.attackerId === me && e.targetId !== me) {
          this.hitmark.classList.remove('kill');
          this.hitT = Math.max(this.hitT, 0.15);
          if (settings.damageNumbers) {
            const d = Math.round(e.shield + e.hull);
            if (d > 0) this.floater(`${d}`, new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), e.hull > 0 ? 'dmgnum' : 'dmgnum shield', 0.6, 2);
          }
        }
        if (e.targetId === me) {
          this.hurtT = 0.3;
          if (f.attackerPos) {
            const cam = f.camera;
            const local = f.attackerPos.clone().sub(cam.position).applyQuaternion(cam.quaternion.clone().invert());
            const ang = Math.atan2(local.x, -local.y);
            this.dmgArc.style.transform = `rotate(${ang}rad)`;
            this.dmgArcT = 0.8;
          }
        }
        break;
      case 'pickupTake':
        if (e.shipId === me) {
          this.floater(`+${e.units}`, new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), 'floater', 0.9, 4);
          this.toast(`+${e.units} ORANGE${e.units > 1 ? 'S' : ''}`, 'var(--orange)');
        }
        break;
      case 'tier':
        if (e.shipId === me) {
          if (e.gained) {
            const units = [2, 4, 6, 8, 10][e.index] ?? 0;
            this.toast(`TIER ${units} — ${e.name.toUpperCase()}`, 'var(--orange)', 2.2);
            this.flourishT = 1.2;
          } else this.toast(`POWER LOST — ${e.name.toUpperCase()}`, '#aaa');
        }
        break;
      case 'phase':
        if (e.phase === 'inProgress') this.showBanner('FIGHT!', `First to ${KILLS_TO_WIN} kills`, 1.6);
        break;
      default: break;
    }
  }

  toast(text: string, color: string, dur = 1.6): void {
    const t = el('div', 'toast', this.toasts, esc(text));
    t.style.color = color;
    setTimeout(() => { t.style.opacity = '0'; }, dur * 1000);
    setTimeout(() => t.remove(), dur * 1000 + 400);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
  }

  say(text: string, dur = 2): void {
    this.subtitle.textContent = text;
    this.subtitle.classList.remove('hidden');
    this.subtitleT = dur;
  }

  showBanner(text: string, sub = '', dur = 2): void {
    this.banner.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    this.banner.classList.remove('hidden');
    this.bannerT = dur;
  }

  private floater(text: string, pos: THREE.Vector3, cls: string, dur: number, rise: number): void {
    const e = el('div', cls, this.floaterLayer, esc(text));
    this.floaters.push({ el: e, pos, t: 0, dur, rise });
    if (this.floaters.length > 24) { const f = this.floaters.shift()!; f.el.remove(); }
  }

  // ------------------------------------------------------------------ per frame
  private project(p: THREE.Vector3, cam: THREE.Camera): { x: number; y: number; on: boolean; behind: boolean } {
    const v = this.tmp.copy(p).project(cam);
    const behind = v.z > 1;
    const x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    return { x, y, on: !behind && v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1, behind };
  }

  update(f: HudFrame): void {
    document.documentElement.style.setProperty('--hud-scale', String(settings.hudScale));
    this.root.classList.toggle('hc', settings.highContrastReticle);
    const L = f.local, cam = f.camera;
    const alive = !!L?.alive;
    const W = window.innerWidth, H = window.innerHeight;
    const post = f.match.phase === 'postMatch';

    // cockpit overlays
    const fpFaction = alive && f.firstPerson ? L!.def.faction : null;
    this.cockpit.className = fpFaction === 'fleet' ? 'cockpit-fleet' : fpFaction === 'machine' ? 'cockpit-machine' : 'hidden';
    this.deathVignette.classList.toggle('hidden', alive || post);
    this.layer.style.opacity = alive ? '1' : '0.35';

    // reticle
    this.reticle.classList.toggle('hidden', !alive);
    if (L) {
      const w = L.primary;
      const hasSpread = w.pattern !== 'single';
      this.spreadEl.style.display = hasSpread ? '' : 'none';
      if (hasSpread) {
        const px = Math.max(8, Math.tan((w.spreadDeg * Math.PI) / 180) / Math.tan((cam.fov * Math.PI) / 360) * (H / 2));
        this.spreadEl.setAttribute('transform', `scale(${Math.min(3, (px + 14) / 24)}, 1)`);
      }
    }
    const joy = f.joystick;
    this.joyRing.classList.toggle('hidden', !joy || !alive);
    this.joyDot.classList.toggle('hidden', !joy || !alive);
    if (joy) {
      this.joyRing.style.width = this.joyRing.style.height = `${joy.radius * 2}px`;
      this.joyRing.style.margin = `${-joy.radius}px 0 0 ${-joy.radius}px`;
      this.joyDot.style.left = `${W / 2 + joy.x}px`; this.joyDot.style.top = `${H / 2 + joy.y}px`;
    }

    // markers, lead pip, lock reticle, edge arrows
    let mi = 0, ai = 0;
    let best: { v: ShipView; d: number; ang: number } | null = null;
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const lv = f.localView;
    for (const s of f.ships) {
      if (!s.alive || s.isLocal || s.cloaked) continue;
      const p = new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z);
      const d = lv ? p.distanceTo(new THREE.Vector3(lv.pos.x, lv.pos.y, lv.pos.z)) : p.distanceTo(cam.position);
      const los = f.losTo(s.id);
      if (!los && !s.shimmer) continue;
      const scr = this.project(p, cam);
      const color = accentCss(s.accent);
      if (scr.on) {
        const m = this.markers[mi] ?? (this.markers[mi] = el('div', 'marker', this.markerLayer));
        mi++;
        m.style.display = '';
        m.style.left = `${scr.x}px`; m.style.top = `${scr.y - Math.min(60, 900 / Math.max(10, d))}px`;
        m.style.color = color;
        const near = d < 260;
        const key = `${s.classId}|${near ? s.name : ''}|${Math.round(s.hullFrac * 20)}|${Math.round(s.shieldFrac * 20)}|${s.power}|${s.shimmer}`;
        if (m.dataset.key !== key) {
          m.dataset.key = key;
          m.innerHTML = `<div class="shape ${SHAPES[s.classId]}"></div>${near ? `<div>${esc(s.name)}${s.power > 0 ? ` <span class="pw">●${s.power}</span>` : ''}</div>
            <div class="bars"><i style="width:${s.shieldFrac * 100}%;background:var(--shield);height:2px"></i><i style="top:2px;width:${s.hullFrac * 100}%;background:${s.hullFrac < 0.25 ? 'var(--hull-low)' : 'var(--hull)'};height:2px"></i></div>` : (s.power > 0 ? `<div class="pw">●${s.power}</div>` : '')}`;
        }
        m.style.opacity = s.shimmer ? '0.5' : '1';
        const ang = camFwd.angleTo(p.clone().sub(cam.position).normalize());
        if (d < 400 && ang < 0.26 && (!best || ang < best.ang)) best = { v: s, d, ang };
      } else if (los && d < 600) {
        const a = this.arrows[ai] ?? (this.arrows[ai] = el('div', 'edge-arrow', this.markerLayer));
        ai++;
        a.style.display = '';
        let dx = scr.x - W / 2, dy = scr.y - H / 2;
        if (scr.behind) { dx = -dx; dy = -dy; }
        const ang = Math.atan2(dy, dx);
        const r = Math.min(W, H) * 0.42;
        a.style.left = `${W / 2 + Math.cos(ang) * r - 8}px`; a.style.top = `${H / 2 + Math.sin(ang) * r - 7}px`;
        a.style.transform = `rotate(${ang + Math.PI / 2}rad)`;
        a.style.color = color;
      }
    }
    for (let i = mi; i < this.markers.length; i++) this.markers[i]!.style.display = 'none';
    for (let i = ai; i < this.arrows.length; i++) this.arrows[i]!.style.display = 'none';

    if (alive && settings.leadPip && best && L && lv) {
      const speed = L.primary.speed;
      const tp = new THREE.Vector3(best.v.pos.x, best.v.pos.y, best.v.pos.z);
      const tv = new THREE.Vector3(best.v.vel.x, best.v.vel.y, best.v.vel.z);
      const me = new THREE.Vector3(lv.pos.x, lv.pos.y, lv.pos.z);
      let t = tp.distanceTo(me) / speed;
      for (let k = 0; k < 2; k++) t = tp.clone().addScaledVector(tv, t).distanceTo(me) / speed;
      const lead = tp.addScaledVector(tv, t);
      const scr = this.project(lead, cam);
      this.lead.classList.toggle('hidden', !scr.on);
      this.lead.style.left = `${scr.x}px`; this.lead.style.top = `${scr.y}px`;
      this.lead.style.borderColor = settings.highContrastReticle ? '#fff' : '';
    } else this.lead.classList.add('hidden');

    if (alive && L && L.lockTarget >= 0) {
      const t = f.ships.find((s) => s.id === L.lockTarget);
      if (t && !t.cloaked) {
        const scr = this.project(new THREE.Vector3(t.pos.x, t.pos.y, t.pos.z), cam);
        const size = L.locked ? 34 : 110 - 70 * Math.min(1, L.lockProgress);
        this.lockEl.classList.toggle('hidden', !scr.on);
        this.lockEl.classList.toggle('solid', L.locked);
        this.lockEl.style.left = `${scr.x}px`; this.lockEl.style.top = `${scr.y}px`;
        this.lockEl.style.width = this.lockEl.style.height = `${size}px`;
      } else this.lockEl.classList.add('hidden');
    } else this.lockEl.classList.add('hidden');

    // hit marker / damage arc / hurt flash
    this.hitT = Math.max(0, this.hitT - f.dt);
    this.hitmark.style.opacity = String(Math.min(1, this.hitT * 8));
    this.dmgArcT = Math.max(0, this.dmgArcT - f.dt);
    this.dmgArc.style.opacity = String(Math.min(1, this.dmgArcT * 2));
    this.hurtT = Math.max(0, this.hurtT - f.dt);
    this.hurt.style.opacity = String(Math.min(settings.reduceFlashing ? 0.4 : 0.8, this.hurtT * 3));

    // floaters
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const fl = this.floaters[i]!;
      fl.t += f.dt;
      if (fl.t >= fl.dur) { fl.el.remove(); this.floaters.splice(i, 1); continue; }
      const p = fl.pos.clone(); p.y += fl.rise * fl.t;
      const scr = this.project(p, cam);
      fl.el.style.display = scr.on ? '' : 'none';
      fl.el.style.left = `${scr.x}px`; fl.el.style.top = `${scr.y}px`;
      fl.el.style.opacity = String(1 - fl.t / fl.dur);
    }

    if (L) this.updateVitals(f, L);

    // match
    const m = f.match;
    const myRow = f.roster.find((r) => r.id === L?.shipId);
    const leader = f.roster.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
    this.timer.textContent = m.phase === 'inProgress' ? fmtTime(m.timeLeft) : m.phase === 'warmup' ? `WARMUP ${Math.ceil(m.timeLeft)}` : m.phase === 'waiting' ? 'WAITING' : 'MATCH OVER';
    this.score.textContent = myRow && leader ? `You ${myRow.kills}  ·  Leader ${leader.kills}  ·  First to ${KILLS_TO_WIN}` : '';
    if (m.phase === 'warmup') {
      const n = Math.ceil(m.timeLeft);
      if (n !== this.lastCountdown && n > 0) { this.lastCountdown = n; this.showBanner(`WARMUP ${n}…`, 'Weapons safe', 1.05); this.onCountdown(n); }
    } else this.lastCountdown = -1;
    if (m.phase !== this.lastPhase) {
      if (m.phase === 'inProgress') this.matchPointShown = false;
      this.lastPhase = m.phase;
    }
    if (m.phase === 'inProgress' && leader && leader.kills === KILLS_TO_WIN - 1 && !this.matchPointShown) {
      this.matchPointShown = true;
      this.showBanner('MATCH POINT', `${leader.name} needs one more`, 2.2);
      this.say(`Announcer: Match point — ${leader.name}`, 2.2);
    }
    this.bannerT -= f.dt;
    if (this.bannerT <= 0) this.banner.classList.add('hidden');
    this.subtitleT -= f.dt;
    if (this.subtitleT <= 0) this.subtitle.classList.add('hidden');

    this.location.innerHTML = f.place ? `${esc(f.place)}${f.placeSub ? `<small>${esc(f.placeSub)}</small>` : ''}` : '';
    const net = f.net;
    const nw = f.warning ?? (net && (net.ping > 150 || net.loss > 0.02) ? `NETWORK: ${Math.round(net.ping)} ms${net.loss > 0.02 ? ` · ${Math.round(net.loss * 100)}% loss` : ''}` : null);
    this.netwarn.classList.toggle('hidden', !nw);
    if (nw) this.netwarn.textContent = nw;
    const showHint = performance.now() < this.hintUntil && alive;
    this.hint.classList.toggle('hidden', !showHint || !!nw);
    if (showHint) this.hint.textContent = 'Change ship: pick 1–4 on the respawn screen · Esc for controls';

    this.updateDeath(f);
    this.updateScoreboard(f);
    this.updatePost(f);
    this.debugEl.classList.toggle('hidden', !this.showDebug);
    if (this.showDebug) this.debugEl.textContent = Object.entries(f.debug).map(([k, v]) => `${k.padEnd(14)} ${v}`).join('\n');
  }

  private updateVitals(f: HudFrame, L: LocalState): void {
    const def = L.def;
    this.protectedEl.classList.toggle('hidden', !L.spawnProtected || L.safe);
    this.safeEl.classList.toggle('hidden', !L.inSafeZone);
    if (L.inSafeZone) {
      this.safeEl.classList.toggle('depleted', !L.safe);
      this.safeEl.textContent = L.safe
        ? `SAFE ZONE · WEAPONS OFFLINE · ${Math.ceil(L.safeCharge)}s`
        : 'SAFE ZONE DEPLETED — LEAVE TO RECHARGE';
    }
    this.shieldBar.style.width = `${(L.maxShield > 0 ? L.shield / L.maxShield : 0) * 100}%`;
    this.shieldShimmer.classList.toggle('hidden', !(L.shield < L.maxShield && L.alive && !L.cloaked));
    const hf = L.hull / def.hull;
    this.hullBar.style.width = `${hf * 100}%`;
    this.hullBar.style.background = hf < 0.25 ? 'var(--hull-low)' : 'var(--hull)';
    this.vitalsLabel.innerHTML = `<span>SHIELD ${Math.ceil(L.shield)}</span><span>HULL ${Math.ceil(L.hull)}</span>`;

    this.weaponName.innerHTML = `<span>${esc(L.secondary.name)}</span><span>${esc(L.primary.name)}</span>`;
    this.energyBar.style.width = `${(L.energy / def.energyMax) * 100}%`;
    const maxAmmo = Math.max(def.secondary.ammo + L.tier.bonusAmmo, L.ammo);
    const ammoKey = `${L.ammo}/${maxAmmo}`;
    if (this.ammoEl.dataset.k !== ammoKey) {
      this.ammoEl.dataset.k = ammoKey;
      this.ammoEl.innerHTML = Array.from({ length: maxAmmo }, (_, i) => `<i class="${i < L.ammo ? 'full' : ''}"></i>`).join('');
    }
    const ab = def.ability;
    const cdMax = ab.cooldown * L.tier.abilityCooldown;
    const abFrac = L.abilityActive > 0 ? L.abilityActive / ab.duration : 1 - Math.min(1, L.abilityCooldown / Math.max(0.01, cdMax));
    const abRing = this.abilityIcon.querySelector('.ring') as HTMLElement;
    abRing.style.background = `conic-gradient(${L.abilityActive > 0 ? '#a080ff' : 'var(--teal)'} ${abFrac * 360}deg, transparent 0)`;
    abRing.style.mask = abRing.style.webkitMask = 'radial-gradient(circle, transparent 60%, #000 62%)';
    (this.abilityIcon.querySelector('.lbl') as HTMLElement).textContent = ab.name.split(' ').pop()!.toUpperCase();
    this.abilityIcon.classList.toggle('ready', L.abilityCooldown <= 0 && L.abilityActive <= 0);
    this.abilityIcon.classList.toggle('active', L.abilityActive > 0);
    const repelOk = L.tier.repel;
    const rRing = this.repelIcon.querySelector('.ring') as HTMLElement;
    const rFrac = repelOk ? 1 - Math.min(1, L.repelCooldown / 12) : 0;
    rRing.style.background = `conic-gradient(var(--teal) ${rFrac * 360}deg, transparent 0)`;
    rRing.style.mask = rRing.style.webkitMask = 'radial-gradient(circle, transparent 60%, #000 62%)';
    this.repelIcon.classList.toggle('locked', !repelOk);
    this.repelIcon.classList.toggle('ready', repelOk && L.repelCooldown <= 0);
    this.dodgeTick.classList.toggle('ready', L.dodgeCooldown <= 0 && L.boostMeter >= 0.2);
    this.assistEl.textContent = `${f.assist ? 'ASSIST ON' : 'ASSIST OFF'} (X)  ·  BOOST ${Math.round(L.boostMeter * 100)}%${L.boostLocked ? ' (recharging)' : ''}`;

    const tierUnits = new Set(def.tiers.map((t) => t.units));
    this.pips.forEach((p, i) => {
      p.classList.toggle('on', i < L.power);
      p.classList.toggle('tier', tierUnits.has(i + 1));
    });
    this.tierName.textContent = L.tier.index >= 0 ? L.tier.name.toUpperCase() : 'UNPOWERED';
    const nxt = nextTierUnits(def, L.power);
    this.tierNext.textContent = nxt ? `next tier at ${nxt}` : 'MAX POWER';
    if (L.tier.index > this.lastTier && this.lastTier >= -1 && L.alive) this.flourishT = Math.max(this.flourishT, 0.01);
    this.lastTier = L.tier.index;
    this.flourishT = Math.max(0, this.flourishT - f.dt);
    this.power.classList.toggle('flourish', this.flourishT > 0);

    // threats
    let html = '';
    if (L.alive && L.missileWarn > 0) {
      let dir = '';
      const lv = f.localView;
      if (lv) {
        let bestD = Infinity, bestM: MissileView | null = null;
        for (const m of f.missiles) {
          if (m.ownerId === L.shipId) continue;
          const d = Math.hypot(m.pos.x - lv.pos.x, m.pos.y - lv.pos.y, m.pos.z - lv.pos.z);
          if (d < bestD) { bestD = d; bestM = m; }
        }
        if (bestM) {
          const local = new THREE.Vector3(bestM.pos.x, bestM.pos.y, bestM.pos.z).sub(f.camera.position).applyQuaternion(f.camera.quaternion.clone().invert());
          const a = Math.atan2(local.x, local.y);
          dir = ` <span style="display:inline-block;transform:rotate(${a}rad)">▲</span> ${Math.round(bestD)}m`;
        }
      }
      html += `<div class="warn">MISSILE${dir}</div>`;
    } else if (L.alive && L.lockWarn > 0) html += '<div class="warn locking">LOCKING</div>';
    if (this.threats.innerHTML !== html) this.threats.innerHTML = html;
  }

  private updateDeath(f: HudFrame): void {
    const L = f.local;
    const show = !!L && !L.alive && f.match.phase !== 'postMatch';
    this.death.classList.toggle('hidden', !show);
    if (!show || !L) return;
    const killer = L.killerId >= 0 && L.killerId !== L.shipId ? f.roster.find((r) => r.id === L.killerId) : null;
    this.deathTitle.textContent = killer ? `DESTROYED BY ${killer.name.toUpperCase()}` : 'DESTROYED';
    const wait = L.respawnIn > 0 ? `Respawn in ${L.respawnIn.toFixed(1)} s` : this.pickerOpen ? 'Ready' : 'Launching…';
    this.deathSub.textContent = `${wait}${this.pickerOpen ? `  ·  spawn held (${Math.ceil(L.holdLeft)} s)` : ''}`;
    for (const [id, card] of this.cards) card.classList.toggle('sel', id === this.selectedClass);
    this.launchHint.textContent = this.pickerOpen ? 'Press Space or click Launch when ready.' : 'Press 1–4 to change ship (holds your spawn up to 15 s).';
  }

  private updateScoreboard(f: HudFrame): void {
    const show = this.showScoreboard && f.match.phase !== 'postMatch';
    this.scoreboard.classList.toggle('hidden', !show);
    if (!show) return;
    const me = f.local?.shipId;
    const rows = f.roster.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.damage - a.damage);
    const html = `<div class="panel scoreboard"><h2>SCOREBOARD</h2><table><tr><th>Pilot</th><th>Ship</th><th>K</th><th>D</th><th>A</th><th>Power</th><th>Ping</th></tr>
      ${rows.map((r) => `<tr class="${r.id === me ? 'me' : ''}"><td style="color:${accentCss(r.accent)}">${esc(r.name)} ${r.isBot ? '<span class="bot">[BOT]</span>' : ''}${r.connected ? '' : ' <span class="bot">(reconnecting)</span>'}</td>
        <td>${CLASSES[r.classId].name}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td><td class="orange">${r.power}</td><td>${r.isBot ? '—' : f.online ? r.ping : '—'}</td></tr>`).join('')}
      </table></div>`;
    if (this.scoreboard.dataset.h !== html) { this.scoreboard.dataset.h = html; this.scoreboard.innerHTML = html; }
  }

  private updatePost(f: HudFrame): void {
    const show = f.match.phase === 'postMatch';
    this.post.classList.toggle('hidden', !show);
    if (!show) return;
    const me = f.local?.shipId;
    const rows = f.roster.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.damage - a.damage);
    const winner = rows.find((r) => r.id === f.match.winnerId) ?? rows[0];
    const mine = rows.find((r) => r.id === me);
    const p = (r: RosterEntry | undefined, cls: string) => r ? `<div class="${cls}"><div style="color:${accentCss(r.accent)};font-weight:800">${esc(r.name)}</div><div>${r.kills} kills</div></div>` : '';
    const acc = mine && mine.shotsFired > 0 ? Math.round((mine.shotsHit / mine.shotsFired) * 100) : 0;
    const html = `<div class="panel postmatch"><h1>${winner ? `${esc(winner.name.toUpperCase())} WINS` : 'MATCH OVER'}</h1>
      <div class="sub">Next match in ${Math.ceil(f.match.timeLeft)} s</div>
      <div class="podium">${p(rows[1], 'p2')}${p(rows[0], 'p1')}${p(rows[2], 'p3')}</div>
      ${mine ? `<div class="sub">You: ${mine.kills} K · ${mine.deaths} D · ${mine.assists} A · ${mine.damage} damage · ${acc}% accuracy · ${mine.oranges} oranges · peak power ${mine.peakPower}</div>` : ''}
      <table><tr><th>#</th><th>Pilot</th><th>Ship</th><th>K</th><th>D</th><th>A</th><th>Damage</th></tr>
      ${rows.map((r, i) => `<tr class="${r.id === me ? 'me' : ''}"><td>${i + 1}</td><td style="color:${accentCss(r.accent)}">${esc(r.name)} ${r.isBot ? '<span class="bot">[BOT]</span>' : ''}</td><td>${CLASSES[r.classId].name}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td><td>${r.damage}</td></tr>`).join('')}
      </table>${this.inviteLink ? '<button class="btn" data-invite style="margin-top:14px">COPY INVITE LINK</button>' : ''}</div>`;
    if (this.post.dataset.h !== html) { this.post.dataset.h = html; this.post.innerHTML = html; }
  }
}

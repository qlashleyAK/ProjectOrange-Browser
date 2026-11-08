import { InputFlag } from '@orange/shared';
import type { InputManager } from './input';

const STICK_RADIUS = 56;

interface ButtonDef {
  id: string;
  label: string;
  /** held flag while pressed, or a one-shot action on press */
  hold?: number;
  tap?: () => void;
  /** dragging from this button also looks (the fire button: aim while shooting) */
  look?: boolean;
}

/**
 * On-screen controls for phones and tablets.
 *
 * Left half: a floating move stick — it centres wherever the thumb lands. Right half: drag to look. Buttons
 * sit over the right thumb's arc (FIRE is the big one, and dragging from it keeps aiming), climb/dive sit
 * above the stick. Every finger is tracked by pointerId, so stick + look + fire work at the same time.
 * Everything lands in InputManager.touch / addTouchLook, so the sim sees the same InputCmd as from KBM.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private stickId = -1;
  private stickOrigin = { x: 0, y: 0 };
  private looks = new Map<number, { x: number; y: number }>();
  private holds = new Map<number, number>(); // pointerId → held flag
  private upHeld = new Set<number>();
  private downHeld = new Set<number>();
  visible = false;

  constructor(parent: HTMLElement, private input: InputManager, actions: { menu: () => void; scoreboard: (on: boolean) => void }) {
    this.root = div('touch hidden', parent);
    const lookZone = div('tc-look', this.root);
    const stickZone = div('tc-stick-zone', this.root);
    this.stickBase = div('tc-stick hidden', this.root);
    this.stickKnob = div('tc-knob', this.stickBase);
    div('rotate-hint', this.root).innerHTML = '<div>⟳</div><b>Turn your phone sideways</b><span>Project Orange plays in landscape</span>';

    // move stick
    stickZone.addEventListener('pointerdown', (e) => {
      if (this.stickId >= 0) return;
      e.preventDefault();
      stickZone.setPointerCapture(e.pointerId);
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.left = `${e.clientX}px`; this.stickBase.style.top = `${e.clientY}px`;
      this.stickBase.classList.remove('hidden');
      this.moveStick(e.clientX, e.clientY);
    });
    stickZone.addEventListener('pointermove', (e) => { if (e.pointerId === this.stickId) this.moveStick(e.clientX, e.clientY); });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.input.touch.x = 0; this.input.touch.y = 0;
      this.stickBase.classList.add('hidden');
    };
    stickZone.addEventListener('pointerup', endStick);
    stickZone.addEventListener('pointercancel', endStick);

    // look
    this.lookSurface(lookZone);

    // buttons
    const right = div('tc-buttons', this.root);
    const defs: ButtonDef[] = [
      { id: 'fire', label: 'FIRE', hold: InputFlag.Primary, look: true },
      { id: 'missile', label: 'LOCK', hold: InputFlag.Secondary },
      { id: 'boost', label: 'BOOST', hold: InputFlag.Boost },
      { id: 'dodge', label: 'DODGE', tap: () => this.input.touchDodge() },
      { id: 'ability', label: 'ABILITY', tap: () => this.input.latchTouch(InputFlag.Ability) },
      { id: 'repel', label: 'REPEL', tap: () => this.input.latchTouch(InputFlag.Repel) },
      { id: 'brake', label: 'BRAKE', hold: InputFlag.Brake },
    ];
    for (const d of defs) this.button(right, d);
    const climb = div('tc-climb', this.root);
    this.climbButton(climb, 'UP', this.upHeld);
    this.climbButton(climb, 'DOWN', this.downHeld);
    const top = div('tc-top', this.root);
    const menu = div('tc-btn tc-small', top); menu.textContent = '☰'; menu.setAttribute('aria-label', 'Menu');
    menu.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); actions.menu(); });
    const board = div('tc-btn tc-small', top); board.textContent = '≡'; board.setAttribute('aria-label', 'Scoreboard');
    board.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); actions.scoreboard(true); });
    const boardUp = () => actions.scoreboard(false);
    board.addEventListener('pointerup', boardUp);
    board.addEventListener('pointercancel', boardUp);
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }

  /** Flight controls only while flying: dead / between matches the HUD's own buttons (ship picker, podium) get the taps. */
  setFlying(on: boolean): void {
    if (this.root.classList.contains('dead') === !on) return;
    this.root.classList.toggle('dead', !on);
    if (!on) this.reset();
  }

  /** Dim ABILITY / REPEL while they can't fire (the HUD's cooldown rings are hidden on touch screens). */
  setReady(ability: boolean, repel: boolean): void {
    this.root.querySelector('.tc-ability')?.classList.toggle('cool', !ability);
    this.root.querySelector('.tc-repel')?.classList.toggle('cool', !repel);
  }

  /** Release every finger (menu opened, session ended). */
  reset(): void {
    this.stickId = -1;
    this.looks.clear(); this.holds.clear(); this.upHeld.clear(); this.downHeld.clear();
    this.input.touch.x = 0; this.input.touch.y = 0; this.input.touch.up = 0; this.input.touch.held = 0;
    this.stickBase.classList.add('hidden');
    for (const b of this.root.querySelectorAll('.tc-btn.on')) b.classList.remove('on');
  }

  private moveStick(x: number, y: number): void {
    let dx = x - this.stickOrigin.x, dy = y - this.stickOrigin.y;
    const l = Math.hypot(dx, dy);
    if (l > STICK_RADIUS) { dx *= STICK_RADIUS / l; dy *= STICK_RADIUS / l; }
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    // small dead zone, then linear: up on screen = forward
    const nx = dx / STICK_RADIUS, ny = -dy / STICK_RADIUS;
    const dead = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
    this.input.touch.x = dead(nx); this.input.touch.y = dead(ny);
  }

  private lookSurface(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    el.addEventListener('pointermove', (e) => this.lookMove(e));
    const end = (e: PointerEvent) => { this.looks.delete(e.pointerId); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private lookMove(e: PointerEvent): void {
    const last = this.looks.get(e.pointerId);
    if (!last) return;
    this.input.addTouchLook(e.clientX - last.x, e.clientY - last.y);
    last.x = e.clientX; last.y = e.clientY;
  }

  private button(parent: HTMLElement, d: ButtonDef): void {
    const b = div(`tc-btn tc-${d.id}`, parent);
    b.textContent = d.label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      b.classList.add('on');
      if (d.hold) { this.holds.set(e.pointerId, d.hold); this.syncHeld(); }
      if (d.tap) d.tap();
      if (d.look) this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    if (d.look) b.addEventListener('pointermove', (e) => this.lookMove(e));
    const end = (e: PointerEvent) => {
      b.classList.remove('on');
      this.holds.delete(e.pointerId); this.looks.delete(e.pointerId);
      this.syncHeld();
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
  }

  private climbButton(parent: HTMLElement, label: string, set: Set<number>): void {
    const b = div('tc-btn tc-climb-btn', parent);
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      set.add(e.pointerId); b.classList.add('on'); this.syncClimb();
    });
    const end = (e: PointerEvent) => { set.delete(e.pointerId); b.classList.remove('on'); this.syncClimb(); };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
  }

  private syncHeld(): void {
    let f = 0;
    for (const v of this.holds.values()) f |= v;
    this.input.touch.held = f;
  }

  private syncClimb(): void { this.input.touch.up = (this.upHeld.size ? 1 : 0) - (this.downHeld.size ? 1 : 0); }
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.appendChild(e);
  return e;
}

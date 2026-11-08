import { clamp, InputFlag, type InputCmd } from '@orange/shared';
import { settings } from '../settings';

export type UiAction = 'camera' | 'scoreboard' | 'scoreboardUp' | 'debug' | 'menu' | 'assist' | 'fullscreen';

const MOUSE_GAIN = 0.2;
const DOUBLE_TAP_MS = 250;
const JOY_RADIUS = 160;

// Ctrl is deliberately NOT a flight key: Ctrl held for "down" + W for thrust is Ctrl+W, which closes the tab
// and can't be cancelled by the page. Z is down.
const BLOCKED = new Set(['Tab', 'Space', 'ShiftLeft', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyZ', 'KeyF', 'KeyV',
  'KeyR', 'KeyG', 'KeyX', 'KeyC', 'KeyH', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Keyboard + pointer-lock mouse + gamepad, sampled once per simulation tick into an InputCmd. */
export class InputManager {
  private keys = new Set<string>();
  private mouseButtons = 0;
  private dx = 0;
  private dy = 0;
  private ticksLeft = 1;
  private joy = { x: 0, y: 0 };
  private latched = 0;
  private lastTap = new Map<string, number>();
  private seq = 0;
  private padPrev: boolean[] = [];
  private listeners = new Map<UiAction, Set<() => void>>();
  assist = settings.assistDefault;
  enabled = false;
  lastDevice: 'kbm' | 'pad' = 'kbm';

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseButtons = 0; });
    document.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  on(a: UiAction, fn: () => void): () => void {
    let set = this.listeners.get(a);
    if (!set) { set = new Set(); this.listeners.set(a, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }
  private emit(a: UiAction) { for (const fn of this.listeners.get(a) ?? []) fn(); }

  get pointerLocked(): boolean { return document.pointerLockElement === this.canvas; }
  requestLock(): void {
    if (this.pointerLocked) return;
    const p = this.canvas.requestPointerLock?.() as unknown;
    if (p instanceof Promise) p.catch(() => { /* user gesture required */ });
  }
  releaseLock(): void { if (this.pointerLocked) document.exitPointerLock(); }

  /** virtual joystick offset in pixels from screen center (for drawing the ring) */
  get joystick() { return settings.mouseMode === 'joystick' ? { ...this.joy, radius: JOY_RADIUS } : null; }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Escape') { this.emit('menu'); return; }
    if (!this.enabled) return;
    if (BLOCKED.has(e.code) || e.code.startsWith('Digit')) e.preventDefault();
    if (e.repeat) return;
    this.lastDevice = 'kbm';
    this.keys.add(e.code);
    switch (e.code) {
      case 'KeyR': this.latched |= InputFlag.Repel; break;
      case 'KeyG': this.latched |= InputFlag.Ability; break;
      case 'KeyX': this.assist = !this.assist; this.emit('assist'); break;
      case 'KeyC': this.emit('camera'); break;
      case 'Tab': this.emit('scoreboard'); break;
      case 'KeyH': this.emit('debug'); break;
      case 'F11': this.emit('fullscreen'); break;
      case 'KeyA': case 'KeyD': {
        const now = performance.now();
        const last = this.lastTap.get(e.code) ?? 0;
        if (now - last < DOUBLE_TAP_MS) { this.latched |= dodgeFlagFor(e.code); this.lastTap.set(e.code, 0); }
        else this.lastTap.set(e.code, now);
        if (this.keys.has('KeyV')) this.latched |= dodgeFlagFor(e.code);
        break;
      }
      case 'Space': case 'KeyZ':
        if (this.keys.has('KeyV')) this.latched |= dodgeFlagFor(e.code);
        break;
      case 'KeyV': {
        if (this.keys.has('KeyA')) this.latched |= InputFlag.DodgeL;
        else if (this.keys.has('KeyD')) this.latched |= InputFlag.DodgeR;
        else if (this.keys.has('Space')) this.latched |= InputFlag.DodgeU;
        else if (this.keys.has('KeyZ')) this.latched |= InputFlag.DodgeD;
        break;
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === 'Tab') { e.preventDefault(); this.emit('scoreboardUp'); }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked || !this.enabled) return;
    this.lastDevice = 'kbm';
    if (settings.mouseMode === 'joystick') {
      this.joy.x += e.movementX; this.joy.y += e.movementY;
      const l = Math.hypot(this.joy.x, this.joy.y);
      if (l > JOY_RADIUS) { this.joy.x *= JOY_RADIUS / l; this.joy.y *= JOY_RADIUS / l; }
    } else {
      this.dx += e.movementX; this.dy += e.movementY;
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (!this.pointerLocked) { this.requestLock(); return; }
    e.preventDefault();
    this.lastDevice = 'kbm';
    this.mouseButtons |= 1 << e.button;
    if (e.button === 1) this.latched |= InputFlag.Repel;
    if (e.button === 3) this.latched |= InputFlag.Ability;
  };
  private onMouseUp = (e: MouseEvent) => { this.mouseButtons &= ~(1 << e.button); };

  /** Called once per rendered frame with the number of ticks that frame will run. */
  beginFrame(ticks: number): void {
    this.ticksLeft = Math.max(1, ticks);
    this.pollPadButtons();
  }

  private k(code: string): number { return this.keys.has(code) ? 1 : 0; }

  sample(tick: number): InputCmd {
    const sens = settings.sensitivity;
    let pitch = 0, yaw = 0, roll = 0, fwd = 0, right = 0, up = 0, flags = 0;

    if (this.enabled) {
      // mouse: spread accumulated motion evenly over the ticks of this frame
      const share = 1 / this.ticksLeft;
      const mdx = this.dx * share, mdy = this.dy * share;
      this.dx -= mdx; this.dy -= mdy;
      this.ticksLeft = Math.max(1, this.ticksLeft - 1);
      if (settings.mouseMode === 'joystick') {
        const dead = 0.06;
        const jx = this.joy.x / JOY_RADIUS, jy = this.joy.y / JOY_RADIUS;
        yaw = Math.abs(jx) > dead ? jx * sens : 0;
        pitch = Math.abs(jy) > dead ? -jy * sens : 0;
      } else {
        yaw = mdx * sens * MOUSE_GAIN;
        pitch = -mdy * sens * MOUSE_GAIN;
      }
      yaw += this.k('ArrowRight') - this.k('ArrowLeft');
      pitch += this.k('ArrowUp') - this.k('ArrowDown');
      roll = this.k('KeyE') - this.k('KeyQ');
      fwd = this.k('KeyW') - this.k('KeyS');
      right = this.k('KeyD') - this.k('KeyA');
      up = this.k('Space') - this.k('KeyZ');
      if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) flags |= InputFlag.Boost;
      if (this.keys.has('KeyF')) flags |= InputFlag.Brake;
      if (this.mouseButtons & 1) flags |= InputFlag.Primary;
      if (this.mouseButtons & 4) flags |= InputFlag.Secondary;

      const pad = this.readPad();
      if (pad) {
        fwd += pad.fwd; right += pad.right; up += pad.up;
        yaw += pad.yaw * sens; pitch += pad.pitch * sens; roll += pad.roll;
        flags |= pad.flags;
      }
      flags |= this.latched;
      this.latched = 0;
    }

    if (settings.invertPitch) pitch = -pitch;
    if (settings.invertYaw) yaw = -yaw;
    if (settings.invertRoll) roll = -roll;
    if (this.assist) flags |= InputFlag.AssistOn;
    this.seq = (this.seq + 1) & 0xffff;
    return {
      seq: this.seq, tick,
      tFwd: clamp(fwd, -1, 1), tRight: clamp(right, -1, 1), tUp: clamp(up, -1, 1),
      rPitch: clamp(pitch, -1, 1), rYaw: clamp(yaw, -1, 1), rRoll: clamp(roll, -1, 1), flags,
    };
  }

  // ------------------------------------------------------------------ gamepad
  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private stick(x: number, y: number): [number, number] {
    const l = Math.hypot(x, y);
    const dz = settings.deadzone;
    if (l < dz) return [0, 0];
    const m = Math.pow(Math.min(1, (l - dz) / (1 - dz)), settings.responseCurve);
    return [(x / l) * m, (y / l) * m];
  }

  private pollPadButtons(): void {
    const p = this.pad();
    if (!p || !this.enabled) return;
    const b = p.buttons.map((x) => x.pressed);
    const pressed = (i: number) => !!b[i] && !this.padPrev[i];
    if (b.some((x) => x)) this.lastDevice = 'pad';
    if (pressed(3)) this.latched |= InputFlag.Repel;
    if (pressed(1)) this.latched |= InputFlag.Ability;
    if (pressed(12)) { this.assist = !this.assist; this.emit('assist'); }
    if (pressed(8)) this.emit('camera');
    if (pressed(9)) this.emit('scoreboard');
    if (!b[9] && this.padPrev[9]) this.emit('scoreboardUp');
    if (pressed(0)) {
      const [lx, ly] = this.stick(p.axes[0] ?? 0, p.axes[1] ?? 0);
      if (Math.abs(lx) >= Math.abs(ly) && lx !== 0) this.latched |= lx < 0 ? InputFlag.DodgeL : InputFlag.DodgeR;
      else if (ly !== 0) this.latched |= ly < 0 ? InputFlag.DodgeU : InputFlag.DodgeD;
      else this.latched |= InputFlag.DodgeU;
    }
    this.padPrev = b;
  }

  private readPad() {
    const p = this.pad();
    if (!p) return null;
    const [lx, ly] = this.stick(p.axes[0] ?? 0, p.axes[1] ?? 0);
    const [rx, ry] = this.stick(p.axes[2] ?? 0, p.axes[3] ?? 0);
    const btn = (i: number) => (p.buttons[i]?.pressed ? 1 : 0);
    const val = (i: number) => p.buttons[i]?.value ?? 0;
    if (lx || ly || rx || ry) this.lastDevice = 'pad';
    let flags = 0;
    if (btn(10)) flags |= InputFlag.Boost;
    if (btn(11)) flags |= InputFlag.Brake;
    if (val(7) > 0.4) flags |= InputFlag.Primary;
    if (val(6) > 0.4) flags |= InputFlag.Secondary;
    return {
      fwd: -ly, right: lx, up: btn(5) - btn(4),
      yaw: rx, pitch: -ry, roll: btn(15) - btn(14), flags,
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
  }
}

function dodgeFlagFor(code: string): number {
  switch (code) {
    case 'KeyA': return InputFlag.DodgeL;
    case 'KeyD': return InputFlag.DodgeR;
    case 'Space': return InputFlag.DodgeU;
    default: return InputFlag.DodgeD;
  }
}

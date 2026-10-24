export const enum InputFlag {
  Boost = 1 << 0,
  Brake = 1 << 1,
  Primary = 1 << 2,
  Secondary = 1 << 3,
  Repel = 1 << 4,
  Ability = 1 << 5,
  DodgeL = 1 << 6,
  DodgeR = 1 << 7,
  DodgeU = 1 << 8,
  DodgeD = 1 << 9,
  AssistOn = 1 << 10,
}

export const ONE_SHOT_FLAGS = InputFlag.Primary | InputFlag.Secondary | InputFlag.Repel | InputFlag.Ability
  | InputFlag.DodgeL | InputFlag.DodgeR | InputFlag.DodgeU | InputFlag.DodgeD;

export interface InputCmd {
  seq: number;
  tick: number;
  tFwd: number; tRight: number; tUp: number;
  rPitch: number; rYaw: number; rRoll: number;
  flags: number;
}

export function neutralInput(seq = 0, tick = 0, assist = true): InputCmd {
  return { seq, tick, tFwd: 0, tRight: 0, tUp: 0, rPitch: 0, rYaw: 0, rRoll: 0, flags: assist ? InputFlag.AssistOn : 0 };
}

export function copyInput(o: InputCmd, a: InputCmd): InputCmd {
  o.seq = a.seq; o.tick = a.tick; o.tFwd = a.tFwd; o.tRight = a.tRight; o.tUp = a.tUp;
  o.rPitch = a.rPitch; o.rYaw = a.rYaw; o.rRoll = a.rRoll; o.flags = a.flags; return o;
}

export const hasFlag = (c: InputCmd, f: InputFlag) => (c.flags & f) !== 0;

/** Wrap-safe u16 sequence comparison: a > b. */
export function seqGreater(a: number, b: number): boolean {
  return ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;
}
export function seqDiff(a: number, b: number): number {
  const d = (a - b) & 0xffff;
  return d >= 0x8000 ? d - 0x10000 : d;
}

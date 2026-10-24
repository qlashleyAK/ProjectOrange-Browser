/** Loft cross-section shared by the client hull builder and server colliders. */
export interface LoftSection { z: number; halfW: number; halfH: number; yOff: number; xOff?: number }

/** Superellipse ring points (x, y) for a section. */
export function superellipseRing(s: LoftSection, ringPoints: number, exponent: number): [number, number][] {
  const out: [number, number][] = [];
  const e = 2 / exponent;
  for (let i = 0; i < ringPoints; i++) {
    const t = (i / ringPoints) * Math.PI * 2;
    const c = Math.cos(t), sn = Math.sin(t);
    const x = Math.sign(c) * Math.pow(Math.abs(c), e) * s.halfW + (s.xOff ?? 0);
    const y = Math.sign(sn) * Math.pow(Math.abs(sn), e) * s.halfH + s.yOff;
    out.push([x, y]);
  }
  return out;
}

export const BRUTE_HULL_SECTIONS: LoftSection[] = [
  { z: -4.6, halfW: 1.6, halfH: 0.9, yOff: -0.2 },
  { z: -3.0, halfW: 2.4, halfH: 1.5, yOff: 0 },
  { z: -0.5, halfW: 2.8, halfH: 1.8, yOff: 0.1 },
  { z: 2.5, halfW: 2.7, halfH: 1.7, yOff: 0.1 },
  { z: 4.8, halfW: 2.0, halfH: 1.3, yOff: 0 },
  { z: 5.6, halfW: 1.6, halfH: 1.0, yOff: 0 },
];
export const BRUTE_HULL_EXPONENT = 2.5;

export const MULE_BODY_SECTIONS: LoftSection[] = [
  { z: -4.8, halfW: 0.9, halfH: 0.45, yOff: -0.15 },
  { z: -3.6, halfW: 1.25, halfH: 0.8, yOff: 0 },
  { z: -1.0, halfW: 1.45, halfH: 1.1, yOff: 0.05 },
  { z: 2.0, halfW: 1.5, halfH: 1.15, yOff: 0.05 },
  { z: 3.2, halfW: 1.45, halfH: 1.1, yOff: 0.05 },
];

export function loftHullPoints(sections: LoftSection[], ringPoints: number, exponent: number): number[] {
  const pts: number[] = [];
  for (const s of sections) for (const [x, y] of superellipseRing(s, ringPoints, exponent)) pts.push(x, y, s.z);
  return pts;
}

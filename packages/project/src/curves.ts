// Keyframe curves: how a value moves from one keyframe to the next. Named curves (the old
// smooth / linear / hold plus ease in, ease out, overshoot and bounce) and custom Bézier curves
// with two handles, like CSS cubic-bezier(x1, y1, x2, y2). A keyframe has one curve for every
// value, and can override it for a group of values (framing, position and size, colour, effects).

export type CurveName = 'smooth' | 'linear' | 'hold' | 'ease-in' | 'ease-out' | 'overshoot' | 'bounce';
export type Easing = CurveName | 'custom';
/** Two handles: (x1, y1) leaving the first keyframe, (x2, y2) arriving at the next. x is 0–1. */
export type Bezier = [number, number, number, number];
export interface Curve { easing: Easing; bezier?: Bezier }

/** Groups of values a keyframe can give their own curve. */
export type KeyGroup = 'view' | 'xf' | 'grade' | 'fx';
export const KEY_GROUPS: [KeyGroup, string][] = [
  ['view', 'Framing'],
  ['xf', 'Position and size'],
  ['grade', 'Colour'],
  ['fx', 'Effects'],
];

export const CURVES: [CurveName, string][] = [
  ['smooth', 'Ease in and out'],
  ['linear', 'Linear'],
  ['ease-in', 'Ease in'],
  ['ease-out', 'Ease out'],
  ['overshoot', 'Overshoot'],
  ['bounce', 'Bounce'],
  ['hold', 'Hold'],
];
const NAMES = new Set<string>([...CURVES.map(([n]) => n), 'custom']);
export const isEasing = (e: unknown): e is Easing => typeof e === 'string' && NAMES.has(e);

/** Smoothstep-style ease in/out with zero velocity at both keys (the original "smooth"). */
export const easeInOut = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);

/** Handles that draw (or, for smooth, closely match) a named curve; null when no Bézier can. */
export function curveHandles(name: Easing): Bezier | null {
  switch (name) {
    case 'smooth': return [0.5, 0, 0.5, 1];
    case 'linear': return [0, 0, 1, 1];
    case 'ease-in': return [0.55, 0, 1, 0.45];
    case 'ease-out': return [0, 0.55, 0.45, 1];
    case 'overshoot': return [0.34, 1.56, 0.64, 1];
    default: return null;
  }
}

/** y of a cubic Bézier from (0,0) to (1,1) at x (handles' x are kept within 0–1, so x → t is one-to-one). */
export function bezierAt(b: Bezier, x: number): number {
  const x1 = clamp01(b[0]), x2 = clamp01(b[2]);
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * b[1], by = 3 * (b[3] - b[1]) - cy, ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t;
  const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const e = X(t) - x, d = dX(t);
    if (Math.abs(e) < 1e-7) break;
    if (Math.abs(d) < 1e-6) { t = NaN; break; }
    t -= e / d;
  }
  if (!(t >= 0 && t <= 1)) {
    // Newton failed (flat spots): bisect.
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      t = (lo + hi) / 2;
      if (X(t) < x) lo = t; else hi = t;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}

/** A ball dropped on the next value: three bounces, each lower. */
function bounce(f: number) {
  const n = 7.5625, d = 2.75;
  if (f < 1 / d) return n * f * f;
  if (f < 2 / d) return n * (f -= 1.5 / d) * f + 0.75;
  if (f < 2.5 / d) return n * (f -= 2.25 / d) * f + 0.9375;
  return n * (f -= 2.625 / d) * f + 0.984375;
}

/** How far (0 → 1, overshoot can go past) the value has moved at fraction f of the way. */
export function evalCurve(c: Curve, f: number): number {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  switch (c.easing) {
    case 'hold': return 0;
    case 'linear': return f;
    case 'smooth': return easeInOut(f);
    case 'bounce': return bounce(f);
    case 'custom': return c.bezier ? bezierAt(c.bezier, f) : easeInOut(f);
    default: return bezierAt(curveHandles(c.easing)!, f);
  }
}

/** A Bézier made safe: four finite numbers, x within 0–1, y within −1…2. */
export function cleanBezier(b: unknown): Bezier | undefined {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  const y = (v: number) => Math.max(-1, Math.min(2, v));
  return [clamp01(b[0]), y(b[1]), clamp01(b[2]), y(b[3])];
}

/** A curve loaded from a file, made safe (unknown names become smooth). */
export function cleanCurve(c: Partial<Curve> | undefined): Curve {
  const easing = isEasing(c?.easing) ? c!.easing : 'smooth';
  const bezier = easing === 'custom' ? cleanBezier(c?.bezier) ?? [0.5, 0, 0.5, 1] : undefined;
  return bezier ? { easing, bezier } : { easing };
}

/** Points along a curve for drawing it (x, y pairs; y can leave 0–1). */
export function curvePoints(c: Curve, n = 48): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    // Hold jumps at the end.
    out.push([x, c.easing === 'hold' ? (i === n ? 1 : 0) : evalCurve(c, x)]);
  }
  return out;
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

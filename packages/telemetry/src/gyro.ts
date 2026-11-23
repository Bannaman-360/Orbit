// Camera orientation between frames. The camera writes one orientation per frame (CORI); the
// gyroscope runs hundreds of times a second. Integrating the gyro from frame to frame, and
// pinning it to CORI at every frame, gives the fast shake that happens while one picture is
// being read off the sensor (rolling shutter).

import type { Vec3 } from '@ace/media360';
import { type TimedQuat, type TimedVec3 } from './orientation';

export type Quat = [number, number, number, number];
export const qmul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export const qconj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];
/** Rotation vector (axis × angle, radians) ↔ quaternion. */
export function qexp(v: Vec3): Quat {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-9) return [1, v[0] / 2, v[1] / 2, v[2] / 2];
  const s = Math.sin(a / 2) / a;
  return [Math.cos(a / 2), v[0] * s, v[1] * s, v[2] * s];
}
export function qlog(qIn: Quat): Vec3 {
  const q: Quat = qIn[0] < 0 ? [-qIn[0], -qIn[1], -qIn[2], -qIn[3]] : qIn;
  const s = Math.hypot(q[1], q[2], q[3]);
  if (s < 1e-9) return [2 * q[1], 2 * q[2], 2 * q[3]];
  const a = 2 * Math.atan2(s, q[0]);
  return [(q[1] / s) * a, (q[2] / s) * a, (q[3] / s) * a];
}
export const qnorm = (q: Quat): Quat => { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };

/** How the gyro's axes and clock relate to CORI's. */
export interface GyroFit {
  /** For each orientation axis: which gyro axis, and its sign. */
  axes: [number, number, number];
  signs: [number, number, number];
  /** Added to gyro times, µs. */
  offsetUs: number;
  /** Rotation applied before (true) or after the frame's own orientation. */
  body: boolean;
  /** Gyro units → radians per second. */
  scale: number;
  /** Part of the frame-to-frame motion the gyro fails to explain (0 = perfect). */
  residual: number;
}

/** Running integral of the gyro, for quick averages over any interval. */
class Integral {
  private t: Float64Array;
  private c: Float64Array[];
  constructor(g: TimedVec3[]) {
    const n = g.length;
    this.t = new Float64Array(n);
    this.c = [0, 1, 2].map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      this.t[i] = g[i]!.t;
      if (!i) continue;
      const dt = (g[i]!.t - g[i - 1]!.t) / 1e6;
      for (let k = 0; k < 3; k++) this.c[k]![i] = this.c[k]![i - 1]! + ((g[i]!.v[k]! + g[i - 1]!.v[k]!) / 2) * dt;
    }
  }
  at(time: number): Vec3 {
    const { t, c } = this, n = t.length;
    if (time <= t[0]!) return [0, 0, 0];
    if (time >= t[n - 1]!) return [c[0]![n - 1]!, c[1]![n - 1]!, c[2]![n - 1]!];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m]! <= time) lo = m; else hi = m; }
    const f = (time - t[lo]!) / (t[hi]! - t[lo]! || 1);
    return [0, 1, 2].map((k) => c[k]![lo]! + (c[k]![hi]! - c[k]![lo]!) * f) as Vec3;
  }
}

const PERMS: [number, number, number][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/**
 * Works out the gyro's axes, clock offset and units by comparing it with the camera's own
 * frame-to-frame orientation. Null when the two don't clearly agree (or nothing moves).
 */
export function fitGyro(cori: TimedQuat[], gyro: TimedVec3[], searchUs = 90_000): GyroFit | null {
  if (cori.length < 20 || gyro.length < 60) return null;
  const G = new Integral(gyro);
  const step = Math.max(1, Math.floor(cori.length / 500));
  const moves: { t0: number; t1: number; body: Vec3; world: Vec3 }[] = [];
  for (let i = 0; i + 1 < cori.length; i += step) {
    const a = cori[i]!, b = cori[i + 1]!;
    if (b.t - a.t > 200_000) continue;
    moves.push({ t0: a.t, t1: b.t, body: qlog(qmul(qconj(a.q), b.q)), world: qlog(qmul(b.q, qconj(a.q))) });
  }
  let energy = 0;
  for (const m of moves) energy += m.body[0] ** 2 + m.body[1] ** 2 + m.body[2] ** 2;
  if (energy / Math.max(1, moves.length) < 1e-8) return null;
  let best: GyroFit | null = null;
  const tryOffset = (offsetUs: number) => {
    for (const body of [true, false]) {
      // Cross-products between every orientation axis and every gyro axis.
      const cross = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      let gg = 0;
      for (const m of moves) {
        const p = G.at(m.t0 - offsetUs), q = G.at(m.t1 - offsetUs);
        const g = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], o = body ? m.body : m.world;
        gg += g[0]! ** 2 + g[1]! ** 2 + g[2]! ** 2;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cross[r * 3 + c]! += o[r]! * g[c]!;
      }
      if (gg < 1e-12) continue;
      for (const axes of PERMS) {
        const vals = axes.map((c, r) => cross[r * 3 + c]!);
        const sum = vals.reduce((s, v) => s + Math.abs(v), 0);
        const scale = sum / gg;
        const residual = Math.max(0, 1 - (sum * sum) / (gg * energy));
        if (!best || residual < best.residual) best = { axes, signs: vals.map((v) => (v < 0 ? -1 : 1)) as [number, number, number], offsetUs, body, scale, residual };
      }
    }
  };
  for (let o = -searchUs; o <= searchUs; o += 3000) tryOffset(o);
  const coarse = (best as GyroFit | null)?.offsetUs ?? 0;
  for (let o = coarse - 2500; o <= coarse + 2500; o += 500) tryOffset(o);
  const f = best as GyroFit | null;
  // Units must be plausible: rad/s (1) or deg/s (0.01745).
  return f && f.residual < 0.2 && ((f.scale > 0.7 && f.scale < 1.4) || (f.scale > 0.0125 && f.scale < 0.0245)) ? f : null;
}

/**
 * Orientation several times per frame: gyro in between, exactly CORI at every frame.
 * `perFrame` steps per frame interval.
 */
export function denseOrientation(cori: TimedQuat[], gyro: TimedVec3[], fit: GyroFit, perFrame = 10): TimedQuat[] {
  const G = new Integral(gyro);
  const delta = (a: number, b: number): Vec3 => {
    const p = G.at(a - fit.offsetUs), q = G.at(b - fit.offsetUs);
    return [0, 1, 2].map((r) => (q[fit.axes[r]!]! - p[fit.axes[r]!]!) * fit.signs[r]! * fit.scale) as Vec3;
  };
  const out: TimedQuat[] = [];
  for (let i = 0; i + 1 < cori.length; i++) {
    const a = cori[i]!, b = cori[i + 1]!;
    const steps: Quat[] = [[...a.q] as Quat];
    let q = [...a.q] as Quat;
    const h = (b.t - a.t) / perFrame;
    for (let k = 1; k <= perFrame; k++) {
      const d = qexp(delta(a.t + (k - 1) * h, a.t + k * h));
      q = qnorm(fit.body ? qmul(q, d) : qmul(d, q));
      steps.push(q);
    }
    // Spread what the gyro got wrong evenly over the interval, so it lands exactly on CORI.
    const err = fit.body ? qlog(qmul(qconj(steps[perFrame]!), b.q as Quat)) : qlog(qmul(b.q as Quat, qconj(steps[perFrame]!)));
    for (let k = 0; k < perFrame; k++) {
      const f = k / perFrame, e = qexp([err[0] * f, err[1] * f, err[2] * f]);
      out.push({ t: a.t + k * h, q: qnorm(fit.body ? qmul(steps[k]!, e) : qmul(e, steps[k]!)) });
    }
  }
  if (cori.length) out.push(cori[cori.length - 1]!);
  return out;
}

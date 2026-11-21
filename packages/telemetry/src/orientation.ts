// Turns GoPro orientation telemetry into a correction matrix for the 360 renderer.
// Pure functions, no Node or DOM dependencies.
//
// GRAV: gravity direction in camera coordinates (~frame rate). Used for horizon
//       leveling: roll and pitch are removed, the direction you face (yaw) is kept.
// CORI: camera orientation quaternion relative to the first frame. Used for full
//       stabilisation (the view stays locked to where the camera pointed at the start).

import { type Mat3, type Vec3, IDENTITY, mulMat, normalize, quatToMat, rotationBetween, transpose } from '@ace/media360';

export interface TimedVec3 { t: number; v: Vec3 }
export interface TimedQuat { t: number; q: [number, number, number, number] }

/** Orientation streams on the media timeline (t in microseconds). */
export interface OrientationData {
  grav: TimedVec3[];
  cori: TimedQuat[];
  /** Every stream key found in the file, for diagnostics. */
  streams: string[];
}

export type StabilizeMode = 'off' | 'horizon' | 'lock';

/**
 * How GoPro's sensor axes map onto ours (+x right, +y up, +z forward).
 * Each entry picks a source axis and sign, e.g. ['-y', 'z', 'x'].
 * Default confirmed on GoPro Max 2 footage (GRAV has +y pointing down). Note it is
 * a reflection, not a rotation: GRAV's reported frame is not right-handed in our
 * convention. Still to be confirmed on the original Max.
 */
export type AxisMap = [string, string, string];
export const DEFAULT_AXIS_MAP: AxisMap = ['x', '-y', 'z'];

export function axisMapMatrix(map: AxisMap): Mat3 {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Mat3;
  map.forEach((src, row) => {
    const sign = src.startsWith('-') ? -1 : 1;
    const axis = 'xyz'.indexOf(src.replace('-', ''));
    if (axis < 0) throw new Error(`Bad axis "${src}"`);
    m[row * 3 + axis] = sign;
  });
  return m;
}

function bracket<T extends { t: number }>(arr: T[], t: number): [T, T, number] | null {
  if (!arr.length) return null;
  if (t <= arr[0]!.t) return [arr[0]!, arr[0]!, 0];
  const last = arr[arr.length - 1]!;
  if (t >= last.t) return [last, last, 0];
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.t <= t) lo = mid; else hi = mid;
  }
  const a = arr[lo]!, b = arr[hi]!;
  return [a, b, (t - a.t) / (b.t - a.t || 1)];
}

export function gravityAt(data: OrientationData, t: number): Vec3 | null {
  const br = bracket(data.grav, t);
  if (!br) return null;
  const [a, b, f] = br;
  return normalize([a.v[0] + (b.v[0] - a.v[0]) * f, a.v[1] + (b.v[1] - a.v[1]) * f, a.v[2] + (b.v[2] - a.v[2]) * f]);
}

export function orientationAt(data: OrientationData, t: number): [number, number, number, number] | null {
  const br = bracket(data.cori, t);
  if (!br) return null;
  const [a, b, f] = br;
  // nlerp, taking the short way round.
  const s = a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3] < 0 ? -1 : 1;
  const q = a.q.map((v, i) => v + (s * b.q[i]! - v) * f) as [number, number, number, number];
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n) as [number, number, number, number];
}

export interface CorrectionOptions {
  mode: StabilizeMode;
  axisMap: AxisMap;
  /** Use the inverse rotation (for sensor conventions that report world→camera). */
  invert?: boolean;
}

/** Camera body orientation at time t, ready for ReframeRenderer's `correction`. */
export function correctionAt(data: OrientationData | null, t: number, opts: CorrectionOptions): Mat3 {
  if (!data || opts.mode === 'off') return IDENTITY;
  const P = axisMapMatrix(opts.axisMap);
  let R: Mat3 | null = null;
  if (opts.mode === 'horizon') {
    const g = gravityAt(data, t);
    if (g) {
      const gc = normalize(mulVec3(P, g));
      R = rotationBetween(gc, [0, -1, 0]);
    }
  } else {
    const q = orientationAt(data, t);
    if (q) R = mulMat(mulMat(P, quatToMat(q)), transpose(P));
  }
  if (!R) return IDENTITY;
  return opts.invert ? transpose(R) : R;
}

function mulVec3(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Moving average over ±radius samples; removes sensor jitter from gravity. */
export function smoothGravity(samples: TimedVec3[], radius = 5): TimedVec3[] {
  return samples.map((s, i) => {
    let x = 0, y = 0, z = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(samples.length - 1, i + radius); j++) {
      const v = samples[j]!.v;
      x += v[0]; y += v[1]; z += v[2];
    }
    return { t: s.t, v: normalize([x, y, z]) };
  });
}

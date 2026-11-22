// Turns GoPro orientation telemetry into a correction matrix for the 360 renderer.
// Pure functions, no Node or DOM dependencies.
//
// GRAV: gravity direction in camera coordinates (~frame rate). Used for horizon
//       leveling: roll and pitch are removed, the direction you face (yaw) is kept.
// CORI: camera orientation quaternion relative to the first frame. Used for full
//       stabilisation (the view stays locked to where the camera pointed at the start).

import { type Mat3, type Vec3, IDENTITY, mulMat, normalize, quatToMat, rotationBetween, transpose } from '@ace/media360';
import type { GpsSample } from './metrics';

export interface TimedVec3 { t: number; v: Vec3 }
export interface TimedQuat { t: number; q: [number, number, number, number] }

/** Orientation streams on the media timeline (t in microseconds). */
export interface OrientationData {
  grav: TimedVec3[];
  cori: TimedQuat[];
  /**
   * Image orientation relative to the camera body (GoPro IORI): a rotation the camera
   * already applied to the recorded picture. The picture's orientation is CORI combined
   * with IORI, so stabilisation must use both.
   */
  iori?: TimedQuat[];
  /** GPS fixes (for speed, altitude, distance and the map overlay). */
  gps?: GpsSample[];
  /** Accelerometer, m/s² (for the G-force overlay). */
  accl?: TimedVec3[];
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

// ---------------------------------------------------------------------------
// Stabilisation levels (like GoPro Quik): smooth the camera's orientation path and
// cancel only the difference between the real path and the smooth one. Bumps and
// shake disappear; intentional turns remain. "locked" cancels all rotation.

export type Smoothing = 'off' | 'low' | 'medium' | 'high' | 'locked' | 'custom';

/** Gaussian smoothing window (σ, seconds) per level. */
export const SMOOTHING_SIGMA_S: Record<Exclude<Smoothing, 'off' | 'locked' | 'custom'>, number> = { low: 0.1, medium: 0.3, high: 0.8 };

/** Range of the custom smoothing window (σ, seconds). */
export const CUSTOM_SIGMA_RANGE = { min: 0.02, max: 30 } as const;

export interface StabilizeOptions {
  smoothing: Smoothing;
  /** Smoothing window (σ, seconds) when smoothing is 'custom'. */
  strength?: number;
  /** Level the horizon (roll and pitch) using gravity, after smoothing. */
  horizon: boolean;
  axisMap: AxisMap;
  /** Treat CORI as world→camera instead of camera→world. */
  invertCori?: boolean;
}

export const DEFAULT_STABILIZE: StabilizeOptions = { smoothing: 'off', horizon: false, axisMap: DEFAULT_AXIS_MAP };

type Quat = [number, number, number, number];

/**
 * Gaussian-weighted quaternion average around each sample (normalised).
 * Signs are made continuous along the path first, so the weighted sum is a plain
 * convolution; three box-filter passes approximate the Gaussian in O(n) at any width.
 * Near the ends the window is truncated and renormalised.
 */
export function smoothQuats(samples: TimedQuat[], sigmaUs: number): TimedQuat[] {
  const n = samples.length;
  if (n < 2) return samples;
  const dt = (samples[n - 1]!.t - samples[0]!.t) / (n - 1) || 16_683;
  const sigma = sigmaUs / dt; // in samples
  // Continuous signs.
  const ch = [0, 1, 2, 3].map(() => new Float64Array(n));
  let prev = samples[0]!.q;
  for (let i = 0; i < n; i++) {
    let q = samples[i]!.q;
    if (q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    for (let c = 0; c < 4; c++) ch[c]![i] = q[c]!;
    prev = q;
  }
  const weight = new Float64Array(n).fill(1);
  // Box width for 3 passes giving variance σ²: w² = 4σ² + 1 (odd widths).
  const half = Math.max(0, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const box = (src: Float64Array) => {
    const out = new Float64Array(n);
    let acc = 0;
    for (let j = 0; j <= Math.min(n - 1, half); j++) acc += src[j]!;
    for (let i = 0; i < n; i++) {
      out[i] = acc;
      const add = i + half + 1, drop = i - half;
      if (add < n) acc += src[add]!;
      if (drop >= 0) acc -= src[drop]!;
    }
    return out;
  };
  const blur = (x: Float64Array) => (half > 0 ? box(box(box(x))) : x);
  const w = blur(weight);
  const sm = ch.map(blur);
  return samples.map((s, i) => {
    const q = [sm[0]![i]! / w[i]!, sm[1]![i]! / w[i]!, sm[2]![i]! / w[i]!, sm[3]![i]! / w[i]!];
    const len = Math.hypot(...q) || 1;
    return { t: s.t, q: q.map((v) => v / len) as Quat };
  });
}

export interface CoriFit {
  axisMap: AxisMap;
  invert: boolean;
  /** 0 = gravity perfectly steady in the world frame; higher is worse. */
  score: number;
}

const SIGNED_AXES = ['x', '-x', 'y', '-y', 'z', '-z'];

/** All 48 signed axis permutations. */
export function allAxisMaps(): AxisMap[] {
  const out: AxisMap[] = [];
  for (const a of SIGNED_AXES)
    for (const b of SIGNED_AXES)
      for (const c of SIGNED_AXES) {
        const used = [a, b, c].map((s) => s.replace('-', ''));
        if (new Set(used).size === 3) out.push([a, b, c]);
      }
  return out;
}

/**
 * Works out how CORI's axes and direction relate to ours, from the footage itself.
 * With the right mapping, the camera's gravity reading rotated into the world frame
 * points the same way all the time; we pick the mapping where it is steadiest.
 * Needs some tilting/rolling in the clip to tell candidates apart.
 */
export function fitCoriMapping(data: OrientationData, gravMap: AxisMap = DEFAULT_AXIS_MAP): CoriFit[] {
  if (!data.cori.length || !data.grav.length) return [];
  const Pg = axisMapMatrix(gravMap);
  const step = Math.max(1, Math.floor(data.cori.length / 300));
  const pairs: { q: Quat; g: Vec3 }[] = [];
  for (let i = 0; i < data.cori.length; i += step) {
    const { t, q } = data.cori[i]!;
    const g = gravityAt(data, t);
    if (g) pairs.push({ q, g: normalize(mulVec3(Pg, g)) });
  }
  const fits: CoriFit[] = [];
  for (const axisMap of allAxisMaps()) {
    const P = axisMapMatrix(axisMap);
    const Pt = transpose(P);
    for (const invert of [false, true]) {
      const sum: Vec3 = [0, 0, 0];
      for (const { q, g } of pairs) {
        let R = mulMat(mulMat(P, quatToMat(q)), Pt);
        if (invert) R = transpose(R);
        const w = mulVec3(R, g);
        sum[0] += w[0]; sum[1] += w[1]; sum[2] += w[2];
      }
      const meanLen = Math.hypot(...sum) / pairs.length; // 1 = perfectly consistent
      fits.push({ axisMap, invert, score: 1 - meanLen });
    }
  }
  return fits.sort((a, b) => a.score - b.score);
}

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
const qconj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];

/**
 * How IORI combines with CORI: 0 ignore, 1 C·I, 2 C·I⁻¹, 3 I·C, 4 I⁻¹·C.
 * Measured on Max 2 footage: I·C leaves the least residual motion (Locked view
 * jitter 0.79 → 0.34 px/frame; the other orders are worse than ignoring IORI).
 */
export type IoriMode = 0 | 1 | 2 | 3 | 4;
export const DEFAULT_IORI_MODE: IoriMode = 3;

/** CORI samples turned into the picture's orientation using IORI (sample-aligned). */
export function imageOrientation(data: OrientationData, mode: IoriMode): TimedQuat[] {
  const iori = data.iori;
  if (!mode || !iori?.length) return data.cori;
  return data.cori.map(({ t, q }) => {
    const i = (orientationAt({ ...data, cori: iori }, t) ?? [1, 0, 0, 0]) as Quat;
    const c = q as Quat;
    const r = mode === 1 ? qmul(c, i) : mode === 2 ? qmul(c, qconj(i)) : mode === 3 ? qmul(i, c) : qmul(qconj(i), c);
    return { t, q: r };
  });
}

/** Precomputes smoothed paths so per-frame lookups are cheap. */
export class Stabilizer {
  private smoothed = new Map<string, OrientationData>();
  /** How this file's CORI maps onto our axes (fitted from the footage, see fitCoriMapping). */
  readonly coriFit: CoriFit | null;

  /** Orientation of the recorded picture (CORI combined with IORI); used for stabilisation. */
  readonly image: OrientationData | null;

  constructor(readonly data: OrientationData | null, ioriMode: IoriMode = DEFAULT_IORI_MODE) {
    const fits = data ? fitCoriMapping(data) : [];
    // Only trust the fit when it is clearly consistent; otherwise fall back to the gravity mapping.
    this.coriFit = fits[0] && fits[0].score < 0.02 ? fits[0] : null;
    this.image = data ? { ...data, cori: imageOrientation(data, ioriMode) } : null;
  }

  get hasOrientation() {
    return !!this.data?.cori.length;
  }
  get hasGravity() {
    return !!this.data?.grav.length;
  }

  private path(level: Smoothing, strength?: number): OrientationData | null {
    if (!this.data || level === 'off') return null;
    const sigma =
      level === 'locked' ? 0
      : level === 'custom' ? Math.min(CUSTOM_SIGMA_RANGE.max, Math.max(CUSTOM_SIGMA_RANGE.min, strength ?? SMOOTHING_SIGMA_S.medium))
      : SMOOTHING_SIGMA_S[level];
    const key = level === 'locked' ? 'locked' : sigma.toFixed(3);
    let p = this.smoothed.get(key);
    if (!p) {
      const src = this.image!;
      const cori = level === 'locked' ? src.cori.slice(0, 1) : smoothQuats(src.cori, sigma * 1e6);
      p = { ...src, cori };
      // Keep the cache small while a slider is being dragged.
      if (this.smoothed.size > 12) this.smoothed.delete(this.smoothed.keys().next().value!);
      this.smoothed.set(key, p);
    }
    return p;
  }

  /** CORI quaternion → camera-to-world rotation in our axes. */
  private toOursFn(opts: Pick<StabilizeOptions, 'axisMap' | 'invertCori'>) {
    const Pc = axisMapMatrix(this.coriFit?.axisMap ?? opts.axisMap);
    const Pct = transpose(Pc);
    const invert = this.coriFit ? this.coriFit.invert !== !!opts.invertCori : !!opts.invertCori;
    return (q: Quat): Mat3 => {
      const m = mulMat(mulMat(Pc, quatToMat(q)), Pct);
      return invert ? transpose(m) : m;
    };
  }

  /** Camera body orientation relative to the stabilised path; pass to the renderer. */
  correctionAt(t: number, opts: StabilizeOptions): Mat3 {
    if (!this.data) return IDENTITY;
    const P = axisMapMatrix(opts.axisMap);
    const toOurs = this.toOursFn(opts);

    // C maps camera coordinates into the stabilised (smoothed-path) frame: C = Sᵀ·R.
    let C: Mat3 = IDENTITY;
    const smooth = this.path(opts.smoothing, opts.strength);
    const qr = orientationAt(this.image!, t);
    const qs = smooth ? orientationAt(smooth, t) : null;
    if (qr && qs) C = mulMat(transpose(toOurs(qs)), toOurs(qr));

    if (opts.horizon) {
      // Gravity in camera coordinates. With orientation data, carry one clip-wide
      // "down" through the camera's measured rotation: smooth and drift-free. The raw
      // gravity sensor is noisy frame to frame and would make the horizon jitter.
      let gCam: Vec3 | null = null;
      const down = qr ? this.worldDown(opts, toOurs) : null;
      if (qr && down) gCam = mulVec3(transpose(toOurs(qr)), down);
      else {
        const g = gravityAt(this.data, t);
        if (g) gCam = normalize(mulVec3(P, g));
      }
      if (gCam) {
        const gs = normalize(mulVec3(C, gCam));
        C = mulMat(rotationBetween(gs, [0, -1, 0]), C);
      }
    }
    return C;
  }

  private downCache = new Map<string, Vec3>();
  /** Average gravity direction in the world (orientation-data) frame over the whole clip. */
  private worldDown(opts: StabilizeOptions, toOurs: (q: Quat) => Mat3): Vec3 | null {
    const key = `${opts.axisMap.join()}|${opts.invertCori}`;
    const hit = this.downCache.get(key);
    if (hit) return hit;
    if (!this.data?.grav.length || !this.data.cori.length) return null;
    const P = axisMapMatrix(opts.axisMap);
    const sum: Vec3 = [0, 0, 0];
    for (const { t, q } of this.data.cori) {
      const g = gravityAt(this.data, t);
      if (!g) continue;
      const w = mulVec3(toOurs(q), normalize(mulVec3(P, g)));
      sum[0] += w[0]; sum[1] += w[1]; sum[2] += w[2];
    }
    const d = normalize(sum);
    this.downCache.set(key, d);
    return d;
  }
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

/**
 * Puts the orientation data on the video's clock. GoPro writes one CORI sample per
 * video frame, but the timestamps gopro-telemetry derives are shifted (≈43 ms on the
 * Max 2, measured against image motion). When the counts match, sample i belongs to
 * frame i; otherwise the first sample is aligned with the first frame. GRAV gets the
 * same shift. `frameTimes` are presentation times in µs, sorted.
 */
export function alignToFrames(data: OrientationData, frameTimes: number[]): OrientationData & { syncOffsetUs: number } {
  if (!data.cori.length || !frameTimes.length) return { ...data, syncOffsetUs: 0 };
  const perFrame = Math.abs(data.cori.length - frameTimes.length) <= 2;
  const n = Math.min(data.cori.length, frameTimes.length);
  let offset = 0;
  for (let i = 0; i < (perFrame ? n : 1); i++) offset += data.cori[i]!.t - frameTimes[i]!;
  offset /= perFrame ? n : 1;
  const cori = data.cori.map((s, i) => ({ t: perFrame && i < frameTimes.length ? frameTimes[i]! : s.t - offset, q: s.q }));
  const grav = data.grav.map((s) => ({ t: s.t - offset, v: s.v }));
  const ioriPerFrame = !!data.iori && Math.abs(data.iori.length - frameTimes.length) <= 2;
  const iori = data.iori?.map((s, i) => ({ t: ioriPerFrame && i < frameTimes.length ? frameTimes[i]! : s.t - offset, q: s.q }));
  const gps = data.gps?.map((s) => ({ ...s, t: s.t - offset }));
  const accl = data.accl?.map((s) => ({ t: s.t - offset, v: s.v }));
  return { ...data, cori, grav, iori, gps, accl, syncOffsetUs: offset };
}

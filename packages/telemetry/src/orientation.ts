// Turns GoPro orientation telemetry into a correction matrix for the 360 renderer.
// Pure functions, no Node or DOM dependencies.
//
// GRAV: gravity direction in camera coordinates (~frame rate). Used for horizon
//       leveling: roll and pitch are removed, the direction you face (yaw) is kept.
// CORI: camera orientation quaternion relative to the first frame. Used for full
//       stabilisation (the view stays locked to where the camera pointed at the start).

import { type Mat3, type Vec3, IDENTITY, mulMat, normalize, quatToMat, rotationBetween, transpose } from '@ace/media360';
import { denseOrientation, fitGyro, type GyroFit } from './gyro';
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
  /** Gyroscope at full rate (regular clips only; for rolling shutter). */
  gyro?: TimedVec3[];
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
export const SMOOTHING_SIGMA_S: Record<Exclude<Smoothing, 'off' | 'locked' | 'custom'>, number> = { low: 0.05, medium: 0.1, high: 0.3 };

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
  /**
   * Direction lock: the view holds one direction in the world. Overrides smoothing and
   * horizon: the picture is fully locked and level (the direction itself is the view's job).
   */
  lock?: { yaw: number; pitch: number };
}

/** Direction lock's frame: every turn of the camera cancelled, and the horizon level. */
export const lockedFrame = <T extends Pick<StabilizeOptions, 'smoothing' | 'horizon' | 'lock'>>(o: T): T =>
  o.lock ? { ...o, smoothing: 'locked', horizon: true } : o;

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
  /** The same several times per frame, from the gyro (when it is present and agrees). */
  readonly dense: OrientationData | null = null;
  readonly gyroFit: GyroFit | null = null;

  constructor(readonly data: OrientationData | null, ioriMode: IoriMode = DEFAULT_IORI_MODE) {
    const fits = data ? fitCoriMapping(data) : [];
    // Only trust the fit when it is clearly consistent; otherwise fall back to the gravity mapping.
    this.coriFit = fits[0] && fits[0].score < 0.02 ? fits[0] : null;
    this.image = data ? { ...data, cori: imageOrientation(data, ioriMode) } : null;
    if (data?.gyro?.length) {
      this.gyroFit = fitGyro(data.cori, data.gyro);
      if (this.gyroFit) {
        const d = { ...data, cori: denseOrientation(data.cori, data.gyro, this.gyroFit) };
        this.dense = { ...d, cori: imageOrientation(d, ioriMode) };
      }
    }
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
  correctionAt(t: number, optsIn: StabilizeOptions): Mat3 {
    if (!this.data) return IDENTITY;
    const opts = lockedFrame(optsIn);
    const toOurs = this.toOursFn(opts);

    // C maps camera coordinates into the stabilised (smoothed-path) frame: C = Sᵀ·R.
    let C: Mat3 = IDENTITY;
    const smooth = this.path(opts.smoothing, opts.strength);
    const qr = orientationAt(this.image!, t);
    const qs = smooth ? orientationAt(smooth, t) : null;
    if (qr && qs) C = mulMat(transpose(toOurs(qs)), toOurs(qr));

    if (opts.horizon) {
      const gCam = this.gravityIn(t, opts);
      if (gCam) {
        const gs = normalize(mulVec3(C, gCam));
        C = mulMat(rotationBetween(gs, [0, -1, 0]), C);
      }
    }
    return C;
  }

  /**
   * Which way is down, in camera coordinates. With orientation data, one clip-wide "down" is
   * carried through the camera's measured rotation: smooth and drift-free. The raw gravity
   * sensor is noisy frame to frame and would make the horizon jitter.
   */
  gravityIn(t: number, opts: Pick<StabilizeOptions, 'axisMap' | 'invertCori'>): Vec3 | null {
    if (!this.data) return null;
    const toOurs = this.toOursFn(opts);
    const qr = orientationAt(this.image!, t);
    const down = qr ? this.worldDown(opts, toOurs) : null;
    if (qr && down) return mulVec3(transpose(toOurs(qr)), down);
    const g = gravityAt(this.data, t);
    return g && normalize(mulVec3(axisMapMatrix(opts.axisMap), g));
  }

  /**
   * How the camera turned between the middle of the frame at `t` and `offsets` µs from it
   * (for each row of a rolling shutter): camera directions then → camera directions at `t`.
   */
  turnWithin(t: number, offsets: number[], opts: Pick<StabilizeOptions, 'axisMap' | 'invertCori'>): Mat3[] | null {
    const src = this.dense ?? this.image;
    const q0 = src && orientationAt(src, t);
    if (!src || !q0) return null;
    const toOurs = this.toOursFn(opts);
    const back = transpose(toOurs(q0));
    return offsets.map((o) => mulMat(back, toOurs(orientationAt(src, t + o)!)));
  }

  private downCache = new Map<string, Vec3>();
  /** Average gravity direction in the world (orientation-data) frame over the whole clip. */
  private worldDown(opts: Pick<StabilizeOptions, 'axisMap' | 'invertCori'>, toOurs: (q: Quat) => Mat3): Vec3 | null {
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
 * Motion data of a recording split into several files, each already on its own video's clock.
 * Cameras may start each file's orientation from zero again: then it is carried on from where the
 * file before ended.
 */
export function joinOrientation(parts: { data: OrientationData; startUs: number }[]): OrientationData {
  const move = <T extends { t: number }>(a: T[] | undefined, by: number) => (a ?? []).map((s) => ({ ...s, t: s.t + by }));
  const out: OrientationData = { grav: [], cori: [], iori: [], gps: [], accl: [], gyro: [], streams: [...new Set(parts.flatMap((p) => p.data.streams))].sort() };
  const fit = parts[0] && fitCoriMapping(parts[0].data)[0];
  const known = fit && fit.score < 0.02 ? fit : null;
  // Whether CORI maps camera to world or the other way round decides the side a new start is undone on.
  const inverse = known ? known.invert : true;
  const angle = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
  const unit = (q: Quat): Quat => { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
  /** Camera turn from one sample to the next, and the sample after a turn. */
  const between = (p: Quat, q: Quat): Quat => (inverse ? qmul(q, qconj(p)) : qmul(qconj(p), q));
  const after = (p: Quat, d: Quat): Quat => (inverse ? qmul(d, p) : qmul(p, d));
  const shift = (q: Quat, w: Quat): Quat => (inverse ? qmul(q, w) : qmul(w, q));
  /** Average gravity in the frame the orientations are relative to. */
  const down = (cori: TimedQuat[], data: OrientationData): Vec3 | null => {
    if (!known || !data.grav.length || !cori.length) return null;
    const G = mulMat(transpose(axisMapMatrix(known.axisMap)), axisMapMatrix(DEFAULT_AXIS_MAP));
    const sum: Vec3 = [0, 0, 0];
    for (const { t, q } of cori) {
      const g = gravityAt(data, t);
      if (!g) continue;
      const R = quatToMat(q as Quat);
      const w = mulVec3(inverse ? transpose(R) : R, normalize(mulVec3(G, g)));
      sum[0] += w[0]; sum[1] += w[1]; sum[2] += w[2];
    }
    return normalize(sum);
  };
  let firstDown: Vec3 | null = null;
  for (const [i, { data, startUs }] of parts.entries()) {
    const n = out.cori.length, last = out.cori[n - 1]?.q as Quat | undefined, first = data.cori[0]?.q as Quat | undefined;
    let cori = data.cori;
    // A new start is exactly "no rotation", and far from where the last file ended.
    if (last && first && angle(first, [1, 0, 0, 0]) < 0.01 && angle(last, first) > 0.05) {
      // The camera kept turning from the last frame of one file to the first of the next.
      const before = out.cori[n - 2] ? between(out.cori[n - 2]!.q as Quat, last) : ([1, 0, 0, 0] as Quat);
      const next = data.cori[1] ? between(first, data.cori[1].q as Quat) : before;
      const s = before[0] * next[0] + before[1] * next[1] + before[2] * next[2] + before[3] * next[3] < 0 ? -1 : 1;
      const turn = unit(before.map((v, k) => v + s * next[k]!) as Quat);
      const X = inverse ? qmul(qconj(first), after(last, turn)) : qmul(after(last, turn), qconj(first));
      cori = data.cori.map((c) => ({ t: c.t, q: shift(c.q as Quat, X) }));
      // That guess is a little off; gravity says by how much it leans.
      const d = down(cori, data);
      if (d && firstDown) {
        const ax: Vec3 = [d[1] * firstDown[2] - d[2] * firstDown[1], d[2] * firstDown[0] - d[0] * firstDown[2], d[0] * firstDown[1] - d[1] * firstDown[0]];
        const r = unit([1 + d[0] * firstDown[0] + d[1] * firstDown[1] + d[2] * firstDown[2], ...ax]);
        if (angle(r, [1, 0, 0, 0]) < 0.35) cori = cori.map((c) => ({ t: c.t, q: shift(c.q as Quat, inverse ? qconj(r) : r) }));
      }
    }
    if (i === 0) firstDown = down(data.cori, data);
    for (const c of cori) out.cori.push({ t: c.t + startUs, q: c.q });
    for (const x of move(data.grav, startUs)) out.grav.push(x);
    for (const x of move(data.iori, startUs)) out.iori!.push(x);
    for (const x of move(data.gps, startUs)) out.gps!.push(x);
    for (const x of move(data.accl, startUs)) out.accl!.push(x);
    for (const x of move(data.gyro, startUs)) out.gyro!.push(x);
  }
  if (!out.gyro!.length) delete out.gyro;
  if (!out.iori!.length) delete out.iori;
  return out;
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
  const gyro = data.gyro?.map((s) => ({ t: s.t - offset, v: s.v }));
  return { ...data, cori, grav, iori, gps, accl, gyro, syncOffsetUs: offset };
}

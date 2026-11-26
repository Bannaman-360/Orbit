// Smart reframe: turns a measured path (where the interest is, moment by moment) into a calm
// camera move, stored as ordinary keyframes the user can edit afterwards.
//
// The measuring is done elsewhere (motion in the picture, or the direction of travel); this file
// only has the maths, so it can be tested without footage.

import { lookAt, sortKeys, type Keyframe } from './keyframes';
import type { Look } from './look';

/** A value at a media time (µs), with how sure the measurement is (0–1, missing = 1). */
export interface PathPoint { t: number; v: number; w?: number }

/** Degrees made continuous (no jump from 179 to −179), so they can be smoothed. */
export function unwrapDegrees(vs: number[]): number[] {
  const out: number[] = [];
  for (const v of vs) {
    if (!out.length) { out.push(v); continue; }
    const prev = out[out.length - 1]!;
    out.push(prev + ((((v - prev) % 360) + 540) % 360) - 180);
  }
  return out;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]!; };

/**
 * Smooths a path: a median first (one wrong measurement can't pull the camera), then a weighted
 * Gaussian. Where there is little to go on, the path drifts towards `rest` (e.g. the middle).
 */
export function smoothPath(pts: PathPoint[], sigmaUs: number, rest = 0, restWeight = 0.02): PathPoint[] {
  if (!pts.length) return [];
  const w = pts.map((p) => Math.max(0, Math.min(1, p.w ?? 1)));
  const med = pts.map((_, i) => {
    const near: number[] = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(pts.length - 1, i + 2); j++) if (w[j]! > 0.05) near.push(pts[j]!.v);
    return near.length ? median(near) : pts[i]!.v;
  });
  return pts.map((p, i) => {
    let sw = restWeight, sv = rest * restWeight;
    for (let j = i; j >= 0 && p.t - pts[j]!.t < sigmaUs * 3; j--) { const k = Math.exp(-0.5 * ((p.t - pts[j]!.t) / sigmaUs) ** 2) * w[j]!; sw += k; sv += k * med[j]!; }
    for (let j = i + 1; j < pts.length && pts[j]!.t - p.t < sigmaUs * 3; j++) { const k = Math.exp(-0.5 * ((pts[j]!.t - p.t) / sigmaUs) ** 2) * w[j]!; sw += k; sv += k * med[j]!; }
    return { t: p.t, v: sv / sw, w: Math.min(1, sw) };
  });
}

/**
 * A camera operator who doesn't chase every little move: the camera stays put while the
 * interest moves less than `dead` from where it points, then follows, keeping it at that distance.
 */
export function lazyFollow(pts: PathPoint[], dead: number): PathPoint[] {
  if (!pts.length) return [];
  let cam = pts[0]!.v;
  return pts.map((p) => {
    const d = p.v - cam;
    if (Math.abs(d) > dead) cam += d - Math.sign(d) * dead;
    return { t: p.t, v: cam, w: p.w };
  });
}

export const clampPath = (pts: PathPoint[], lo: number, hi: number): PathPoint[] => pts.map((p) => ({ ...p, v: Math.max(lo, Math.min(hi, p.v)) }));

/** The path's value at time t (straight between points, held at the ends). */
export function pathAt(pts: PathPoint[], t: number): number {
  if (!pts.length) return 0;
  if (t <= pts[0]!.t) return pts[0]!.v;
  const last = pts[pts.length - 1]!;
  if (t >= last.t) return last.v;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m]!.t <= t) lo = m; else hi = m; }
  const a = pts[lo]!, b = pts[hi]!;
  return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(1, b.t - a.t);
}

/**
 * The fewest points that stay within `tol` of the path (Ramer–Douglas–Peucker), at least
 * `minGapUs` apart. These become the keyframes.
 */
export function simplifyPath(pts: PathPoint[], tol: number, minGapUs = 0): PathPoint[] {
  if (pts.length <= 2) return pts.map((p) => ({ t: p.t, v: p.v }));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a]!, B = pts[b]!;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i]!, line = A.v + ((B.v - A.v) * (p.t - A.t)) / Math.max(1, B.t - A.t), d = Math.abs(p.v - line);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol && at > 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out: PathPoint[] = [];
  pts.forEach((p, i) => {
    if (!keep[i]) return;
    const prev = out[out.length - 1];
    // Too close to the one before: the last point always stays, so the move ends where it should.
    if (prev && p.t - prev.t < minGapUs && i !== pts.length - 1) return;
    if (prev && p.t - prev.t < minGapUs && out.length > 1) out.pop();
    out.push({ t: p.t, v: p.v });
  });
  return out;
}

/**
 * How the GPS course (degrees clockwise from north) turns into a direction in the camera's
 * world-steady frame, found by comparing it with where the camera faced while moving. The rider
 * looks around, but mostly faces the way they go, so the typical difference is the offset.
 * Null when the two don't agree well enough (or there's too little movement).
 */
export function courseToWorld(camYaw: number[], course: number[]): ((c: number) => number) | null {
  if (camYaw.length < 5 || camYaw.length !== course.length) return null;
  let best: { sign: number; off: number; r: number } | null = null;
  for (const sign of [1, -1]) {
    let sx = 0, sy = 0;
    for (let i = 0; i < camYaw.length; i++) { const d = ((camYaw[i]! - sign * course[i]!) * Math.PI) / 180; sx += Math.cos(d); sy += Math.sin(d); }
    const r = Math.hypot(sx, sy) / camYaw.length;
    if (!best || r > best.r) best = { sign, off: (Math.atan2(sy, sx) * 180) / Math.PI, r };
  }
  if (!best || best.r < 0.5) return null;
  const { sign, off } = best;
  return (c) => ((((off + sign * c) % 360) + 540) % 360) - 180;
}

/** Course over ground (degrees clockwise from north) between two GPS positions. */
export function courseBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

let counter = 0;
const keyId = () => `k${Date.now().toString(36)}r${(counter++).toString(36)}`;

/**
 * Writes a path into a clip's keyframes: a keyframe at each path point (straight moves between
 * them), and the clip's own keyframes keep everything else but take the path's value too.
 */
export function pathKeyframes(clip: { look: Look; keyframes: Keyframe[] }, path: PathPoint[], set: (look: Look, v: number) => Look, nearUs = 150_000): Keyframe[] {
  if (!path.length) return clip.keyframes;
  const own = sortKeys(clip.keyframes);
  const kept = own.map((k) => ({ ...k, look: set(k.look, pathAt(path, k.t)) }));
  const added: Keyframe[] = path
    .filter((p) => !own.some((k) => Math.abs(k.t - p.t) < nearUs))
    .map((p) => ({ id: keyId(), t: Math.round(p.t), look: set(lookAt(own, clip.look, p.t), p.v), easing: 'linear' }));
  return sortKeys([...kept, ...added]);
}

/**
 * Where nothing was measured, the interest is taken to be where it was last seen (or, before it
 * was first seen, where that was): a subject standing still doesn't move.
 */
export function holdGaps(pts: PathPoint[], sure = 0.15): PathPoint[] {
  const first = pts.find((p) => (p.w ?? 1) >= sure);
  if (!first) return pts;
  let last = first.v;
  return pts.map((p) => {
    if ((p.w ?? 1) >= sure) { last = p.v; return p; }
    return { t: p.t, v: last, w: Math.max(p.w ?? 0, 0.3) };
  });
}

/** The usual steps from measured points to keyframes. `dead` and `tol` are in the path's units. */
export function planPath(raw: PathPoint[], o: { sigmaUs: number; dead: number; tol: number; minGapUs: number; lo: number; hi: number; rest?: number }): PathPoint[] {
  const smooth = smoothPath(holdGaps(raw), o.sigmaUs, o.rest ?? 0);
  const calm = smoothPath(lazyFollow(clampPath(smooth, o.lo, o.hi), o.dead), o.sigmaUs / 2, o.rest ?? 0, 0);
  return simplifyPath(clampPath(calm, o.lo, o.hi), o.tol, o.minGapUs);
}

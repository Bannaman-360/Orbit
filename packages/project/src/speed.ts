// Speed of a clip: one speed, or a ramp through points. Points sit at media times (like keyframes),
// so they stay on the same moment when the clip is trimmed or split.
//
// Between two points the speed changes evenly in *timeline* time, which is what the eye sees.
// Everything is closed form (no summing up), so a time maps to the same picture everywhere:
// preview, export and sound.

export type SpeedEase = 'smooth' | 'linear' | 'jump';

export interface SpeedKey {
  id: string;
  /** Media time (µs). */
  t: number;
  speed: number;
  /** How the speed gets from here to the next point. Missing = smooth. */
  ease?: SpeedEase;
}

/** Anything that plays a stretch of a file: a clip, or sound on the audio track. */
export interface Timed {
  inUs: number;
  outUs: number;
  speed?: number;
  /** A speed ramp (`speed` is not used then). */
  speedKeys?: SpeedKey[];
}

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 8;
/** Points can't be closer than this (media µs). */
export const MIN_KEY_GAP = 20_000;
export const clampSpeed = (v: number) => Math.max(MIN_SPEED, Math.min(MAX_SPEED, v));

interface Piece { t0: number; t1: number; s0: number; s1: number; ease: SpeedEase; /** Timeline time at t0, and how long the piece lasts. */ at: number; len: number }
interface Curve { pieces: Piece[]; t0: number; s0: number; t1: number; s1: number; end: number }

const curves = new WeakMap<SpeedKey[], Curve>();
function curveOf(keys: SpeedKey[]): Curve {
  let c = curves.get(keys);
  if (c) return c;
  const k = [...keys].sort((a, b) => a.t - b.t);
  const pieces: Piece[] = [];
  let at = 0;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i]!, b = k[i + 1]!, ease = a.ease ?? 'smooth';
    const len = ease === 'jump' ? (b.t - a.t) / a.speed : (2 * (b.t - a.t)) / (a.speed + b.speed);
    pieces.push({ t0: a.t, t1: b.t, s0: a.speed, s1: b.speed, ease, at, len });
    at += len;
  }
  const first = k[0]!, last = k[k.length - 1]!;
  c = { pieces, t0: first.t, s0: first.speed, t1: last.t, s1: last.speed, end: at };
  curves.set(keys, c);
  return c;
}

/** How far the speed has changed (0–1) at w (0–1) through a piece, and how much of that has added up. */
const shape = (ease: SpeedEase, w: number) => (ease === 'jump' ? 0 : ease === 'linear' ? w : w * w * (3 - 2 * w));
const area = (ease: SpeedEase, w: number) => (ease === 'jump' ? 0 : ease === 'linear' ? (w * w) / 2 : w * w * w - (w * w * w * w) / 2);
const mediaIn = (p: Piece, w: number) => p.t0 + p.len * (p.s0 * w + (p.s1 - p.s0) * area(p.ease, w));

/** Share of a piece's time (0–1) at which media time t plays. */
function shareAt(p: Piece, t: number): number {
  let lo = 0, hi = 1, w = (t - p.t0) / (p.t1 - p.t0);
  for (let i = 0; i < 60; i++) {
    const d = mediaIn(p, w) - t;
    if (Math.abs(d) < 1e-4) break;
    if (d > 0) hi = w; else lo = w;
    // Newton's step, kept inside what is known.
    const n = w - d / (p.len * (p.s0 + (p.s1 - p.s0) * shape(p.ease, w)));
    w = n > lo && n < hi ? n : (lo + hi) / 2;
  }
  return w;
}

/** Timeline time of a media time, counted from the first point. */
function curveTime(c: Curve, t: number): number {
  if (t <= c.t0) return (t - c.t0) / c.s0;
  if (t >= c.t1) return c.end + (t - c.t1) / c.s1;
  const p = c.pieces.find((x) => t < x.t1)!;
  return p.at + p.len * shareAt(p, t);
}
function curveMedia(c: Curve, T: number): number {
  if (T <= 0) return c.t0 + T * c.s0;
  if (T >= c.end) return c.t1 + (T - c.end) * c.s1;
  const p = c.pieces.find((x) => T < x.at + x.len) ?? c.pieces[c.pieces.length - 1]!;
  return mediaIn(p, (T - p.at) / p.len);
}

const keysOf = (c: Timed) => (c.speedKeys?.length ? c.speedKeys : null);
export const hasRamp = (c: Timed) => !!keysOf(c);

/** Media time playing `local` µs after the clip's start (also outside the clip, as if it went on). */
export function mediaAt(c: Timed, local: number): number {
  const k = keysOf(c);
  if (!k) return c.inUs + local * (c.speed ?? 1);
  const v = curveOf(k);
  return curveMedia(v, curveTime(v, c.inUs) + local);
}

/** How long after the clip's start a media time plays. */
export function localAt(c: Timed, mediaUs: number): number {
  const k = keysOf(c);
  if (!k) return (mediaUs - c.inUs) / (c.speed ?? 1);
  const v = curveOf(k);
  return curveTime(v, mediaUs) - curveTime(v, c.inUs);
}

export const playLength = (c: Timed): number => {
  const k = keysOf(c);
  return k ? localAt(c, c.outUs) : (c.outUs - c.inUs) / (c.speed ?? 1);
};

/** Speed at a media time. */
export function speedAt(c: Timed, mediaUs: number): number {
  const k = keysOf(c);
  if (!k) return c.speed ?? 1;
  const v = curveOf(k);
  if (mediaUs <= v.t0) return v.s0;
  if (mediaUs >= v.t1) return v.s1;
  const p = v.pieces.find((x) => mediaUs < x.t1)!;
  return p.s0 + (p.s1 - p.s0) * shape(p.ease, shareAt(p, mediaUs));
}

/** Media times inside (from, to) at which the way the speed changes does: points of the ramp. */
export const speedBreaks = (c: Timed, from: number, to: number): number[] =>
  (keysOf(c) ?? []).map((k) => k.t).filter((t) => t > from && t < to).sort((a, b) => a - b);

/** Slowest and fastest speed used between two media times. */
export function speedRange(c: Timed, from = c.inUs, to = c.outUs): { min: number; max: number } {
  const all = [speedAt(c, from), speedAt(c, to - 1), ...(keysOf(c) ?? []).filter((k) => k.t >= from && k.t <= to).map((k) => k.speed)];
  return { min: Math.min(...all), max: Math.max(...all) };
}

/** Stretches (µs after the clip's start) that play slower than `below`. */
export function slowSpans(c: Timed, below: number): [number, number][] {
  const k = keysOf(c), L = playLength(c);
  if (!k) return (c.speed ?? 1) < below - 1e-6 ? [[0, L]] : [];
  const v = curveOf(k), off = curveTime(v, c.inUs);
  const out: [number, number][] = [];
  const add = (a: number, b: number) => {
    const x = Math.max(0, a - off), y = Math.min(L, b - off);
    if (y <= x) return;
    const last = out[out.length - 1];
    if (last && x - last[1] < 1) last[1] = y; else out.push([x, y]);
  };
  const slow = (s: number) => s < below - 1e-6;
  if (slow(v.s0)) add(-Infinity, 0);
  for (const q of v.pieces) {
    const a = slow(q.s0), b = slow(q.ease === 'jump' ? q.s0 : q.s1);
    if (a && b) { add(q.at, q.at + q.len); continue; }
    if (a === b) continue;
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) { const w = (lo + hi) / 2; if (slow(q.s0 + (q.s1 - q.s0) * shape(q.ease, w)) === a) lo = w; else hi = w; }
    if (a) add(q.at, q.at + q.len * lo); else add(q.at + q.len * lo, q.at + q.len);
  }
  if (slow(v.s1)) add(v.end, Infinity);
  return out;
}

// --- Editing -------------------------------------------------------------------------------------

let n = 0;
const keyId = () => `s${Date.now().toString(36)}${(n++).toString(36)}`;
const sorted = (k: SpeedKey[]) => [...k].sort((a, b) => a.t - b.t);

/** The point within `tol` µs of a media time. */
export const speedKeyNear = (c: Timed, t: number, tol = 30_000): SpeedKey | undefined =>
  keysOf(c)?.filter((k) => Math.abs(k.t - t) <= tol).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];

/** Sets the speed at a media time: changes the point there, or adds one (which starts out changing nothing). */
export function setSpeedKey(c: Timed, t: number, speed = speedAt(c, t)): SpeedKey[] {
  const near = speedKeyNear(c, t);
  if (near) return c.speedKeys!.map((k) => (k.id === near.id ? { ...k, speed: clampSpeed(speed) } : k));
  return sorted([...(keysOf(c) ?? []), { id: keyId(), t, speed: clampSpeed(speed) }]);
}

/** Moves a point; it can't pass its neighbours. */
export function moveSpeedKey(keys: SpeedKey[], id: string, t: number, speed: number, lo = -Infinity, hi = Infinity): SpeedKey[] {
  const k = sorted(keys), i = k.findIndex((x) => x.id === id);
  if (i < 0) return keys;
  const min = Math.max(lo, (k[i - 1]?.t ?? -Infinity) + MIN_KEY_GAP), max = Math.min(hi, (k[i + 1]?.t ?? Infinity) - MIN_KEY_GAP);
  return k.map((x, j) => (j === i ? { ...x, t: min <= max ? Math.max(min, Math.min(max, t)) : x.t, speed: clampSpeed(speed) } : x));
}

/** Removing the last point leaves the clip at that point's speed. */
export function removeSpeedKey(c: Timed, id: string): Pick<Timed, 'speed' | 'speedKeys'> {
  const k = keysOf(c)?.find((x) => x.id === id), rest = (keysOf(c) ?? []).filter((x) => x.id !== id);
  return rest.length ? { speedKeys: rest } : { speedKeys: undefined, speed: k?.speed ?? c.speed ?? 1 };
}
export const setSpeedEase = (keys: SpeedKey[], id: string, ease: SpeedEase): SpeedKey[] => keys.map((k) => (k.id === id ? { ...k, ease } : k));

/** The slowest speed at which every output picture is still a new one. */
export function cleanSpeed(fps: number, outFps: number): number {
  // (239.76 pictures a second are meant as 240.)
  const n = fps / outFps, whole = Math.round(n);
  return Math.max(MIN_SPEED, Math.min(1, 1 / (whole > 0 && Math.abs(n / whole - 1) < 0.01 ? whole : n)));
}

export type RampPreset = 'slow-moment' | 'fast-slow-fast' | 'fast-forward' | 'ease-in' | 'ease-out' | 'speed-up' | 'slow-down';
export const RAMP_PRESETS: [RampPreset, string, string][] = [
  ['slow-moment', 'Slow moment', 'Normal speed, slowing down around the playhead'],
  ['fast-slow-fast', 'Fast – slow – fast', 'Rushes up to the playhead, slows down for it, rushes on'],
  ['fast-forward', 'Fast forward', 'Normal speed, speeding through the part around the playhead'],
  ['ease-in', 'Slow start', 'Starts slow and gets up to speed'],
  ['ease-out', 'Slow finish', 'Slows down at the end'],
  ['speed-up', 'Speed up', 'Gets faster all the way through'],
  ['slow-down', 'Slow down', 'Gets slower all the way through'],
];

/** A ramp over the clip. `centre`: media time it happens around; `slow`: how slow its slow part is. */
export function rampPreset(kind: RampPreset, c: Timed, centre: number, slow: number): SpeedKey[] {
  const L = c.outUs - c.inUs, S = 1e6;
  const key = (t: number, speed: number): SpeedKey => ({ id: keyId(), t: Math.round(t), speed });
  /** Outside → inside → outside, round the centre; everything shrinks to fit a short clip. */
  const hump = (outside: number, inside: number, hold: number, ramp: number) => {
    const k = Math.min(1, (L * 0.96) / (hold + 2 * ramp)), h = (hold * k) / 2, r = ramp * k;
    const m = Math.max(c.inUs + h + r + L * 0.01, Math.min(c.outUs - h - r - L * 0.01, centre));
    return [key(m - h - r, outside), key(m - h, inside), key(m + h, inside), key(m + h + r, outside)];
  };
  switch (kind) {
    case 'slow-moment': return hump(1, slow, 0.7 * S, 0.5 * S);
    case 'fast-slow-fast': return hump(3, slow, 0.7 * S, 1 * S);
    case 'fast-forward': return hump(1, 5, 3 * S, 1 * S);
    case 'ease-in': return [key(c.inUs + Math.min(0.4 * S, L * 0.2), slow), key(c.inUs + Math.min(1.2 * S, L * 0.6), 1)];
    case 'ease-out': return [key(c.outUs - Math.min(1.2 * S, L * 0.6), 1), key(c.outUs - Math.min(0.4 * S, L * 0.2), slow)];
    case 'speed-up': return [key(c.inUs, 1), key(c.outUs, 4)];
    case 'slow-down': return [key(c.inUs, 4), key(c.outUs, 1)];
  }
}

/** Safe points from anything saved. */
export function fixSpeedKeys(raw: unknown): SpeedKey[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const good = raw.filter((k): k is SpeedKey => !!k && Number.isFinite(k.t) && Number.isFinite(k.speed) && k.speed > 0)
    .map((k) => ({ id: typeof k.id === 'string' ? k.id : keyId(), t: k.t, speed: clampSpeed(k.speed), ...(['smooth', 'linear', 'jump'].includes(k.ease!) ? { ease: k.ease } : {}) }));
  const out: SpeedKey[] = [];
  for (const k of sorted(good)) if (!out.length || k.t - out[out.length - 1]!.t >= 1000) out.push(k);
  return out.length ? out : undefined;
}

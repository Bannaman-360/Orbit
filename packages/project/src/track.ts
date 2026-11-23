// Subject tracking: a path of view directions (pan / tilt) that keeps a tracked subject
// centred. Times are media times, like keyframes, so trimming and splitting keep it in place.
// The path only drives pan and tilt; zoom, lens, colour and effects still come from the look.

import type { Look } from './look';

export interface TrackPoint {
  /** Media time, µs. */
  t: number;
  /** Degrees, in the same frame as Look.yaw / Look.pitch. */
  yaw: number;
  pitch: number;
  /** Subject size (degrees across), when known. */
  size?: number;
}

export interface ClipTrack {
  /**
   * 'world': points are in a world-steady frame (fully stabilised); they are converted to the
   * clip's own view (whatever its stabilisation) when drawn. 'view': points are view angles.
   */
  space?: 'world' | 'view';
  points: TrackPoint[];
  /** Smoothing window (σ, seconds) applied to the raw path. */
  smoothing: number;
  /** Framing offset from the subject, degrees (drag the view while tracking to change it). */
  offsetYaw: number;
  offsetPitch: number;
  /** Auto zoom: 0 = off … 1 = keep the subject exactly the same size. */
  autoZoom?: number;
  /** Share of the frame width the subject should fill (auto zoom target). */
  subjectFrac?: number;
  /** Part of the tracked path actually used (media µs); unset = from / to the path's own end. */
  from?: number;
  to?: number;
  /** How long the view takes to move onto the subject and away from it (seconds). */
  ease?: number;
  /** After the end: stay on the last view (default), or go back to the clip's own view. */
  after?: 'hold' | 'return';
  /** With 'hold': the view to settle on instead of the last tracked one (clip view angles). */
  end?: { yaw: number; pitch: number; fov: number };
  /** Auto fisheye: bends the lens as auto zoom goes wide, so edges don't stretch (0 = off … 1 = strong). */
  lens?: number;
  /** Auto zoom never goes wider than this (degrees). */
  maxFov?: number;
}

export const DEFAULT_TRACK_LENS = 0.6;
export const DEFAULT_TRACK_MAX_FOV = 120;

/** Share of the frame width a subject `size`° across fills, for a field of view and fisheye. */
export type ShareOf = (size: number, fov: number, fisheye: number) => number;
const linearShare: ShareOf = (size, fov) => size / fov;

const ramp = (x: number) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };
/** The clip's own fisheye: one value, or one for each field of view (a lens look kept while zooming). */
export type OwnLens = number | ((fov: number) => number);
const ownAt = (own: OwnLens, fov: number) => (typeof own === 'number' ? own : own(fov));
/** The fisheye a track uses at a field of view: none when zoomed in, more the wider it gets. */
export const trackFisheye = (tr: ClipTrack, fov: number, own: OwnLens): number =>
  Math.max(ownAt(own, fov), (tr.lens ?? DEFAULT_TRACK_LENS) * ramp((fov - 60) / 60));

export const DEFAULT_TRACK_EASE_S = 0.8;
/** Shortest stretch a track can be trimmed to (µs). */
export const MIN_TRACK_US = 100_000;

const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Gaussian-smoothed copy of the path (yaw unwrapped first so ±180° doesn't jump). */
export function smoothTrack(points: TrackPoint[], sigmaS: number): TrackPoint[] {
  const n = points.length;
  if (n < 3) return points;
  if (sigmaS <= 0) sigmaS = 1e-6;
  const yaw: number[] = [points[0]!.yaw];
  for (let i = 1; i < n; i++) yaw.push(yaw[i - 1]! + wrap(points[i]!.yaw - points[i - 1]!.yaw));
  const sigma = sigmaS * 1e6;
  // Size is smoothed more (zoom changes should be calm) and in log terms (×2 and ÷2 are symmetric).
  const sizeSigma = Math.max(sigma, 600_000);
  return points.map((p, i) => {
    let sy = 0, sp = 0, sw = 0;
    for (let j = i; j >= 0 && p.t - points[j]!.t <= 3 * sigma; j--) {
      const w = Math.exp(-0.5 * ((p.t - points[j]!.t) / sigma) ** 2);
      sy += w * yaw[j]!; sp += w * points[j]!.pitch; sw += w;
    }
    for (let j = i + 1; j < n && points[j]!.t - p.t <= 3 * sigma; j++) {
      const w = Math.exp(-0.5 * ((points[j]!.t - p.t) / sigma) ** 2);
      sy += w * yaw[j]!; sp += w * points[j]!.pitch; sw += w;
    }
    let size: number | undefined;
    if (p.size !== undefined) {
      let ls = 0, lw = 0;
      for (let j = 0; j < n; j++) {
        const q = points[j]!;
        if (q.size === undefined || Math.abs(q.t - p.t) > 3 * sizeSigma) continue;
        const w = Math.exp(-0.5 * ((q.t - p.t) / sizeSigma) ** 2);
        ls += w * Math.log(q.size); lw += w;
      }
      size = lw ? Math.exp(ls / lw) : p.size;
    }
    return { t: p.t, yaw: wrap(sy / sw), pitch: sp / sw, size };
  });
}

const cache = new WeakMap<ClipTrack, TrackPoint[]>();
const smoothed = (tr: ClipTrack) => {
  let s = cache.get(tr);
  if (!s) cache.set(tr, (s = smoothTrack(tr.points, tr.smoothing)));
  return s;
};

/** Everything that was tracked, whether used or not. */
export const trackExtent = (tr: ClipTrack): [number, number] | null =>
  tr.points.length ? [tr.points[0]!.t, tr.points[tr.points.length - 1]!.t] : null;

/** The part of the path that is used (see ClipTrack.from / to). */
export function trackRange(tr: ClipTrack): [number, number] | null {
  const e = trackExtent(tr);
  if (!e) return null;
  const min = Math.min(MIN_TRACK_US, e[1] - e[0]);
  const a = Math.max(e[0], Math.min(e[1] - min, tr.from ?? e[0]));
  return [a, Math.max(a + min, Math.min(e[1], tr.to ?? e[1]))];
}

/** Whether the view follows the subject at media time t. */
export function trackActive(tr: ClipTrack, t: number): boolean {
  const r = trackRange(tr);
  return !!r && t >= r[0] && t <= r[1];
}

/** Whether media time t is after the end of a track that holds its last view. */
export function trackHeld(tr: ClipTrack, t: number): boolean {
  const r = trackRange(tr);
  return !!r && t > r[1] && (tr.after ?? 'hold') === 'hold';
}

/**
 * Uses only [from, to] of the tracked path (media µs). An end dragged back to the end of what
 * was tracked goes back to "all of it".
 */
export function setTrackRange(tr: ClipTrack, from: number, to: number): ClipTrack {
  const e = trackExtent(tr);
  if (!e) return tr;
  const min = Math.min(MIN_TRACK_US, e[1] - e[0]);
  const a = Math.max(e[0], Math.min(e[1] - min, from));
  const b = Math.max(a + min, Math.min(e[1], to));
  return { ...tr, from: a > e[0] ? a : undefined, to: b < e[1] ? b : undefined };
}

/** The tracked direction at media time t, before offsets (null outside what was tracked). */
export function trackAt(tr: ClipTrack, t: number): { yaw: number; pitch: number; size?: number } | null {
  const pts = smoothed(tr);
  const r = trackExtent(tr);
  if (!r || t < r[0] || t > r[1]) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m]!.t <= t) lo = m; else hi = m;
  }
  const a = pts[lo]!, b = pts[hi]!;
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const size = a.size !== undefined && b.size !== undefined ? a.size * (b.size / a.size) ** f : a.size ?? b.size;
  return { yaw: wrap(a.yaw + wrap(b.yaw - a.yaw) * f), pitch: a.pitch + (b.pitch - a.pitch) * f, size };
}

/** Converts a direction from the track's frame into the clip's view frame (for 'world' tracks). */
export type ToView = (yaw: number, pitch: number, t: number) => { yaw: number; pitch: number };

type ViewAim = { yaw: number; pitch: number; fov: number; fisheye: number };
const smoothstep = ramp;
const lerpAim = (a: ViewAim, b: ViewAim, f: number): ViewAim => ({
  yaw: wrap(a.yaw + wrap(b.yaw - a.yaw) * f),
  pitch: a.pitch + (b.pitch - a.pitch) * f,
  fov: Math.exp(Math.log(a.fov) + (Math.log(b.fov) - Math.log(a.fov)) * f),
  fisheye: a.fisheye + (b.fisheye - a.fisheye) * f,
});
/** The camera coasts to a stop over this long at the end of a held track (µs). */
const SETTLE_US = 500_000;

/**
 * How much the view follows the subject at media time t: 0 before the start, easing up to 1
 * inside the section (never before it: what comes before is entirely the user's own view), and
 * easing back down after the end unless the track holds its last view.
 */
export function trackWeight(tr: ClipTrack, t: number): number {
  const r = trackRange(tr);
  if (!r || t < r[0]) return 0;
  const easeUs = Math.max(1, (tr.ease ?? DEFAULT_TRACK_EASE_S) * 1e6);
  if (t <= r[1]) return smoothstep((t - r[0]) / Math.min(easeUs, Math.max(1, (r[1] - r[0]) / 2)));
  return trackHeld(tr, t) ? 1 : smoothstep(1 - (t - r[1]) / easeUs);
}

/** The field of view at which a subject `size`° across fills `frac` of the frame, lens included. */
export function fovForShare(tr: ClipTrack, size: number, frac: number, ownFisheye: OwnLens, share: ShareOf): number {
  const max = Math.max(MIN_ZOOM_FOV, Math.min(MAX_ZOOM_FOV, tr.maxFov ?? DEFAULT_TRACK_MAX_FOV));
  let lo = MIN_ZOOM_FOV, hi = max;
  const at = (fov: number) => share(size, fov, trackFisheye(tr, fov, ownFisheye));
  if (at(lo) <= frac) return lo;
  if (at(hi) >= frac) return hi;
  for (let i = 0; i < 26; i++) {
    const m = (lo + hi) / 2;
    if (at(m) > frac) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/**
 * The look with pan/tilt (and auto zoom) following the subject. Eases onto the subject at the
 * start; after the end it either settles on the last view or eases back to the clip's own.
 */
export function applyTrack(look: Look, tr: ClipTrack | undefined, t: number, toView?: ToView, share: ShareOf = linearShare, ownLens: OwnLens = look.fisheye): Look {
  if (!tr) return look;
  const r = trackRange(tr), ext = trackExtent(tr);
  if (!r || !ext) return look;
  const weight = trackWeight(tr, t);
  if (weight <= 0) return look;
  const zoom = tr.autoZoom ?? 0;
  const lensAt = (fov: number) => (zoom > 0 ? trackFisheye(tr, fov, ownLens) : ownAt(ownLens, fov));
  const own: ViewAim = { yaw: look.yaw, pitch: look.pitch, fov: look.fov, fisheye: look.fisheye };
  /** The tracked view at time tt (the path beyond a trimmed end still exists: use it while easing). */
  const viewAt = (tt: number): ViewAim | null => {
    const tc = Math.max(ext[0], Math.min(ext[1], tt));
    const raw = trackAt(tr, tc);
    if (!raw) return null;
    const v = tr.space === 'world' && toView ? toView(raw.yaw, raw.pitch, tc) : raw;
    // Auto zoom: field of view that keeps the subject at `subjectFrac` of the frame width.
    let fov = look.fov;
    if (zoom > 0 && raw.size && tr.subjectFrac) {
      const target = fovForShare(tr, raw.size, tr.subjectFrac, ownLens, share);
      fov = Math.exp(Math.log(look.fov) + (Math.log(target) - Math.log(look.fov)) * zoom);
    }
    return { yaw: wrap(v.yaw + tr.offsetYaw), pitch: Math.max(-90, Math.min(90, v.pitch + tr.offsetPitch)), fov, fisheye: lensAt(fov) };
  };
  let aim: ViewAim | null;
  if (t > r[1] && trackHeld(tr, t)) {
    // Stay on the last view. The camera was moving with the subject: let it coast to a stop
    // (speed dying away smoothly) instead of freezing dead.
    const t0 = Math.max(r[0], r[1] - 66_667);
    const last = viewAt(r[1]), before = viewAt(t0);
    if (!last || !before) return look;
    const dt = Math.max(1, r[1] - t0);
    const u = Math.min(1, (t - r[1]) / SETTLE_US);
    const k = ((SETTLE_US / 3) * (1 - (1 - u) ** 3)) / dt;
    const fov = Math.max(MIN_ZOOM_FOV, Math.min(Math.max(MAX_ZOOM_FOV, last.fov), last.fov * (last.fov / before.fov) ** k));
    const coast: ViewAim = {
      yaw: wrap(last.yaw + wrap(last.yaw - before.yaw) * k),
      pitch: Math.max(-90, Math.min(90, last.pitch + (last.pitch - before.pitch) * k)),
      fov,
      fisheye: lensAt(fov),
    };
    const easeUs = Math.max(1, (tr.ease ?? DEFAULT_TRACK_EASE_S) * 1e6);
    aim = tr.end ? lerpAim(coast, { ...tr.end, fisheye: lensAt(tr.end.fov) }, smoothstep((t - r[1]) / easeUs)) : coast;
  } else {
    const v = viewAt(t);
    aim = v && (weight >= 1 ? v : lerpAim(own, v, weight));
  }
  return aim ? { ...look, ...aim } : look;
}

/** The subject share that makes the tracked view `fov` wide at time t (for zooming by hand). */
export function fracForFov(tr: ClipTrack, t: number, fov: number, ownFisheye: OwnLens, share: ShareOf = linearShare): number | null {
  const size = trackAt(tr, t)?.size;
  return size ? Math.max(0.03, Math.min(0.9, share(size, fov, trackFisheye(tr, fov, ownFisheye)))) : null;
}

/** Auto zoom never goes tighter / wider than this (degrees). */
export const MIN_ZOOM_FOV = 8;
export const MAX_ZOOM_FOV = 170;

/** Auto zoom's default target never needs a wider view than this at the subject's closest (degrees). */
export const COMFORT_FOV = 105;

/**
 * The share of the frame the subject should fill: as framed when tracking started, but big
 * enough that its closest moment still fits a normal lens (holding a distant, tiny subject's
 * size through a close pass would need an absurdly wide, stretched view).
 */
export function fitSubjectFrac(tr: ClipTrack, framed: number, ownFisheye = 0, share: ShareOf = linearShare, comfort = COMFORT_FOV): number {
  let max = 0;
  for (const p of smoothTrack(tr.points, 0.25)) if (p.size !== undefined && p.size > max) max = p.size;
  return Math.max(0.03, Math.min(0.9, Math.max(framed, max ? share(max, comfort, trackFisheye(tr, comfort, ownFisheye)) : 0)));
}

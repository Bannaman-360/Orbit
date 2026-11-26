// AI improvements to a clip's picture, made once into a copy of the part of the clip in use:
// smooth slow motion (in-between frames where it plays slowly) and sharper pictures (upscaling).
// The preview plays the copy when it is ready; the export always uses it.

import { speedAt, speedRange } from './speed';
import type { TimelineClip } from './timeline';

export interface Enhance {
  /** Make in-between frames where the clip plays slower than recorded. */
  smooth?: boolean;
  /** Make the picture this many times bigger and sharper. */
  upscale?: 2 | 4;
}

/** Slower than this counts as slow motion. */
const SLOW = 0.95;
/** At most this many pictures for each recorded one. */
export const MAX_SMOOTH = 8;
/** The biggest copy made (pixels across the longer side, and in all). */
export const MAX_SIDE = 3840, MAX_PIXELS = 3840 * 2160;

export const enhanceOn = (e: Enhance | undefined): e is Enhance => !!e && (!!e.smooth || !!e.upscale);

/** The slowest the clip plays (its speed, or its ramp's slowest point). */
export const slowest = (c: Pick<TimelineClip, 'speed' | 'speedKeys' | 'inUs' | 'outUs'>): number => speedRange(c).min;

/** Pictures made for each recorded one in the slowest part (1 = none needed). */
export const smoothFactor = (c: Pick<TimelineClip, 'speed' | 'speedKeys' | 'inUs' | 'outUs'>): number => {
  const s = slowest(c);
  return s >= SLOW ? 1 : Math.min(MAX_SMOOTH, Math.ceil(1 / Math.max(0.01, s) - 1e-6));
};

/**
 * For each gap between recorded frames (times, µs), how many pictures in all it gets: 1 where the
 * clip plays at about normal speed, more where it is slowed down (enough for the slowest part).
 */
export function framesPerGap(c: TimelineClip, times: number[]): number[] {
  const k = smoothFactor(c);
  return times.slice(0, -1).map((t, i) => {
    if (k <= 1) return 1;
    const s = Math.min(speedAt(c, t), speedAt(c, (t + times[i + 1]!) / 2), speedAt(c, times[i + 1]!));
    return s >= SLOW ? 1 : Math.min(k, Math.ceil(1 / Math.max(0.01, s) - 1e-6));
  });
}

/** The copy's picture size for a recorded size (even numbers, never past MAX_SIDE / MAX_PIXELS). */
export function enhancedSize(w: number, h: number, e: Enhance): { w: number; h: number; scale: number } {
  let k = e.upscale ?? 1;
  k = Math.min(k, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  k = Math.max(1, k);
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { w: even(w * k), h: even(h * k), scale: k };
}

/** Whether upscaling a picture of this size does anything (it is under the biggest size). */
export const canUpscale = (w: number, h: number) => enhancedSize(w, h, { upscale: 2 }).scale > 1.2;

/** What decides a copy: the clip's part, its speeds where smoothing, and the improvements. */
export function enhanceKey(c: TimelineClip): string {
  const e = c.enhance ?? {};
  const speeds = e.smooth ? `${smoothFactor(c)}:${c.speed}:${(c.speedKeys ?? []).map((k) => `${k.t},${k.speed}`).join(';')}` : '';
  return `${c.inUs}-${c.outUs}|s${e.smooth ? 1 : 0}|u${e.upscale ?? 1}|${speeds}`;
}

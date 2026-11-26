// Highlights: the moments of a ride worth showing, found without watching it. They come from
// what the camera recorded besides the picture:
// - HiLight tags: the rider pressed the button (or said "GoPro, HiLight"). Always kept.
// - Jumps (see airtime.ts): longer and farther ones score higher.
// - Top speed: the fastest moments of the file, from GPS.
// - Hard hits: a jolt well above a normal landing or turn that isn't a jump's landing (a big
//   compression, a drop, a crash).
// Moments close together become one highlight. Pure: works on numbers, no DOM.

import type { Jump } from './airtime';

export type HighlightKind = 'tag' | 'jump' | 'speed' | 'hit';

export interface Highlight {
  /** The moment itself, media time µs: a jump's takeoff, the fastest point, the tag. */
  t: number;
  /** The part worth showing, a little before and after it (media µs). */
  fromUs: number;
  toUs: number;
  /** The strongest reason it's a highlight, and any others that happened in the same moment. */
  kind: HighlightKind;
  also: HighlightKind[];
  /** 0–1: higher is better (for picking the best few). */
  score: number;
  jump?: Jump;
  /** Ground speed at the fastest point (m/s). */
  speedMs?: number;
  /** Hardest jolt (G). */
  g?: number;
}

export interface HighlightData {
  durationUs: number;
  /** HiLight tags, media µs. */
  tags?: number[];
  jumps?: Jump[];
  /** Smoothed GPS ground speed (m/s) at times `speedT` (µs). */
  speedT?: ArrayLike<number>;
  speed?: ArrayLike<number>;
  /** Accelerometer total in G (1 at rest) at times `gT` (µs), unsmoothed. */
  gT?: ArrayLike<number>;
  g?: ArrayLike<number>;
}

/** How much of each kind of moment to show (µs before, after). A tag is usually pressed just
 *  after the moment, so most of its part comes before it. */
const PAD: Record<HighlightKind, [number, number]> = { tag: [7e6, 2e6], jump: [2.5e6, 2e6], speed: [3e6, 3e6], hit: [3e6, 2e6] };
/** Fastest moments: within this share of the file's top speed… */
const SPEED_SHARE = 0.9;
/** …at least this fast (m/s, about 15 km/h; slower isn't worth a highlight)… */
const MIN_TOP_SPEED = 4.2;
/** …this far apart, and no more than this many. */
const SPEED_GAP_US = 30e6;
const MAX_SPEED_PEAKS = 3;
/** A hard hit reads at least this many G (a hard pump-track landing is about 3–4 G on a helmet). */
export const HIT_G = 4.5;
const HIT_GAP_US = 3e6;
/** A jolt this close to a jump's landing is the landing, already counted with the jump. */
const LANDING_US = 800_000;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function jumpScore(j: Jump): number {
  return Math.min(1, 0.45 + 0.35 * clamp01(j.airMs / 1200) + 0.2 * clamp01((j.distanceM ?? 0) / 15));
}

/** Local maxima of a series above `min`, at least `gapUs` apart, biggest first. */
function peaks(t: ArrayLike<number>, v: ArrayLike<number>, min: number, gapUs: number, radius = 0): { t: number; v: number }[] {
  const n = Math.min(t.length, v.length);
  const cand: { t: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    let x = v[i]!;
    if (radius) { let s = 0, c = 0; for (let k = Math.max(0, i - radius); k <= Math.min(n - 1, i + radius); k++) { s += v[k]!; c++; } x = s / c; }
    if (x >= min) cand.push({ t: t[i]!, v: x });
  }
  cand.sort((a, b) => b.v - a.v);
  const out: { t: number; v: number }[] = [];
  for (const c of cand) if (out.every((o) => Math.abs(o.t - c.t) >= gapUs)) out.push(c);
  return out;
}

/** Every highlight in a file, in time order. */
export function findHighlights(d: HighlightData): Highlight[] {
  const end = d.durationUs;
  const one = (kind: HighlightKind, t: number, score: number, extra: Partial<Highlight> = {}, from = t, to = t): Highlight => ({
    t, kind, also: [], score, ...extra,
    fromUs: Math.max(0, Math.round(from - PAD[kind][0])), toUs: Math.min(end, Math.round(to + PAD[kind][1])),
  });
  const list: Highlight[] = [];
  for (const t of d.tags ?? []) if (t >= 0 && t <= end) list.push(one('tag', t, 1));
  const jumps = d.jumps ?? [];
  for (const j of jumps) list.push(one('jump', j.startUs, jumpScore(j), { jump: j }, j.startUs, j.endUs));
  if (d.speedT && d.speed && d.speed.length > 1) {
    let top = 0;
    for (let i = 0; i < d.speed.length; i++) top = Math.max(top, d.speed[i]!);
    if (top >= MIN_TOP_SPEED)
      for (const p of peaks(d.speedT, d.speed, top * SPEED_SHARE, SPEED_GAP_US).slice(0, MAX_SPEED_PEAKS))
        list.push(one('speed', p.t, 0.35 + 0.25 * (p.v / top), { speedMs: Math.round(p.v * 100) / 100 }));
  }
  if (d.gT && d.g && d.g.length > 2) {
    // (Averaged over about 30 ms, so one noisy sample isn't a hit.)
    const rate = (d.g.length - 1) / ((d.gT[d.gT.length - 1]! - d.gT[0]!) / 1e6 || 1);
    const radius = Math.max(0, Math.round(rate * 0.015));
    for (const p of peaks(d.gT, d.g, HIT_G, HIT_GAP_US, radius)) {
      if (jumps.some((j) => p.t >= j.startUs - 300_000 && p.t <= j.endUs + LANDING_US)) continue;
      list.push(one('hit', p.t, 0.3 + 0.3 * clamp01((p.v - HIT_G) / 4), { g: Math.round(p.v * 10) / 10 }));
    }
  }
  return mergeHighlights(list);
}

/** Moments this close (µs, end of one to start of the next) happened together: one highlight. */
const TOGETHER_US = 1.5e6;
const momentEnd = (h: Highlight) => h.jump?.endUs ?? h.t;

/**
 * Moments that happen together (a tag pressed just after a jump, top speed on the run-in)
 * become one highlight, named after the strongest reason. Others stay apart even when their
 * parts overlap (jumps a few seconds apart on a pump track): the overlap is shared out at the
 * middle between them, so no picture is in two highlights.
 */
export function mergeHighlights(list: Highlight[]): Highlight[] {
  const sorted = [...list].sort((a, b) => a.t - b.t || b.score - a.score);
  const groups: Highlight[][] = [];
  let end = -Infinity;
  for (const h of sorted) {
    if (groups.length && h.t - end < TOGETHER_US) { groups[groups.length - 1]!.push(h); end = Math.max(end, momentEnd(h)); }
    else { groups.push([h]); end = momentEnd(h); }
  }
  const merged = groups.map((g) => {
    const best = g.reduce((a, b) => (b.score > a.score ? b : a));
    const kinds = new Set(g.map((x) => x.kind));
    kinds.delete(best.kind);
    const jump = g.filter((x) => x.jump).sort((a, b) => b.score - a.score)[0]?.jump;
    const speedMs = g.reduce<number | undefined>((a, x) => (x.speedMs !== undefined && (a === undefined || x.speedMs > a) ? x.speedMs : a), undefined);
    const gMax = g.reduce<number | undefined>((a, x) => (x.g !== undefined && (a === undefined || x.g > a) ? x.g : a), undefined);
    return {
      h: {
        ...best,
        also: [...kinds],
        fromUs: Math.min(...g.map((x) => x.fromUs)),
        toUs: Math.max(...g.map((x) => x.toUs)),
        // Several reasons at once make a better moment.
        score: Math.min(1, Math.round((best.score + 0.1 * (g.length - 1)) * 1000) / 1000),
        ...(jump ? { jump } : {}), ...(speedMs !== undefined ? { speedMs } : {}), ...(gMax !== undefined ? { g: gMax } : {}),
      } as Highlight,
      first: Math.min(...g.map((x) => x.t)),
      last: Math.max(...g.map(momentEnd)),
    };
  });
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1]!, b = merged[i]!;
    if (a.h.toUs <= b.h.fromUs) continue;
    const cut = Math.round((a.last + b.first) / 2);
    a.h.toUs = Math.max(a.last, Math.min(a.h.toUs, cut));
    b.h.fromUs = Math.min(b.first, Math.max(b.h.fromUs, a.h.toUs));
  }
  return merged.map((x) => x.h);
}

/** The `n` best highlights, in time order. */
export function bestHighlights(list: Highlight[], n: number): Highlight[] {
  if (n >= list.length) return list;
  const keep = new Set([...list].sort((a, b) => b.score - a.score).slice(0, Math.max(0, n)));
  return list.filter((h) => keep.has(h));
}

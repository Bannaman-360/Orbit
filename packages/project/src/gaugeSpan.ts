// What footage a gauge counts: only what is shown while the gauge is on the timeline. Distance,
// jumps, totals and the timer start from zero where the gauge starts, skip anything cut out, and
// (unless the gauge is set to keep counting) start again at every cut in the video under it.

import { clipStarts, clipDuration, transitionUs, type Timeline, type TimelineClip } from './timeline';
import { localAt, mediaAt, playLength } from './speed';
import type { Overlay } from './overlays';

/** One stretch of one clip under a gauge. */
export interface GaugePiece {
  clip: TimelineClip;
  /** Timeline time the clip itself starts (for media ↔ timeline). */
  clipStart: number;
  /** Timeline range of this piece (inside the gauge). */
  T0: number;
  T1: number;
  /** Media range shown over it. */
  m0: number;
  m1: number;
  /** True when this piece starts after a real cut (not where the gauge starts, not a plain split). */
  afterCut: boolean;
}

/** Media time → timeline time, for a piece's clip. */
export const pieceTime = (p: GaugePiece, mediaUs: number) => p.clipStart + localAt(p.clip, mediaUs);
/** Timeline time → media time, for a piece's clip. */
export const pieceMedia = (p: GaugePiece, T: number) => Math.min(p.clip.outUs - 1, mediaAt(p.clip, Math.max(0, Math.min(playLength(p.clip), T - p.clipStart))));

/** Within this much, two pieces of the same recording follow on (a split, not a cut). */
const JOIN_US = 60_000;

/**
 * The clips a gauge reads over its time on the timeline, in order: the main row, or the clip on
 * V2–V6 it is set to read (with the other pieces of that recording on that track).
 */
export function gaugePieces(tl: Timeline, o: Pick<Overlay, 'startUs' | 'endUs' | 'sourceClipId'>): GaugePiece[] {
  const spans: { clip: TimelineClip; clipStart: number; a: number; b: number }[] = [];
  const own = o.sourceClipId ? tl.connected.find((c) => c.id === o.sourceClipId) : undefined;
  if (own) {
    const same = tl.connected.filter((c) => c.trackId === own.trackId && c.mediaPath === own.mediaPath).sort((x, y) => x.startUs - y.startUs);
    for (const c of same) spans.push({ clip: c, clipStart: c.startUs, a: c.startUs, b: c.startUs + playLength(c) });
  } else {
    const starts = clipStarts(tl);
    tl.clips.forEach((c, i) => {
      const s = starts[i]!;
      // During a transition the outgoing clip is the one read (as everywhere else).
      const end = i < tl.clips.length - 1 ? starts[i + 1]! + transitionUs(tl, i + 1) : s + clipDuration(c);
      spans.push({ clip: c, clipStart: s, a: i ? s + transitionUs(tl, i) : s, b: end });
    });
  }
  const out: GaugePiece[] = [];
  for (const sp of spans) {
    const T0 = Math.max(sp.a, o.startUs), T1 = Math.min(sp.b, o.endUs);
    if (T1 <= T0) continue;
    const p: GaugePiece = { clip: sp.clip, clipStart: sp.clipStart, T0, T1, m0: 0, m1: 0, afterCut: false };
    p.m0 = pieceMedia(p, T0);
    p.m1 = pieceMedia(p, T1);
    const prev = out[out.length - 1];
    p.afterCut = !!prev && !(prev.clip.mediaPath === p.clip.mediaPath && Math.abs(prev.m1 - p.m0) <= JOIN_US && Math.abs(prev.T1 - p.T0) <= JOIN_US);
    out.push(p);
  }
  return out;
}

/**
 * The pieces a gauge counts at timeline time T: from where it starts (or from the last cut before
 * T when it restarts at cuts), up to and including the piece under T. `from` is where counting
 * starts; `run` is every piece of the stretch T is in (for totals that fill a scale).
 */
export function gaugeCount(tl: Timeline, o: Pick<Overlay, 'startUs' | 'endUs' | 'sourceClipId' | 'keepCounting'>, T: number): { from: number; done: GaugePiece[]; now: GaugePiece | null; run: GaugePiece[] } {
  const all = gaugePieces(tl, o);
  let first = 0;
  const at = all.findIndex((p) => T >= p.T0 && T < p.T1);
  const idx = at >= 0 ? at : all.filter((p) => p.T0 <= T).length - 1;
  if (!o.keepCounting) for (let i = Math.max(0, idx); i > 0; i--) if (all[i]!.afterCut) { first = i; break; }
  let last = all.length;
  if (!o.keepCounting) for (let i = Math.max(0, idx) + 1; i < all.length; i++) if (all[i]!.afterCut) { last = i; break; }
  const run = all.slice(first, last);
  const from = run[0]?.T0 ?? o.startUs;
  const now = at >= 0 ? all[at]! : null;
  const done = all.slice(first, Math.max(first, at >= 0 ? at : idx + 1));
  return { from, done, now, run };
}

// Snapping: while dragging, times close to something worth lining up with (a clip's edge, the
// playhead, a marker, a beat) jump to it. One list of targets serves every drag on the timeline.

export type SnapKind = 'edge' | 'playhead' | 'marker' | 'beat' | 'bar' | 'keyframe' | 'item';
export interface SnapTarget { t: number; kind: SnapKind }

/** How strongly each kind pulls (a bar line wins over a plain beat at the same distance). */
const PULL: Record<SnapKind, number> = { playhead: 1.2, marker: 1.15, edge: 1.1, bar: 1.05, keyframe: 1, item: 1, beat: 0.9 };

/**
 * The time to use for `t`, and what it lined up with. `withinUs` is how far it reaches (from the
 * pixels-per-second the timeline is drawn at, so it feels the same at any zoom).
 */
export function snapTime(t: number, targets: readonly SnapTarget[], withinUs: number): { t: number; to?: SnapTarget } {
  let best: SnapTarget | undefined, bestScore = Infinity;
  for (const x of targets) {
    const d = Math.abs(x.t - t);
    if (d > withinUs) continue;
    const score = d / PULL[x.kind];
    if (score < bestScore) { bestScore = score; best = x; }
  }
  return best ? { t: best.t, to: best } : { t };
}

/**
 * Snapping for something with two ends (moving a block): whichever end is closer to a target
 * decides, and the block keeps its length.
 */
export function snapSpan(start: number, end: number, targets: readonly SnapTarget[], withinUs: number): { start: number; to?: SnapTarget } {
  const a = snapTime(start, targets, withinUs), b = snapTime(end, targets, withinUs);
  const da = a.to ? Math.abs(a.t - start) : Infinity, db = b.to ? Math.abs(b.t - end) : Infinity;
  if (da === Infinity && db === Infinity) return { start };
  return da <= db ? { start: a.t, to: a.to } : { start: start + (b.t - end), to: b.to };
}

/** Sorted, de-duplicated targets (a beat on a clip edge counts once, as the stronger kind). */
export function snapTargets(list: SnapTarget[]): SnapTarget[] {
  const sorted = [...list].filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t || PULL[b.kind] - PULL[a.kind]);
  const out: SnapTarget[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.t - x.t) > 500) out.push(x);
    else if (PULL[x.kind] > PULL[last.kind]) out[out.length - 1] = x;
  }
  return out;
}

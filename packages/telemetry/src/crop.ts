// Crop for stabilised regular clips. Turning the view against the shake uncovers the edge of the
// picture, so the view must zoom in. The plan says, for every moment of a clip, how far to zoom
// (smoothly, and always far enough) and how much of the correction to apply when the shake needs
// more zoom than allowed.

export interface CropRequest {
  /** Number of evenly spaced moments. */
  n: number;
  /** Field of view wanted at moment i (before any stabilisation crop). */
  want: (i: number) => number;
  /** Widest field of view at i that shows no edge, with `keep` (0–1) of the correction applied. */
  fit: (i: number, keep: number) => number;
  /** 'auto' zooms as the shake needs; 'manual' uses a fixed crop. */
  mode: 'auto' | 'manual';
  /** Auto: how many moments the zoom takes to change (larger = calmer). Infinity = one zoom for all. */
  window: number;
  /** Most the view may be zoomed in: share of the field of view given up (0–0.9). */
  maxCrop: number;
  /** Manual: the share given up. */
  amount: number;
}

export interface CropPlan {
  /** Share of the wanted field of view to show at each moment (≤ 1). */
  ratio: Float64Array;
  /** Share of the stabilising rotation to apply (≤ 1). */
  keep: Float64Array;
}

/** Smallest value within ±r of each position (O(n)). */
export function slidingMin(x: ArrayLike<number>, r: number): Float64Array {
  const n = x.length, out = new Float64Array(n), q: number[] = [];
  let head = 0;
  for (let i = 0, add = 0; i < n; i++) {
    while (add < n && add <= i + r) {
      while (q.length > head && x[q[q.length - 1]!]! >= x[add]!) q.pop();
      q.push(add++);
    }
    while (q[head]! < i - r) head++;
    out[i] = x[q[head]!]!;
  }
  return out;
}

/** Weighted average over ±r with a raised-cosine window. Never leaves the range of its inputs. */
export function hannSmooth(x: ArrayLike<number>, r: number): Float64Array {
  const n = x.length, out = new Float64Array(n);
  if (r < 1) return Float64Array.from(x);
  const w = Float64Array.from({ length: r + 1 }, (_, k) => 0.5 + 0.5 * Math.cos((Math.PI * k) / (r + 1)));
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
    for (let j = lo; j <= hi; j++) { const k = w[Math.abs(j - i)]!; s += x[j]! * k; ws += k; }
    out[i] = s / ws;
  }
  return out;
}

/**
 * A smooth curve that never rises above `x`: each value is an average of minima whose windows
 * all contain that position, so it can't exceed the original there.
 */
export function smoothUnder(x: ArrayLike<number>, r: number): Float64Array {
  return hannSmooth(slidingMin(x, r), r);
}

/** Works through the plan a little at a time (`yield`s so the caller can let the interface run). */
export function* planCrop(q: CropRequest): Generator<number, CropPlan> {
  const n = Math.max(1, q.n);
  const ratio = new Float64Array(n).fill(1), keep = new Float64Array(n).fill(1);
  const floor = 1 - Math.max(0, Math.min(0.9, q.mode === 'manual' ? q.amount : q.maxCrop));
  // How far the full correction needs to zoom, and where that is too far, how much of it fits.
  for (let i = 0; i < n; i++) {
    const want = q.want(i);
    let r = Math.min(1, q.fit(i, 1) / want);
    if (r < floor) {
      let lo = 0, hi = 1;
      for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (q.fit(i, m) / want >= floor) lo = m; else hi = m; }
      keep[i] = lo;
      r = Math.min(1, q.fit(i, lo) / want);
    }
    ratio[i] = r;
    if (i % 8 === 7) yield i / n;
  }
  // Ease the correction in and out of the hard spots instead of switching.
  const kr = Math.max(1, Math.round(Math.min(q.window, n) * 0.5) || 1);
  if (keep.some((k) => k < 0.999)) {
    const eased = smoothUnder(keep, Math.min(kr, n - 1));
    for (let i = 0; i < n; i++) {
      if (Math.abs(eased[i]! - keep[i]!) < 1e-6) continue;
      ratio[i] = Math.min(1, q.fit(i, eased[i]!) / q.want(i));
      keep[i] = eased[i]!;
      if (i % 8 === 7) yield 1;
    }
  }
  if (q.mode === 'manual' || q.window >= n) {
    // One zoom for the whole clip: the chosen one, or the tightest needed.
    const tight = ratio.reduce((m, v) => Math.min(m, v), 1);
    ratio.fill(q.mode === 'manual' ? Math.min(floor, Math.max(tight, floor * 0.6)) : tight);
    return { ratio, keep };
  }
  const logs = smoothUnder(Array.from(ratio, Math.log), Math.max(0, Math.round(q.window)));
  return { ratio: Float64Array.from(logs, Math.exp), keep };
}

/** Runs a plan to the end. */
export function planCropNow(q: CropRequest): CropPlan {
  const g = planCrop(q);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/** The plan at a position between moments. */
export function cropAt(p: CropPlan, x: number): { ratio: number; keep: number } {
  const n = p.ratio.length, c = Math.max(0, Math.min(n - 1, x)), i = Math.min(n - 1, Math.floor(c)), j = Math.min(n - 1, i + 1), f = c - i;
  return { ratio: p.ratio[i]! + (p.ratio[j]! - p.ratio[i]!) * f, keep: p.keep[i]! + (p.keep[j]! - p.keep[i]!) * f };
}

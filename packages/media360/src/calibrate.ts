// Automatic layout calibration from real footage.
//
// Every cube edge is shared by two faces. With the correct layout the pixels just
// inside that edge on face A match the pixels just inside it on face B. We try each
// possible orientation of each tile (4 rotations × optional mirror) and several seam
// spacings, and keep the layout whose 12 edges match best.
//
// The front tile (stream 0, middle) is the reference and is never re-oriented.

import { type EacLayout, type Tile, tilePixel } from './eac';
import { type Vec3, cross, dot } from './math';

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

interface Orientation { right: Vec3; down: Vec3; mirrored: boolean }

const AXES: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The 8 ways to lay a face image onto its cube face. */
export function tileOrientations(center: Vec3): Orientation[] {
  const out: Orientation[] = [];
  for (const r of AXES) {
    if (Math.abs(dot(r, center)) > 0.5) continue;
    for (const d of AXES) {
      if (Math.abs(dot(d, center)) > 0.5 || Math.abs(dot(d, r)) > 0.5) continue;
      out.push({ right: r, down: d, mirrored: dot(cross(r, d), center) > 0 });
    }
  }
  return out;
}

const SAMPLES = 96;
const INSET = 0.012; // how far inside the edge to sample, in cube-plane units (~8px at 1344)

function sample(img: RGBAImage, x: number, y: number): [number, number, number] {
  const xi = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const i = (yi * img.width + xi) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/** Colour samples along the edge shared with neighbour face `other`, for one tile placement. */
function edgeSamples(img: RGBAImage, tile: Tile, o: Orientation, other: Vec3): Float32Array {
  const c = tile.center;
  // Edge direction must be the same when sampled from either face, so fix its sign.
  let e = cross(c, other);
  if (e[0] + e[1] + e[2] < 0) e = [-e[0], -e[1], -e[2]];
  const out = new Float32Array(SAMPLES * 3);
  for (let i = 0; i < SAMPLES; i++) {
    const t = -0.9 + (1.8 * i) / (SAMPLES - 1);
    // Point on face `c` just inside the edge towards `other`.
    const p: Vec3 = [
      c[0] + (1 - INSET) * other[0] + t * e[0],
      c[1] + (1 - INSET) * other[1] + t * e[1],
      c[2] + (1 - INSET) * other[2] + t * e[2],
    ];
    const s = dot(p, o.right), v = dot(p, o.down);
    const es = (4 / Math.PI) * Math.atan(s), ev = (4 / Math.PI) * Math.atan(v);
    const [r, g, b] = sample(img, ...tilePixel(tile, es, ev));
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

function diff(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

export interface CalibrationResult {
  layout: EacLayout;
  /** Mean absolute RGB difference across all edges (0–255). Lower is better. */
  score: number;
  /** Score of the layout we started from, for comparison. */
  baselineScore: number;
  /** Per-edge score of the winner, e.g. "front|right": 4.2 */
  edges: Record<string, number>;
  /** Tile x positions that won, per stream. */
  seam: string;
  mirroredTiles: string[];
}

export interface SeamVariant { name: string; xs: [number, number, number]; gaps: [number, number, number] }

/** Plausible ways the spare width (stream width − 3 faces) is distributed. */
export function seamVariants(width: number, size: number): SeamVariant[] {
  const spare = width - 3 * size;
  const g = spare / 2;
  return [
    { name: 'split side faces (GoPro)', xs: [0, size + g, 2 * size + g], gaps: [g, 0, g] },
    { name: 'gaps between faces', xs: [0, size + g, 2 * size + spare], gaps: [0, 0, 0] },
    { name: 'spare at both ends', xs: [g, g + size, g + 2 * size], gaps: [0, 0, 0] },
    { name: 'spare at right end', xs: [0, size, 2 * size], gaps: [0, 0, 0] },
    { name: 'spare at left end', xs: [spare, spare + size, spare + 2 * size], gaps: [0, 0, 0] },
    { name: 'spare after middle', xs: [0, size, 2 * size + spare], gaps: [0, 0, 0] },
    { name: 'spare before middle', xs: [0, size + spare, 2 * size + spare], gaps: [0, 0, 0] },
  ];
}

/**
 * frames: one or more decoded moments, each as [stream0, stream1] RGBA images.
 * Faces stay assigned to the same tiles as in `base`; only orientation and seams change.
 */
export function calibrateLayout(base: EacLayout, frames: [RGBAImage, RGBAImage][]): CalibrationResult {
  const centers = base.tiles.map((t) => t.center);
  const neighbours = (c: Vec3) => centers.filter((o) => Math.abs(dot(o, c)) < 0.5);
  const edgeKey = (a: number, b: number) => `${base.tiles[a]!.face}|${base.tiles[b]!.face}`;
  const pairs: [number, number][] = [];
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) if (Math.abs(dot(centers[a]!, centers[b]!)) < 0.5) pairs.push([a, b]);
  const frontIdx = base.tiles.findIndex((t) => t.face === 'front');

  const scoreLayout = (layout: EacLayout) => {
    let total = 0;
    const edges: Record<string, number> = {};
    for (const [a, b] of pairs) {
      let s = 0;
      for (const f of frames) {
        const ta = layout.tiles[a]!, tb = layout.tiles[b]!;
        s += diff(
          edgeSamples(f[ta.stream]!, ta, { right: ta.right, down: ta.down, mirrored: false }, tb.center),
          edgeSamples(f[tb.stream]!, tb, { right: tb.right, down: tb.down, mirrored: false }, ta.center),
        );
      }
      edges[edgeKey(a, b)] = s / frames.length;
      total += s / frames.length;
    }
    return { score: total / pairs.length, edges };
  };

  const baseline = scoreLayout(base);
  let best: CalibrationResult | null = null;

  for (const seam of seamVariants(base.streamWidth, base.streamHeight)) {
    const placed = base.tiles.map((t) => {
      const col = [...base.tiles.filter((u) => u.stream === t.stream)].sort((p, q) => p.x - q.x).indexOf(t);
      return { ...t, x: seam.xs[col]!, gap: seam.gaps[col]! };
    });
    const options = placed.map((t, i) => (i === frontIdx ? [{ right: t.right, down: t.down, mirrored: false }] : tileOrientations(t.center)));

    // Precompute samples for each (tile, orientation, neighbour).
    const cache = placed.map((t, i) =>
      options[i]!.map((o) => {
        const m = new Map<string, Float32Array[]>();
        for (const n of neighbours(t.center)) m.set(n.join(), frames.map((f) => edgeSamples(f[t.stream]!, t, o, n)));
        return m;
      }),
    );
    const pairCost = (a: number, oa: number, b: number, ob: number) => {
      const A = cache[a]![oa]!.get(centers[b]!.join())!;
      const B = cache[b]![ob]!.get(centers[a]!.join())!;
      let s = 0;
      for (let k = 0; k < frames.length; k++) s += diff(A[k]!, B[k]!);
      return s / frames.length;
    };

    // Exhaustive search over the 5 free tiles (8^5 = 32768 combinations).
    const free = placed.map((_, i) => i).filter((i) => i !== frontIdx);
    const choice = new Array(6).fill(0);
    let bestHere = { cost: Infinity, choice: [...choice] };
    const rec = (k: number) => {
      if (k === free.length) {
        let c = 0;
        for (const [a, b] of pairs) c += pairCost(a, choice[a], b, choice[b]);
        if (c < bestHere.cost) bestHere = { cost: c, choice: [...choice] };
        return;
      }
      const i = free[k]!;
      for (let o = 0; o < options[i]!.length; o++) {
        choice[i] = o;
        rec(k + 1);
      }
    };
    rec(0);

    const tiles = placed.map((t, i) => {
      const o = options[i]![bestHere.choice[i]]!;
      return { ...t, right: o.right, down: o.down };
    });
    const layout: EacLayout = { ...base, name: `${base.name.replace(/ \(.*$/, '')} (calibrated: ${seam.name})`, tiles };
    const scored = scoreLayout(layout);
    if (!best || scored.score < best.score) {
      best = {
        layout,
        score: scored.score,
        baselineScore: baseline.score,
        edges: scored.edges,
        seam: seam.name,
        mirroredTiles: tiles.filter((_, i) => options[i]![bestHere.choice[i]]!.mirrored).map((t) => t.face),
      };
    }
  }
  return best!;
}

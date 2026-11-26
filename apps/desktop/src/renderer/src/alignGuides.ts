// Smart guides for placing text and gauges on the picture, like in slide software: while dragging,
// an edge or the middle of the item jumps to the middle of the frame, the safe margins, or the
// edges and middles of the other items on screen, and a line shows what it lined up with.

/** A box in frame fractions (0–1 across and down). */
export interface Box { x: number; y: number; w: number; h: number }
/** Lines to draw, as frame fractions: `v` are vertical lines (an x), `h` horizontal ones (a y). */
export interface Guides { v: number[]; h: number[] }

/** Inset of the safe margin lines, as a fraction of the frame. */
export const SAFE_MARGIN = 0.05;

/**
 * Where to put a box being dragged so it lines up with something nearby. `reachX`/`reachY` are
 * how close (in frame fractions) it must be to jump. Returns the shift to apply and the guides.
 */
export function alignBox(box: Box, others: Box[], reachX: number, reachY: number): { dx: number; dy: number; guides: Guides } {
  const xs = [0.5, SAFE_MARGIN, 1 - SAFE_MARGIN];
  const ys = [0.5, SAFE_MARGIN, 1 - SAFE_MARGIN];
  for (const o of others) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const best = (mine: number[], lines: number[], reach: number) => {
    let d = 0, dist = Infinity;
    for (const m of mine) for (const l of lines) {
      const k = Math.abs(l - m);
      // The middle of the frame wins a tie.
      if (k <= reach && k < dist - 1e-9) { dist = k; d = l - m; }
    }
    return dist === Infinity ? null : d;
  };
  const dx = best([box.x, box.x + box.w / 2, box.x + box.w], xs, reachX);
  const dy = best([box.y, box.y + box.h / 2, box.y + box.h], ys, reachY);
  // Every line the moved box now touches is shown (an item can line up two ways at once).
  const touching = (mine: number[], lines: number[]) => [...new Set(lines.filter((l) => mine.some((m) => Math.abs(l - m) < 1e-6)).map((l) => +l.toFixed(6)))];
  const nx = box.x + (dx ?? 0), ny = box.y + (dy ?? 0);
  return {
    dx: dx ?? 0,
    dy: dy ?? 0,
    guides: {
      v: dx === null ? [] : touching([nx, nx + box.w / 2, nx + box.w], xs),
      h: dy === null ? [] : touching([ny, ny + box.h / 2, ny + box.h], ys),
    },
  };
}

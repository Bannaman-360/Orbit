// Where the interest is in a picture, from it and the one before (for smart reframe): what
// moves once the camera's own movement is taken out, and where the camera is heading.
// Pure, so it can be tested without footage.

import { backgroundShift, type Shift } from './background';

/** Size of the (square) pictures measured. */
export const N = 128;

const at = (p: Float64Array, x: number, y: number) => {
  const ix = Math.max(0, Math.min(N - 2, Math.floor(x))), iy = Math.max(0, Math.min(N - 2, Math.floor(y))), fx = x - ix, fy = y - iy, i = iy * N + ix;
  return p[i]! * (1 - fx) * (1 - fy) + p[i + 1]! * fx * (1 - fy) + p[i + N]! * (1 - fx) * fy + p[i + N + 1]! * fx * fy;
};

/** A light 3×3 blur. */
function blur(p: Float64Array): Float64Array {
  const out = p.slice();
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    out[i] = (4 * p[i]! + 2 * (p[i - 1]! + p[i + 1]! + p[i - N]! + p[i + N]!) + p[i - N - 1]! + p[i - N + 1]! + p[i + N - 1]! + p[i + N + 1]!) / 16;
  }
  return out;
}

/**
 * Where the interest is in one picture, from it and the one before: −1…1 across and down, and
 * how sure (0–1). Pure, for testing.
 */
export function interestBetween(cur: Float64Array, prev: Float64Array, from: Shift, colour?: { cur: Float64Array[]; prev: Float64Array[] }): { x: number; y: number; w: number; shift: Shift } {
  const s = backgroundShift(cur, prev, N, N * 0.06, null, null, from);
  const mid = (N - 1) / 2, edge = 6;
  // Brightness and colour (a red jersey can be as bright as the grass around it), each a little
  // soft, so resampling the earlier picture doesn't leave a trace at every edge.
  const chans = [[cur, prev], ...(colour ? colour.cur.map((c, k) => [c, colour.prev[k]!]) : [])].map(([a, b]) => [blur(a!), blur(b!)] as const);
  // What doesn't move with the background: more change than being a fraction of a pixel out
  // could explain at that spot (sharp edges change a lot from tiny errors in the estimate).
  const diff = new Float64Array(N * N);
  const vals: number[] = [];
  for (let y = edge; y < N - edge; y++) for (let x = edge; x < N - edge; x++) {
    const ux = x - mid, uy = y - mid;
    const px = x + s.dx + s.a * ux - s.b * uy, py = y + s.dy + s.b * ux + s.a * uy;
    if (px < 1 || py < 1 || px > N - 2 || py > N - 2) continue;
    const i = y * N + x;
    let d = 0;
    for (const [c, p] of chans) {
      const grad = Math.hypot(c[i + 1]! - c[i - 1]!, c[i + N]! - c[i - N]!) / 2;
      d += Math.max(0, Math.abs(c[i]! - at(p, px, py)) - 0.6 * grad);
    }
    diff[i] = d;
    vals.push(d);
  }
  vals.sort((a, b) => a - b);
  const noise = vals.length ? vals[Math.floor(vals.length * 0.6)]! : 0;
  const thr = Math.max(8, noise * 3);
  let sw = 0, sx = 0, sy = 0;
  for (let y = edge; y < N - edge; y++) for (let x = edge; x < N - edge; x++) {
    const v = diff[y * N + x]! - thr;
    if (v <= 0) continue;
    sw += v; sx += v * (x - mid); sy += v * (y - mid);
  }
  // Movement over about 1.5% of the picture, clearly above the noise, counts fully.
  const motion = sw > 0 ? { x: sx / sw / mid, y: sy / sw / mid, w: Math.min(1, sw / (N * N * 0.015 * 20)) } : { x: 0, y: 0, w: 0 };
  // Moving forward, everything streams away from one point: where the camera is heading.
  // (A point of the current picture at u was at u·(1+a) + … in the one before, so a < 0.)
  let heading: { x: number; y: number; w: number } | null = null;
  const det = s.a * s.a + s.b * s.b;
  if (s.a < -0.004 && det > 1e-8) {
    const hx = -(s.a * s.dx + s.b * s.dy) / det, hy = -(s.a * s.dy - s.b * s.dx) / det;
    if (Math.abs(hx) < mid * 1.5 && Math.abs(hy) < mid * 1.5) heading = { x: hx / mid, y: hy / mid, w: Math.min(1, -s.a / 0.015) };
  }
  if (!heading) return { ...motion, shift: s };
  // Riding along, nearby things slide past fast: the heading counts for more than they do.
  const wm = motion.w * (1 - 0.7 * heading.w), wh = heading.w;
  return { x: (motion.x * wm + heading.x * wh) / (wm + wh), y: (motion.y * wm + heading.y * wh) / (wm + wh), w: Math.min(1, wm + wh), shift: s };
}


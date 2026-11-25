// Optical flow, for stabilising clips that have no motion data: corners found with FAST, followed
// to the next frame with pyramidal Lucas–Kanade, and the camera's turn between the two frames
// fitted to the matched directions (Horn's quaternion method inside RANSAC, so moving riders,
// trees going past and bad matches don't count). Pure functions, no DOM.

import { quatToMat, type Mat3, type Vec3 } from './math';

/** A greyscale picture, values 0–255. */
export interface Gray { w: number; h: number; d: Float32Array }

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = 0.299 * rgba[j]! + 0.587 * rgba[j + 1]! + 0.114 * rgba[j + 2]!;
  return { w, h, d };
}

/** Half the size (each pixel the mean of 2×2). */
export function halve(g: Gray): Gray {
  const w = Math.max(1, g.w >> 1), h = Math.max(1, g.h >> 1), d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * g.w + 2 * x;
    d[y * w + x] = (g.d[i]! + g.d[i + 1]! + g.d[i + g.w]! + g.d[i + g.w + 1]!) * 0.25;
  }
  return { w, h, d };
}

/** The picture and smaller copies of it, finest first. */
export function pyramid(g: Gray, levels = 3): Gray[] {
  const out = [g];
  while (out.length < levels && out[out.length - 1]!.w > 40) out.push(halve(out[out.length - 1]!));
  return out;
}

const CIRCLE: [number, number][] = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];

/**
 * FAST-9 corners: a pixel with 9 neighbours in a row on a ring of 16 all brighter, or all darker,
 * by `threshold`. The strongest in each cell of a grid are kept, so they spread over the frame.
 */
export function fastCorners(g: Gray, opts: { threshold?: number; max?: number; cols?: number; rows?: number; margin?: number } = {}): [number, number][] {
  const t = opts.threshold ?? 16, max = opts.max ?? 300, cols = opts.cols ?? 8, rows = opts.rows ?? 6, m = Math.max(3, opts.margin ?? 8);
  const { w, h, d } = g;
  const offs = CIRCLE.map(([dx, dy]) => dy * w + dx);
  const cells: { x: number; y: number; s: number }[][] = Array.from({ length: cols * rows }, () => []);
  const ring = new Int8Array(32);
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    const i = y * w + x, c = d[i]!;
    // Quick test: of the four compass points, at least three must differ for a 9-arc.
    const n = d[i + offs[0]!]!, e = d[i + offs[4]!]!, s = d[i + offs[8]!]!, wv = d[i + offs[12]!]!;
    let up = 0, down = 0;
    for (const v of [n, e, s, wv]) { if (v > c + t) up++; else if (v < c - t) down++; }
    if (up < 3 && down < 3) continue;
    let score = 0;
    for (let k = 0; k < 16; k++) { const v = d[i + offs[k]!]!; const r = v > c + t ? 1 : v < c - t ? -1 : 0; ring[k] = ring[k + 16] = r; score += Math.max(0, Math.abs(v - c) - t); }
    let best = 0, run = 0, prev = 0;
    for (let k = 0; k < 32; k++) { const r = ring[k]!; run = r !== 0 && r === prev ? run + 1 : r !== 0 ? 1 : 0; prev = r; if (run > best) best = run; }
    if (best < 9) continue;
    const cell = Math.min(rows - 1, Math.floor((y / h) * rows)) * cols + Math.min(cols - 1, Math.floor((x / w) * cols));
    cells[cell]!.push({ x, y, s: score });
  }
  const per = Math.max(1, Math.ceil(max / (cols * rows)));
  const out: [number, number][] = [];
  for (const c of cells) {
    c.sort((a, b) => b.s - a.s);
    // (Not two right next to each other.)
    const kept: typeof c = [];
    for (const p of c) { if (kept.length >= per) break; if (kept.every((q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > 4)) kept.push(p); }
    for (const p of kept) out.push([p.x, p.y]);
  }
  return out;
}

function sample(g: Gray, x: number, y: number): number {
  const xi = Math.max(0, Math.min(g.w - 2, Math.floor(x))), yi = Math.max(0, Math.min(g.h - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - xi)), fy = Math.max(0, Math.min(1, y - yi));
  const i = yi * g.w + xi, d = g.d;
  return (d[i]! * (1 - fx) + d[i + 1]! * fx) * (1 - fy) + (d[i + g.w]! * (1 - fx) + d[i + g.w + 1]! * fx) * fy;
}

/**
 * Pyramidal Lucas–Kanade: where each point of `prev` went in `next` (both pyramids of the same
 * size). `ok` is false when a point had too little texture, left the frame, or doesn't match.
 */
export function trackPoints(prev: Gray[], next: Gray[], pts: [number, number][], opts: { half?: number; iters?: number; maxError?: number } = {}): { pts: [number, number][]; ok: boolean[] } {
  const half = opts.half ?? 4, iters = opts.iters ?? 12, maxErr = opts.maxError ?? 14;
  const L = Math.min(prev.length, next.length);
  const outPts: [number, number][] = [], ok: boolean[] = [];
  const n = (2 * half + 1) ** 2;
  const I = new Float32Array(n), Ix = new Float32Array(n), Iy = new Float32Array(n);
  for (const [px, py] of pts) {
    let gx = 0, gy = 0, good = true;
    for (let l = L - 1; l >= 0; l--) {
      const P = prev[l]!, N = next[l]!, s = 2 ** l;
      const x0 = px / s, y0 = py / s;
      let a = 0, b = 0, c = 0, k = 0;
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++, k++) {
        const x = x0 + dx, y = y0 + dy;
        I[k] = sample(P, x, y);
        const ix = (sample(P, x + 1, y) - sample(P, x - 1, y)) * 0.5, iy = (sample(P, x, y + 1) - sample(P, x, y - 1)) * 0.5;
        Ix[k] = ix; Iy[k] = iy;
        a += ix * ix; b += ix * iy; c += iy * iy;
      }
      const det = a * c - b * b;
      // Smallest eigenvalue: too little texture to follow at this level.
      const minEig = (a + c - Math.sqrt((a - c) ** 2 + 4 * b * b)) / 2 / n;
      if (det < 1e-6 || minEig < 0.5) { if (l === 0) good = false; gx *= 2; gy *= 2; continue; }
      let vx = 0, vy = 0;
      for (let it = 0; it < iters; it++) {
        let ex = 0, ey = 0;
        k = 0;
        for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++, k++) {
          const e = I[k]! - sample(N, x0 + dx + gx + vx, y0 + dy + gy + vy);
          ex += e * Ix[k]!; ey += e * Iy[k]!;
        }
        const ux = (c * ex - b * ey) / det, uy = (a * ey - b * ex) / det;
        vx += ux; vy += uy;
        if (ux * ux + uy * uy < 1e-4) break;
      }
      gx += vx; gy += vy;
      if (l > 0) { gx *= 2; gy *= 2; }
    }
    const nx = px + gx, ny = py + gy;
    const f = next[0]!, p0 = prev[0]!;
    if (good && (nx < half || ny < half || nx > f.w - 1 - half || ny > f.h - 1 - half)) good = false;
    if (good) {
      // Mean difference over the window at the match.
      let err = 0;
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) err += Math.abs(sample(p0, px + dx, py + dy) - sample(f, nx + dx, ny + dy));
      if (err / n > maxErr) good = false;
    }
    outPts.push([nx, ny]);
    ok.push(good);
  }
  return { pts: outPts, ok };
}

/** Eigenvector of the largest eigenvalue of a symmetric 4×4 matrix (Jacobi rotations). */
function topEigen4(m: number[][]): number[] {
  const a = m.map((r) => [...r]);
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p]![q]! ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      const apq = a[p]![q]!;
      if (Math.abs(apq) < 1e-20) continue;
      const th = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = a[k]![p]!, akq = a[k]![q]!; a[k]![p] = c * akp - s * akq; a[k]![q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = a[p]![k]!, aqk = a[q]![k]!; a[p]![k] = c * apk - s * aqk; a[q]![k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = v[k]![p]!, vkq = v[k]![q]!; v[k]![p] = c * vkp - s * vkq; v[k]![q] = s * vkp + c * vkq; }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i]![i]! > a[best]![best]!) best = i;
  return [v[0]![best]!, v[1]![best]!, v[2]![best]!, v[3]![best]!];
}

/**
 * The rotation that best turns directions `a` into `b` (b ≈ R·a), least squares (Horn 1987),
 * as a quaternion [w, x, y, z].
 */
export function fitRotationQuat(a: Vec3[], b: Vec3[], idx?: number[]): [number, number, number, number] {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (const i of idx ?? a.map((_, k) => k)) {
    const p = a[i]!, q = b[i]!;
    Sxx += p[0] * q[0]; Sxy += p[0] * q[1]; Sxz += p[0] * q[2];
    Syx += p[1] * q[0]; Syy += p[1] * q[1]; Syz += p[1] * q[2];
    Szx += p[2] * q[0]; Szy += p[2] * q[1]; Szz += p[2] * q[2];
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const q = topEigen4(N);
  const n = Math.hypot(...q) || 1;
  const s = q[0]! < 0 ? -1 : 1;
  return [(s * q[0]!) / n, (s * q[1]!) / n, (s * q[2]!) / n, (s * q[3]!) / n];
}

export const fitRotation = (a: Vec3[], b: Vec3[], idx?: number[]): Mat3 => quatToMat(fitRotationQuat(a, b, idx));

const apply = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const angle = (u: Vec3, v: Vec3) => { const c = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; return Math.acos(Math.max(-1, Math.min(1, c))); };

/**
 * The camera's turn between two frames from matched directions (b ≈ R·a), ignoring matches that
 * don't agree with the rest (RANSAC on pairs, then a least-squares fit to those that agree).
 * `tolerance`: radians a match may miss by. Seeded, so the same input gives the same answer.
 */
export function robustRotation(a: Vec3[], b: Vec3[], opts: { tolerance?: number; tries?: number; seed?: number } = {}): { q: [number, number, number, number]; inliers: number; spread: number } | null {
  const n = a.length;
  if (n < 6) return null;
  const tol = opts.tolerance ?? 0.004, tries = opts.tries ?? 80;
  let seed = opts.seed ?? 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let best: number[] = [];
  for (let t = 0; t < tries; t++) {
    const i = Math.floor(rnd() * n);
    let j = Math.floor(rnd() * n);
    if (j === i) j = (j + 1) % n;
    // Two directions too close together don't pin the turn down.
    if (angle(a[i]!, a[j]!) < 0.05) continue;
    const R = fitRotation(a, b, [i, j]);
    const ins: number[] = [];
    for (let k = 0; k < n; k++) if (angle(apply(R, a[k]!), b[k]!) < tol) ins.push(k);
    if (ins.length > best.length) best = ins;
    if (best.length > n * 0.8) break;
  }
  if (best.length < Math.max(6, n * 0.25)) return null;
  // Refit, then once more with whatever agrees with the refit.
  let q = fitRotationQuat(a, b, best);
  const R = quatToMat(q);
  const again: number[] = [];
  for (let k = 0; k < n; k++) if (angle(apply(R, a[k]!), b[k]!) < tol) again.push(k);
  if (again.length >= best.length) { best = again; q = fitRotationQuat(a, b, best); }
  // How widely the agreeing directions are spread (a fit from one corner of the frame is shaky).
  let sx = 0, sy = 0, sxx = 0, syy = 0;
  for (const k of best) { const v = a[k]!; sx += v[0]; sy += v[1]; sxx += v[0] * v[0]; syy += v[1] * v[1]; }
  const m = best.length;
  const spread = Math.sqrt(Math.max(0, sxx / m - (sx / m) ** 2) + Math.max(0, syy / m - (sy / m) ** 2));
  return { q, inliers: m, spread };
}

/** A rotation matrix as a quaternion [w, x, y, z] (w ≥ 0). */
export function matToQuat(m: Mat3): [number, number, number, number] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const tr = a + e + i;
  let q: [number, number, number, number];
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [0.25 * s, (h - f) / s, (c - g) / s, (d - b) / s]; }
  else if (a > e && a > i) { const s = Math.sqrt(1 + a - e - i) * 2; q = [(h - f) / s, 0.25 * s, (b + d) / s, (c + g) / s]; }
  else if (e > i) { const s = Math.sqrt(1 + e - a - i) * 2; q = [(c - g) / s, (b + d) / s, 0.25 * s, (f + h) / s]; }
  else { const s = Math.sqrt(1 + i - a - e) * 2; q = [(d - b) / s, (c + g) / s, (f + h) / s, 0.25 * s]; }
  const n = Math.hypot(...q) || 1, sg = q[0] < 0 ? -1 : 1;
  return [(sg * q[0]) / n, (sg * q[1]) / n, (sg * q[2]) / n, (sg * q[3]) / n];
}

/**
 * Follows one frame to the next: corners in `prev`, where they went in `next`, and the turn
 * between them. `ray(x, y)`: the direction seen at a pixel (from the lens). Returns the turn as
 * camera directions in `prev` → in `next`, or null when the frames don't give one.
 */
export function frameTurn(prev: Gray[], next: Gray[], ray: (x: number, y: number) => Vec3, opts: { corners?: [number, number][]; tolerance?: number } = {}): { q: [number, number, number, number]; inliers: number; tracked: number; spread: number } | null {
  const corners = opts.corners ?? fastCorners(prev[0]!);
  if (corners.length < 8) return null;
  const t = trackPoints(prev, next, corners);
  const a: Vec3[] = [], b: Vec3[] = [];
  t.ok.forEach((good, k) => { if (good) { a.push(ray(...corners[k]!)); b.push(ray(...t.pts[k]!)); } });
  const r = robustRotation(a, b, { tolerance: opts.tolerance });
  return r && { ...r, tracked: a.length };
}

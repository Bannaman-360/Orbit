// How the background moved between two small pictures (shift, rotation and zoom), ignoring the
// subject in the middle. Used by the tracker on clips without motion data, where the camera's own
// movement is not known and everything in view seems to move.

/** Where a point of the current picture was in the previous one: x' = x + dx + a·x − b·y, y' = y + dy + b·x + a·y (from the centre). */
export interface Shift { dx: number; dy: number; a: number; b: number }
export const STILL: Shift = { dx: 0, dy: 0, a: 0, b: 0 };

const half = (p: Float64Array, n: number): Float64Array => {
  const m = n >> 1, out = new Float64Array(m * m);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) { const i = y * 2 * n + x * 2; out[y * m + x] = (p[i]! + p[i + 1]! + p[i + n]! + p[i + n + 1]!) / 4; }
  return out;
};
const soften = (p: Float64Array, n: number): Float64Array => {
  const out = p.slice();
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) { const i = y * n + x; out[i] = (4 * p[i]! + 2 * (p[i - 1]! + p[i + 1]! + p[i - n]! + p[i + n]!) + p[i - n - 1]! + p[i - n + 1]! + p[i + n - 1]! + p[i + n + 1]!) / 16; }
  return out;
};
const solve4 = (A: number[][], v: number[]): number[] | null => {
  const M = A.map((r, i) => [...r, v[i]!]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-9) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < 4; r++) { if (r === c) continue; const k = M[r]![c]! / M[c]![c]!; for (let j = c; j < 5; j++) M[r]![j]! -= k * M[c]![j]!; }
  }
  return M.map((r, i) => r[4]! / r[i]!);
};

/** `box` = radius (pixels) round the middle to leave out. `skip` marks pixels with no picture. */
export function backgroundShift(cur: Float64Array, prev: Float64Array, n: number, box: number, skip?: Uint8Array | null, skipPrev?: Uint8Array | null, from: Shift = STILL): Shift {
  const levels: [Float64Array, Float64Array, number][] = [[soften(cur, n), soften(prev, n), n]];
  while (levels[levels.length - 1]![2] > 24) { const [c, p, m] = levels[levels.length - 1]!; levels.push([soften(half(c, m), m >> 1), soften(half(p, m), m >> 1), m >> 1]); }
  let s = { ...from };
  // (The finest level adds little and costs the most.)
  for (let l = levels.length - 1; l >= 1; l--) {
    const [c, p, m] = levels[l]!, k = n / m, mid = (m - 1) / 2;
    let dx = s.dx / k, dy = s.dy / k, { a, b } = s;
    for (let it = 0; it < 10; it++) {
      const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], v = [0, 0, 0, 0];
      // How different the pictures are overall, to recognise what doesn't fit the background.
      const errs: number[] = [];
      const rows: [number, number, number, number, number][] = [];
      for (let y = 1; y < m - 1; y++) for (let x = 1; x < m - 1; x++) {
        const ux = x - mid, uy = y - mid;
        if (Math.hypot(ux, uy) * k < box) continue;
        const cell = Math.min(n - 1, Math.round((y + 0.5) * k)) * n + Math.min(n - 1, Math.round((x + 0.5) * k));
        if (skip?.[cell]) continue;
        const px = x + dx + a * ux - b * uy, py = y + dy + b * ux + a * uy;
        if (px < 1 || py < 1 || px >= m - 2 || py >= m - 2) continue;
        if (skipPrev?.[Math.min(n - 1, Math.round((py + 0.5) * k)) * n + Math.min(n - 1, Math.round((px + 0.5) * k))]) continue;
        const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy, i = iy * m + ix;
        const p00 = p[i]!, p10 = p[i + 1]!, p01 = p[i + m]!, p11 = p[i + m + 1]!;
        const val = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
        const gx = (p10 - p00) * (1 - fy) + (p11 - p01) * fy, gy = (p01 - p00) * (1 - fx) + (p11 - p10) * fx;
        const e = c[y * m + x]! - val;
        errs.push(Math.abs(e));
        rows.push([gx, gy, ux, uy, e]);
      }
      if (rows.length < 40) break;
      const scale = Math.max(2, errs.sort((x, y) => x - y)[errs.length >> 1]! * 2.5);
      for (const [gx, gy, ux, uy, e] of rows) {
        const w = 1 / (1 + (e / scale) ** 2);
        const j = [gx, gy, gx * ux + gy * uy, gy * ux - gx * uy];
        for (let r = 0; r < 4; r++) { v[r]! += w * j[r]! * e; for (let q = 0; q < 4; q++) A[r]![q]! += w * j[r]! * j[q]!; }
      }
      for (let r = 0; r < 4; r++) A[r]![r]! *= 1.001;
      const d = solve4(A, v);
      if (!d) break;
      dx += d[0]!; dy += d[1]!; a += d[2]!; b += d[3]!;
      if (Math.abs(a) > 0.3 || Math.abs(b) > 0.4 || Math.hypot(dx, dy) > m * 0.45) return from;
      if (Math.hypot(d[0]!, d[1]!) < 0.01 && Math.hypot(d[2]!, d[3]!) * m < 0.02) break;
    }
    s = { dx: dx * k, dy: dy * k, a, b };
  }
  return s;
}

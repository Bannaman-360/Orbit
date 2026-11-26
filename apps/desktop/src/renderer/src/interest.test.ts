import { describe, expect, it } from 'vitest';
import { interestBetween } from './interest';

const N = 128;
/** Smooth texture sampled at (x + ox), with a bright disc at (bx, by). */
function picture(ox: number, bx: number, by: number) {
  const p = new Float64Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x + ox;
    let v = 100 + 40 * Math.sin(u * 0.31) * Math.cos(y * 0.23) + 30 * Math.sin(u * 0.11 + y * 0.17) + 20 * Math.cos(u * 0.53 - y * 0.07);
    if (Math.hypot(x - bx, y - by) < 5) v = 230;
    p[y * N + x] = v;
  }
  return p;
}

describe('smart reframe measuring', () => {
  it('finds what moves while the camera pans', () => {
    const prev = picture(0, 30, 70), cur = picture(0.6, 32, 70);
    const r = interestBetween(cur, prev, { dx: 0, dy: 0, a: 0, b: 0 });
    expect(r.shift.dx).toBeCloseTo(0.6, 1);
    expect(r.w).toBeGreaterThan(0.2);
    expect(r.x).toBeCloseTo((31 - 63.5) / 63.5, 1);
  });
  it('a sharp, busy background is not mistaken for movement', () => {
    const sharp = (ox: number, bx: number) => {
      const p = new Float64Array(N * N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const u = x + ox;
        let v = (Math.sin(u * 0.6) * Math.sin(y * 0.7) > 0.2 ? 160 : 60) + 30 * Math.sin(u * 0.2);
        if (Math.hypot(x - bx, y - 60) < 5) v = 240;
        p[y * N + x] = v;
      }
      return p;
    };
    const r = interestBetween(sharp(0.6, 100), sharp(0, 98), { dx: 0.6, dy: 0, a: 0, b: 0 });
    expect(r.x).toBeGreaterThan(0.4);
  });
  it('finds nothing when only the camera moves', () => {
    const r = interestBetween(picture(0.6, -99, -99), picture(0, -99, -99), { dx: 0, dy: 0, a: 0, b: 0 });
    expect(r.w).toBeLessThan(0.1);
  });
});

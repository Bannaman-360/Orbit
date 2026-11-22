import { describe, expect, it } from 'vitest';
import { fft2, Mosse } from './mosse';

const N = 64;
/**
 * Lightly textured background with a textured subject centred at (cx, cy) that fills
 * about 40% of the patch — the framing the 360 tracker uses.
 */
function scene(cx: number, cy: number, seed = 1): Float64Array {
  const img = new Float64Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const bg = 60 + 8 * Math.sin((x + seed) * 0.7) * Math.cos(y * 0.5 + seed);
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const blob = 150 * Math.exp(-d2 / 120) * (1 + 0.35 * Math.sin((x - cx) * 0.9) * Math.cos((y - cy) * 0.6));
      img[y * N + x] = Math.min(255, bg + blob);
    }
  return img;
}

describe('fft2', () => {
  it('round-trips', () => {
    const re = Float64Array.from({ length: 16 * 16 }, (_, i) => Math.sin(i * 0.37));
    const im = new Float64Array(16 * 16);
    const orig = re.slice();
    fft2(re, im, 16);
    fft2(re, im, 16, true);
    re.forEach((v, i) => expect(v).toBeCloseTo(orig[i]!, 9));
  });
});

/** Find with refinement: re-centre on the estimate and look again (what the 360 tracker does). */
function refine(t: Mosse, truthDx: number, truthDy: number, seed = 1, passes = 3) {
  let ex = 0, ey = 0, psr = 0;
  for (let i = 0; i < passes; i++) {
    const r = t.find(scene(32 + truthDx - ex, 32 + truthDy - ey, seed));
    ex += r.dx; ey += r.dy; psr = r.psr;
  }
  return { ex, ey, psr };
}

describe('Mosse', () => {
  it('finds how far the subject moved', () => {
    const t = new Mosse(N);
    t.init(scene(32, 32));
    for (const [dx, dy] of [[3, 0], [-4, 2], [0, -5], [6, 4]]) {
      const r = refine(t, dx!, dy!);
      expect(Math.abs(r.ex - dx!)).toBeLessThan(0.6);
      expect(Math.abs(r.ey - dy!)).toBeLessThan(0.6);
      expect(r.psr).toBeGreaterThan(5);
    }
  });

  it('follows a subject moving across frames and is unsure when it disappears', () => {
    const t = new Mosse(N);
    let x = 32, y = 32, truthX = 32, truthY = 32;
    t.init(scene(32, 32));
    for (let f = 0; f < 40; f++) {
      truthX += 1.5; truthY += Math.sin(f * 0.3);
      const seed = 1 + f * 0.01;
      const r = refine(t, truthX - x, truthY - y, seed);
      x += r.ex; y += r.ey;
      t.update(scene(32 + (truthX - x), 32 + (truthY - y), seed));
    }
    expect(Math.abs(x - truthX)).toBeLessThan(1);
    expect(Math.abs(y - truthY)).toBeLessThan(1);
    // Subject gone: plain background gives a much less confident answer.
    const empty = Float64Array.from({ length: N * N }, (_, i) => 60 + 8 * Math.sin((i % N) * 0.7) * Math.cos(Math.floor(i / N) * 0.5 + 1));
    expect(t.find(empty).psr).toBeLessThan(t.find(scene(32, 32, 1.4)).psr * 0.7);
  });
});

import { describe, expect, it } from 'vitest';
import { scrollingGraph, smoothAt, textTime } from './gaugeMath';

// A noisy 50 Hz G-force-like signal, linearly interpolated (like TelemetrySeries).
const raw = Array.from({ length: 50 * 60 }, (_, i) => 1 + 0.6 * Math.sin(i / 7) + 0.4 * Math.sin(i * 1.7) + (i % 13 === 0 ? 1.5 : 0));
const f = (t: number) => {
  const x = t / 20_000, i = Math.floor(x);
  if (i < 0 || i + 1 >= raw.length) return NaN;
  return raw[i]! + (raw[i + 1]! - raw[i]!) * (x - i);
};
const S = 1e6;

describe('steady gauges', () => {
  it('a scrolling graph only slides: heights at the same moment never change between frames', () => {
    const span = 10 * S, n = 120, step = span / n;
    for (let frame = 0; frame < 120; frame++) {
      const now = 20 * S + frame * 16_667, next = now + 16_667;
      const a = scrollingGraph(f, now, span, n), b = scrollingGraph(f, next, span, n);
      // Same grid times in both frames (all but the moving last point) have the same value,
      // and moved left by exactly the elapsed time.
      const at = (pts: typeof a, nowT: number) => new Map(pts.slice(0, -1).map((p) => [Math.round((nowT - span + p.x * span) / step), p]));
      const ma = at(a, now), mb = at(b, next);
      let shared = 0;
      for (const [k, p] of ma) {
        const q = mb.get(k);
        if (!q) continue;
        shared++;
        expect(q.v).toBe(p.v);
        expect((p.x - q.x) * span).toBeCloseTo(16_667, 3);
      }
      expect(shared).toBeGreaterThan(n - 3);
    }
  });
  it('ends exactly at now and keeps peaks', () => {
    const g = scrollingGraph(f, 30 * S, 10 * S, 120);
    expect(g[g.length - 1]!.x).toBe(1);
    expect(g[0]!.x).toBeGreaterThanOrEqual(0);
    expect(Math.max(...g.map((p) => p.v))).toBeGreaterThan(1.9);
  });
  it('the start of a file: no points before it', () => {
    const g = scrollingGraph(f, 3 * S, 10 * S, 120, 0);
    expect(g[0]!.x).toBeGreaterThanOrEqual(0.7 - 1e-9);
  });
  it('smoothing calms noise and the number holds a tenth of a second', () => {
    let jump = 0, rawJump = 0;
    for (let t = 10 * S; t < 12 * S; t += 16_667) {
      jump = Math.max(jump, Math.abs(smoothAt(f, t + 16_667, 120_000) - smoothAt(f, t, 120_000)));
      rawJump = Math.max(rawJump, Math.abs(f(t + 16_667) - f(t)));
    }
    expect(jump).toBeLessThan(rawJump / 3);
    expect(textTime(1_234_567)).toBe(1_200_000);
    expect(textTime(1_299_999)).toBe(1_200_000);
  });
});

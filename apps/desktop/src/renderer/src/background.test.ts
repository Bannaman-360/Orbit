import { describe, expect, it } from 'vitest';
import { backgroundShift } from './background';

const N = 128;
const scene = (x: number, y: number) => 120 + 45 * Math.sin(x * 0.21 + 1) * Math.cos(y * 0.17) + 30 * Math.sin(x * 0.07 - y * 0.11) + 20 * Math.cos(x * 0.31 + y * 0.27);
const picture = (f: (x: number, y: number) => number) => Float64Array.from({ length: N * N }, (_, i) => f(i % N, Math.floor(i / N)));

describe('backgroundShift', () => {
  for (const [dx, dy, a, b] of [[0, 0, 0, 0], [3.4, -2.1, 0, 0], [11, 7, 0, 0], [2, 1, 0.02, 0.06], [-8, 4, -0.03, -0.1]] as const)
    it(`finds a shift of ${dx}, ${dy}, zoom ${a}, turn ${b} round a moving subject`, () => {
      const c = (N - 1) / 2;
      const prev = picture(scene);
      const cur = picture((x, y) => {
        // Something else moves in the middle.
        if (Math.hypot(x - c, y - c) < 16) return 40 + ((x * 7 + y * 13) % 60);
        return scene(x + dx + a * (x - c) - b * (y - c), y + dy + b * (x - c) + a * (y - c));
      });
      const s = backgroundShift(cur, prev, N, 20);
      expect(Math.abs(s.dx - dx)).toBeLessThan(0.5);
      expect(Math.abs(s.dy - dy)).toBeLessThan(0.5);
      expect(Math.abs(s.a - a) * 64).toBeLessThan(0.5);
      expect(Math.abs(s.b - b) * 64).toBeLessThan(0.5);
    });
});

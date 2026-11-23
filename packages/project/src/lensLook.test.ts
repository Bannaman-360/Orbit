import { describe, expect, it } from 'vitest';
import { edgeStretch, fisheyeForLook } from './lensLook';

const kOf = (f: number) => 1 - 1.5 * f;

describe('a lens look kept while zooming', () => {
  it('keeps the edges stretched the same against the middle', () => {
    for (const look of [{ fov: 120, fisheye: 0.2 }, { fov: 200, fisheye: 1 / 3 }, { fov: 150, fisheye: 0.5 }, { fov: 100, fisheye: 0 }]) {
      const want = edgeStretch(kOf(look.fisheye), look.fov);
      for (let fov = look.fov; fov <= 300; fov += 10) {
        const f = fisheyeForLook(look, fov);
        if (f < 1 - 1e-6) expect(edgeStretch(kOf(f), fov) / want).toBeCloseTo(1, 4);
      }
    }
  });
  it('gives the chosen fisheye at the chosen field of view', () => {
    for (const look of [{ fov: 120, fisheye: 0.2 }, { fov: 260, fisheye: 1 / 3 }, { fov: 90, fisheye: -0.2 }]) expect(fisheyeForLook(look, look.fov)).toBeCloseTo(look.fisheye, 5);
  });
  it('goes smoothly, more fisheye the wider', () => {
    let last = -1;
    for (let fov = 20; fov <= 360; fov += 2) {
      const f = fisheyeForLook({ fov: 100, fisheye: 0 }, fov);
      expect(f).toBeGreaterThanOrEqual(last - 1e-9);
      if (last >= 0) expect(Math.abs(f - last)).toBeLessThan(0.03);
      last = f;
    }
    expect(fisheyeForLook({ fov: 100, fisheye: 0 }, 200)).toBeCloseTo(1 / 3, 2);
  });
  it('zooming in stops at straight lines, unless the look was beyond them', () => {
    expect(fisheyeForLook({ fov: 100, fisheye: 0 }, 40)).toBeCloseTo(0, 9);
    expect(fisheyeForLook({ fov: 150, fisheye: 0.3 }, 30)).toBeCloseTo(0, 9);
    expect(fisheyeForLook({ fov: 90, fisheye: -0.3 }, 60)).toBeLessThan(0);
    expect(fisheyeForLook({ fov: 90, fisheye: -0.3 }, 60)).toBeGreaterThanOrEqual(-0.3 - 1e-9);
  });
  it('a look chosen too wide for its lens still works', () => expect(fisheyeForLook({ fov: 300, fisheye: 0 }, 300)).toBeCloseTo((1 - (180 * 0.985) / 300) / 1.5, 4));
});

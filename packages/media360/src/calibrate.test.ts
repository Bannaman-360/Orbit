import { describe, expect, it } from 'vitest';
import { calibrateLayout, seamVariants, tileOrientations, type RGBAImage } from './calibrate';
import { goproMaxLayout, streamToDirection, type EacLayout } from './eac';

const W = 1024, H = 336; // a quarter-size stream keeps the test fast

/** Smooth, non-symmetric colour field on the sphere. */
const scene = (d: [number, number, number]): [number, number, number] => [
  128 + 100 * Math.sin(3 * d[0] + 1.3 * d[1]),
  128 + 100 * Math.sin(2.2 * d[1] - 0.7 * d[2] + 0.4),
  128 + 100 * Math.cos(2.7 * d[2] + 1.1 * d[0]),
];

function paint(layout: EacLayout): [RGBAImage, RGBAImage] {
  return [0, 1].map((s) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const d = streamToDirection(layout, s, x + 0.5, y + 0.5);
        const c = d ? scene(d) : [255, 0, 255];
        data.set([c[0]!, c[1]!, c[2]!, 255], (y * W + x) * 4);
      }
    return { width: W, height: H, data };
  }) as [RGBAImage, RGBAImage];
}

describe('layout calibration', () => {
  it('offers 8 placements per face, 4 of them mirrored', () => {
    const o = tileOrientations([0, 0, 1]);
    expect(o).toHaveLength(8);
    expect(o.filter((x) => x.mirrored)).toHaveLength(4);
  });

  it('keeps a layout that is already right', () => {
    const truth = goproMaxLayout(W, H);
    const r = calibrateLayout(truth, [paint(truth)]);
    expect(r.layout.tiles.map((t) => [t.x, t.gap, t.right, t.down])).toEqual(truth.tiles.map((t) => [t.x, t.gap, t.right, t.down]));
    expect(r.score).toBeLessThan(3);
  }, 30_000);

  it('recovers scrambled orientations and a different seam layout', () => {
    const guess = goproMaxLayout(W, H);
    const seam = seamVariants(W, H).find((v) => v.name === 'spare at right end')!;
    // Hidden truth: every non-front tile turned to a different (un-mirrored) placement.
    const truth: EacLayout = {
      ...guess,
      tiles: guess.tiles.map((t, i) => {
        const col = guess.tiles.filter((u) => u.stream === t.stream).sort((a, b) => a.x - b.x).indexOf(t);
        if (t.face === 'front') return { ...t, x: seam.xs[col]!, gap: seam.gaps[col]! };
        const opts = tileOrientations(t.center).filter((o) => !o.mirrored);
        const o = opts[(i + 1) % opts.length]!;
        return { ...t, x: seam.xs[col]!, gap: seam.gaps[col]!, right: o.right, down: o.down };
      }),
    };
    const r = calibrateLayout(guess, [paint(truth)]);
    expect(r.seam).toBe('spare at right end');
    expect(r.mirroredTiles).toEqual([]);
    expect(r.layout.tiles.map((t) => [t.x, t.gap, t.right, t.down])).toEqual(truth.tiles.map((t) => [t.x, t.gap, t.right, t.down]));
    expect(r.score).toBeLessThan(r.baselineScore);
  }, 30_000);
});

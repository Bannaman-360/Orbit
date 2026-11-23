import { describe, expect, it } from 'vitest';
import {
  directionToStream,
  fromEquiAngular,
  goproMaxLayout,
  streamToDirection,
  tilePixel,
  tileWidth,
  toEquiAngular,
  validateLayout,
} from './eac';
import { type Vec3, dot, normalize, mulVec, quatToMat, rotationBetween } from './math';


const layout = goproMaxLayout(4096, 1344);
const close = (a: Vec3, b: Vec3, eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)));

describe('equi-angular warp', () => {
  it('is its own inverse and fixes the centre and edges', () => {
    for (const a of [-1, -0.5, 0, 0.3, 1]) expect(fromEquiAngular(toEquiAngular(a))).toBeCloseTo(a, 12);
    expect(toEquiAngular(1)).toBeCloseTo(1, 12);
    expect(toEquiAngular(0)).toBe(0);
  });
});

describe('GoPro Max layout', () => {
  it('is a valid un-mirrored cube', () => {
    expect(() => validateLayout(layout)).not.toThrow();
  });

  it('splits the side faces around 32px lens-overlap strips (hard breaks at 688 and 3408)', () => {
    expect(layout.tiles.map((t) => t.x)).toEqual([0, 1376, 2720, 0, 1376, 2720]);
    expect(layout.tiles.map((t) => t.gap)).toEqual([32, 0, 32, 32, 0, 32]);
    // The strip midlines sit exactly where the decoded Max 2 frames break.
    const strip = (t: (typeof layout.tiles)[number]) => t.x + t.size / 2 + t.gap! / 2;
    expect(strip(layout.tiles[0]!)).toBe(688);
    expect(strip(layout.tiles[2]!)).toBe(3408);
  });

  it('places each half of a split face beside its overlap strip', () => {
    const left = layout.tiles[0]!;
    // Just back of the midline (back lens) lands left of the strip, just front of it lands right.
    expect(tilePixel(left, -1e-12, 0)[0]).toBeCloseTo(656.5, 6);
    expect(tilePixel(left, 1e-12, 0)[0]).toBeCloseTo(719.5, 6);
    expect(tilePixel(left, -1, 0)[0]).toBeCloseTo(0, 6);
    expect(tilePixel(left, 1, 0)[0]).toBeCloseTo(1376, 6);
  });

  it('maps the six axes to the centres of their tiles', () => {
    const expected: Record<string, Vec3> = {
      front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
    };
    for (const t of layout.tiles) {
      const s = directionToStream(layout, expected[t.face]!);
      expect(s.face).toBe(t.face);
      expect(s.stream).toBe(t.stream);
      // Split faces have their centre on the strip; es = 0 is drawn from the right-hand half.
      expect(s.x).toBeCloseTo(t.x + t.size / 2 + ((t.gap ?? 0) * 95) / 64, 6);
      expect(s.y).toBeCloseTo(t.y + t.size / 2, 6);
    }
  });

  it('round-trips random directions through stream pixels', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 2000; i++) {
      const d = normalize([rnd(), rnd(), rnd()]);
      const s = directionToStream(layout, d);
      const back = streamToDirection(layout, s.stream, s.x, s.y);
      expect(back).not.toBeNull();
      close(back!, d, 1e-9);
    }
  });

  it('is continuous across every tile edge (neighbouring tiles agree)', () => {
    // Walk a great circle in small steps: consecutive samples must stay near each other on the sphere,
    // and the sampled direction must match the input even when the face changes.
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]] as Vec3[]) {
      const steps = 720;
      for (let i = 0; i < steps; i++) {
        const R = rotationBetween([0, 0, 1], normalize(axis));
        const a = (i / steps) * Math.PI * 2;
        const d = mulVec(R, [Math.cos(a), Math.sin(a), 0]);
        const s = directionToStream(layout, d);
        const tile = layout.tiles.find((t) => t.face === s.face)!;
        const back = streamToDirection(layout, s.stream, Math.min(s.x, tile.x + tileWidth(tile) - 1e-6), Math.min(s.y, 1343.999999));
        expect(dot(back!, d)).toBeGreaterThan(0.99999);
      }
    }
  });

  it('maps overlap-strip pixels to directions just past the lens midline', () => {
    // Left face, centre row: the strip shows directions a few degrees either side of straight left.
    for (const x of [657, 687, 689, 719]) {
      const d = streamToDirection(layout, 0, x, 672)!;
      const deg = (Math.atan2(d[2], -d[0]) * 180) / Math.PI; // 0 = straight left, + = towards front
      expect(Math.abs(deg)).toBeLessThan(2.3);
      expect(Math.sign(deg)).toBe(x < 688 ? 1 : -1); // each half overshoots into the other's side
    }
  });

  it('the two halves share 63 pixels of picture (as measured all round real footage)', () => {
    const left = layout.tiles[0]!;
    // The last columns before the cut show what is 63 pixels on, after it.
    for (const x of [660, 672, 686]) {
      const a = streamToDirection(layout, 0, x, 500)!, b = streamToDirection(layout, 0, x + 63, 500)!;
      expect(dot(a, b)).toBeGreaterThan(1 - 1e-9);
    }
    expect(tilePixel(left, 0.2, 0, 'left')[0]).toBeCloseTo(tilePixel(left, 0.2, 0, 'right')[0] - 63, 6);
  });

  it('scales to other stream sizes (e.g. 3K mode)', () => {
    const small = goproMaxLayout(2272, 736);
    expect(() => validateLayout(small)).not.toThrow();
    expect(small.tiles[1]!.x).toBe(736 + 32);
    expect(small.tiles[2]!.x + tileWidth(small.tiles[2]!)).toBe(2272);
  });
});


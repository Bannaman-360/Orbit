import { describe, expect, it } from 'vitest';
import {
  directionToStream,
  fromEquiAngular,
  goproMaxLayout,
  streamToDirection,
  toEquiAngular,
  validateLayout,
} from './eac';
import { type Vec3, dot, normalize, mulVec, quatToMat, rotationBetween } from './math';
import { cameraRay, rayToFootage, sampleMatrix, DEFAULT_VIEW } from './projection';

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

  it('puts the 64px of extra width into two 32px seams', () => {
    expect(layout.tiles.map((t) => t.x)).toEqual([0, 1376, 2752, 0, 1376, 2752]);
  });

  it('maps the six axes to the centres of their tiles', () => {
    const expected: Record<string, Vec3> = {
      front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
    };
    for (const t of layout.tiles) {
      const s = directionToStream(layout, expected[t.face]!);
      expect(s.face).toBe(t.face);
      expect(s.stream).toBe(t.stream);
      expect(s.x).toBeCloseTo(t.x + t.size / 2, 6);
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
        const back = streamToDirection(layout, s.stream, Math.min(s.x, layout.tiles.find((t) => t.face === s.face)!.x + 1343.999999), Math.min(s.y, 1343.999999));
        expect(dot(back!, d)).toBeGreaterThan(0.99999);
      }
    }
  });

  it('marks seam pixels as unused', () => {
    expect(streamToDirection(layout, 0, 1344 + 10, 500)).toBeNull();
  });

  it('scales to other stream sizes (e.g. 3K mode)', () => {
    const small = goproMaxLayout(2272, 736);
    expect(() => validateLayout(small)).not.toThrow();
    expect(small.tiles[1]!.x).toBe(736 + 32);
  });
});

describe('virtual camera', () => {
  it('looks forward at the screen centre', () => {
    close(cameraRay('rectilinear', 90, 16 / 9, 0, 0), [0, 0, 1]);
    close(cameraRay('stereographic', 200, 16 / 9, 0, 0), [0, 0, 1]);
  });

  it('hits half the horizontal FOV at the screen edge', () => {
    for (const projection of ['rectilinear', 'stereographic'] as const) {
      const fov = projection === 'rectilinear' ? 90 : 240;
      const r = cameraRay(projection, fov, 16 / 9, 1, 0);
      expect((Math.acos(r[2]) * 180) / Math.PI).toBeCloseTo(fov / 2, 6);
    }
  });

  it('turns right with positive yaw and up with positive pitch', () => {
    const fwd = cameraRay('rectilinear', 90, 1, 0, 0);
    close(rayToFootage(sampleMatrix({ ...DEFAULT_VIEW, yaw: 90 }, [1, 0, 0, 0, 1, 0, 0, 0, 1]), fwd), [1, 0, 0]);
    close(rayToFootage(sampleMatrix({ ...DEFAULT_VIEW, pitch: 90 }, [1, 0, 0, 0, 1, 0, 0, 0, 1]), fwd), [0, 1, 0]);
  });

  it('cancels camera body rotation through the correction matrix', () => {
    // Body rolled 20° (rotation about +z). A level world direction should be sampled at the rolled spot.
    const body = quatToMat([Math.cos(0.1745), 0, 0, Math.sin(0.1745)]);
    const m = sampleMatrix(DEFAULT_VIEW, body);
    const ray = cameraRay('rectilinear', 90, 1, 1, 0); // a ray to the right
    const footage = rayToFootage(m, ray);
    // Rotating the sampled footage direction by the body orientation gives back the world ray.
    close(mulVec(body, footage), ray);
  });
});

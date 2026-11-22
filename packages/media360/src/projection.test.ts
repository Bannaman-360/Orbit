import { describe, expect, it } from 'vitest';
import { type Vec3, mulVec, quatToMat } from './math';
import { cameraRay, DEFAULT_VIEW, effectiveLens, lensForward, lensInverse, lensK, maxFovForK, rayToFootage, sampleMatrix, frameShare } from './projection';

const close = (a: Vec3 | null, b: Vec3, digits = 6) => {
  expect(a).not.toBeNull();
  a!.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
};
const deg = (r: Vec3) => (Math.acos(Math.max(-1, Math.min(1, r[2]))) * 180) / Math.PI;
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

describe('lens family', () => {
  it('maps the fisheye slider onto the classic lenses', () => {
    expect(lensK(0)).toBe(1); // rectilinear
    expect(lensK(1 / 3)).toBeCloseTo(0.5, 12); // stereographic
    expect(lensK(2 / 3)).toBeCloseTo(0, 12); // equidistant
    expect(lensK(1)).toBeCloseTo(-0.5, 12); // equisolid
  });

  it('forward and inverse agree for every lens', () => {
    for (const k of [1, 0.75, 0.5, 0.2, 0, -0.25, -0.5])
      for (const th of [0.01, 0.4, 1.0, 1.4]) {
        if (k > 0 && k * th >= Math.PI / 2) continue;
        expect(lensInverse(k, lensForward(k, th))).toBeCloseTo(th, 9);
      }
  });

  it('stays continuous through k = 0', () => {
    expect(lensForward(1e-3, 1)).toBeCloseTo(lensForward(0, 1), 3);
    expect(lensForward(-1e-3, 1)).toBeCloseTo(lensForward(0, 1), 3);
  });
});

describe('virtual camera', () => {
  it('looks forward at the screen centre for every lens', () => {
    for (const k of [1, 0.5, 0, -0.5]) close(cameraRay(k, 90, 16 / 9, 0, 0), [0, 0, 1]);
  });

  it('hits half the horizontal FOV at the screen edge for every lens', () => {
    for (const [k, fov] of [[1, 90], [0.5, 240], [0, 300], [-0.5, 350]] as const)
      expect(deg(cameraRay(k, fov, 16 / 9, 1, 0)!)).toBeCloseTo(fov / 2, 6);
  });

  it('auto-lens adds just enough fisheye to fit any FOV up to 360', () => {
    const lin = effectiveLens({ fov: 100, fisheye: 0, autoLens: true });
    expect(lin.k).toBe(1);
    for (const fov of [170, 200, 300, 360]) {
      const e = effectiveLens({ fov, fisheye: 0, autoLens: true });
      expect(e.fov).toBe(fov);
      expect(fov).toBeLessThanOrEqual(maxFovForK(e.k) + 1e-9);
    }
  });

  it('without auto-lens the FOV is capped by the chosen lens', () => {
    expect(effectiveLens({ fov: 300, fisheye: 0, autoLens: false }).fov).toBeLessThan(180);
  });

  it('turns right with positive yaw and up with positive pitch', () => {
    const fwd: Vec3 = [0, 0, 1];
    close(rayToFootage(sampleMatrix({ ...DEFAULT_VIEW, yaw: 90 }, [...I]), fwd), [1, 0, 0]);
    close(rayToFootage(sampleMatrix({ ...DEFAULT_VIEW, pitch: 90 }, [...I]), fwd), [0, 1, 0]);
  });

  it('cancels camera body rotation through the correction matrix', () => {
    const body = quatToMat([Math.cos(0.1745), 0, 0, Math.sin(0.1745)]);
    const ray = cameraRay(1, 90, 1, 1, 0)!;
    close(mulVec(body, rayToFootage(sampleMatrix(DEFAULT_VIEW, body), ray)), ray);
  });
});

describe('beyond linear', () => {
  it('lets fisheye go below 0 (k > 1) and limits the FOV accordingly', async () => {
    const { lensK, maxFovForK, effectiveLens, cameraRay, lensForward } = await import('./projection');
    expect(lensK(-0.5)).toBeCloseTo(1.75);
    expect(lensK(-2)).toBeCloseTo(1.75); // clamped
    expect(maxFovForK(1.75)).toBeLessThan(102);
    // Narrow enough: used as is.
    expect(effectiveLens({ fov: 80, fisheye: -0.5, autoLens: true }).k).toBeCloseTo(1.75);
    // Too wide: eased back towards linear just enough to fit.
    const wide = effectiveLens({ fov: 140, fisheye: -0.5, autoLens: true });
    expect(wide.k).toBeLessThan(1.75);
    expect(wide.k).toBeGreaterThan(1);
    // The image edge still maps to half the FOV.
    const R = lensForward(1.75, (80 * Math.PI) / 360);
    const ray = cameraRay(1.75, 80, 1, 1, 0)!;
    expect(Math.atan2(ray[0], ray[2]) * (180 / Math.PI)).toBeCloseTo(40, 3);
    expect(R).toBeGreaterThan(Math.tan((40 * Math.PI) / 180)); // edges stretched more than linear
  });
});

describe('frameShare', () => {
  it('matches where rays actually land', () => {
    for (const fov of [30, 75, 110, 140]) for (const fisheye of [0, 0.33, 0.66, 1]) for (const size of [5, 20]) {
      const share = frameShare(size, fov, fisheye);
      const lens = effectiveLens({ fov, fisheye, autoLens: true });
      const ray = cameraRay(lens.k, lens.fov, 16 / 9, share, 0)!;
      expect((Math.atan2(ray[0], ray[2]) * 180) / Math.PI).toBeCloseTo(size / 2, 4);
    }
  });
});

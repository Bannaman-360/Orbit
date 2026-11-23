import { describe, expect, it } from 'vitest';
import { adjustLens, axisAngle, insideFov, lensFor, matPower, mulMat, planeScale, sampleMatrix, transpose, viewInside, viewRotation, type Mat3 } from '@ace/media360';
import { cropAt, hannSmooth, planCropNow, slidingMin, smoothUnder } from './crop';

const R = Math.PI / 180;
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

describe('smoothing helpers', () => {
  it('sliding minimum matches the slow way', () => {
    const x = Array.from({ length: 200 }, rnd);
    for (const r of [0, 1, 5, 40, 500]) expect([...slidingMin(x, r)]).toEqual(x.map((_, i) => Math.min(...x.slice(Math.max(0, i - r), i + r + 1))));
  });
  it('the smooth curve never rises above the original', () => {
    const x = Array.from({ length: 400 }, (_, i) => (i % 57 === 0 ? -1 : rnd() * 0.1));
    for (const r of [1, 7, 30, 90]) {
      const s = smoothUnder(x, r);
      s.forEach((v, i) => expect(v).toBeLessThanOrEqual(x[i]! + 1e-12));
      const jump = (y: ArrayLike<number>) => Math.max(...Array.from({ length: y.length - 1 }, (_, i) => Math.abs(y[i + 1]! - y[i]!)));
      if (r >= 30) expect(jump(s)).toBeLessThan(jump(x) / 8);
    }
    expect([...hannSmooth([1, 2, 3], 0)]).toEqual([1, 2, 3]);
  });
});

describe('crop plan on a really shaking camera', () => {
  const lens = adjustLens(lensFor({ model: 'HERO12', fovMode: 'W' }, 3840, 2160), {});
  const n = 240, scale = planeScale(16 / 9, 16 / 9, 'fill');
  /** Correction at each moment: mostly small, with one violent stretch. */
  const C: Mat3[] = Array.from({ length: n }, (_, i) => {
    const big = i > 100 && i < 130 ? 5 : 1;
    return mulMat(axisAngle([0, 1, 0], big * 3 * R * Math.sin(i * 0.9)), mulMat(axisAngle([1, 0, 0], big * 2 * R * Math.sin(i * 0.63 + 1)), axisAngle([0, 0, 1], 2 * R * Math.cos(i * 0.4))));
  });
  const view = { fov: lens.hfov, fisheye: 0, lens: 'source' as const };
  const m = (i: number, keep: number) => sampleMatrix({ yaw: 0, pitch: 0, roll: 0 }, matPower(C[i]!, keep));
  const plan = (o: Partial<Parameters<typeof planCropNow>[0]>) =>
    planCropNow({ n, want: () => view.fov, fit: (i, k) => insideFov(lens, view, 16 / 9, scale, m(i, k)), mode: 'auto', window: 30, maxCrop: 0.4, amount: 0.1, ...o });
  const exposed = (p: ReturnType<typeof plan>) => C.filter((_, i) => !viewInside(lens, { ...view, fov: view.fov * p.ratio[i]! }, 16 / 9, scale, m(i, p.keep[i]!), 1.004)).length;

  it('automatic never shows an edge, and zooms gently', () => {
    for (const window of [8, 30, 80, Infinity]) {
      const p = plan({ window });
      expect(exposed(p), `window ${window}`).toBe(0);
      if (window >= 30) for (let i = 1; i < n; i++) expect(Math.abs(Math.log(p.ratio[i]! / p.ratio[i - 1]!))).toBeLessThan(0.05);
    }
  });
  it('zooms less where there is less shake', () => {
    const p = plan({ window: 15 });
    expect(p.ratio[20]!).toBeGreaterThan(p.ratio[115]! + 0.1);
    const fixed = plan({ window: Infinity });
    expect(new Set(fixed.ratio).size).toBe(1);
    expect(fixed.ratio[0]!).toBeLessThanOrEqual(Math.min(...p.ratio) + 1e-9);
  });
  it('keeps within the maximum crop by easing the correction back', () => {
    const p = plan({ maxCrop: 0.12 });
    expect(Math.min(...p.ratio)).toBeGreaterThan(0.85);
    expect(Math.min(...p.keep)).toBeLessThan(0.9);
    expect(p.keep[20]!).toBeGreaterThan(p.keep[115]!);
    expect(exposed(p)).toBe(0);
    for (let i = 1; i < n; i++) expect(Math.abs(p.keep[i]! - p.keep[i - 1]!)).toBeLessThan(0.15);
  });
  it('manual uses one fixed crop and still shows no edge', () => {
    const p = plan({ mode: 'manual', amount: 0.15 });
    expect(new Set(p.ratio).size).toBe(1);
    expect(p.ratio[0]!).toBeLessThanOrEqual(0.85 + 1e-9);
    expect(exposed(p)).toBe(0);
  });
  it('no shake, no crop', () => {
    const p = planCropNow({ n: 30, want: () => 90, fit: () => 90, mode: 'auto', window: 10, maxCrop: 0.4, amount: 0 });
    expect([...p.ratio].every((r) => r === 1)).toBe(true);
    expect(cropAt(p, 3.3)).toEqual({ ratio: 1, keep: 1 });
  });
  it('part of a rotation', () => {
    const r = axisAngle([0.3, 1, -0.2], 0.7);
    const half = matPower(r, 0.5);
    mulMat(half, half).forEach((v, i) => expect(v).toBeCloseTo(r[i]!, 6));
    matPower(r, 0).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i]!, 9));
    mulMat(matPower(r, 1), transpose(r)).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i]!, 6));
    expect(viewRotation(0, 0, 0)).toBeTruthy();
  });
});

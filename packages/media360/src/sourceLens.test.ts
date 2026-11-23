import { describe, expect, it } from 'vitest';
import { IDENTITY, viewRotation } from './math';
import { adjustLens, dirToPicture, flatRay, insideFov, lensFor, LINEAR, pictureToDir, planeScale, reachX, stretchX, unstretchX, viewInside, type SourceLens } from './sourceLens';

const R = Math.PI / 180;
const wide = lensFor({ model: 'HERO12 Black', fovMode: 'W' }, 3840, 2160);
const linear = lensFor({ model: 'HERO12 Black', fovMode: 'L' }, 3840, 2160);
const superview = lensFor({ model: 'HERO12 Black', fovMode: 'S' }, 3840, 2160);
const max2 = lensFor({ model: 'MAX2', lenses: { FRNT: [1300.58, 97.83, -110.66, 36.26, -4.632] } }, 3840, 2160);
const all: [string, SourceLens][] = [['wide', wide], ['linear', linear], ['superview', superview], ['max2', max2]];

describe('source lenses', () => {
  it('point → direction → point comes back exactly', () => {
    for (const [name, l] of all) for (let x = -1; x <= 1; x += 0.125) for (let y = -1; y <= 1; y += 0.125) {
      const p = dirToPicture(l, pictureToDir(l, x, y));
      expect(p.x, `${name} ${x},${y}`).toBeCloseTo(x, 4);
      expect(p.y, `${name} ${x},${y}`).toBeCloseTo(y, 4);
    }
  });
  it('covers the stated field of view', () => {
    for (const [, l] of all) {
      const d = pictureToDir(l, 1, 0);
      expect(Math.atan2(d[0], d[2]) / R).toBeCloseTo(l.hfov / 2, 2);
      expect(reachX(l, l.hfov / 2)).toBeCloseTo(1, 5);
    }
  });
  it('linear keeps straight lines straight; wide bends them', () => {
    // A straight wall edge: directions (x, 0.5, 1).
    const bow = (l: SourceLens) => { const y = [-0.6, 0, 0.6].map((x) => dirToPicture(l, [x, 0.3, 1]).y); return Math.abs(y[0]! - y[1]!); };
    expect(bow(linear)).toBeLessThan(1e-6);
    expect(bow(wide)).toBeGreaterThan(0.01);
  });
  it('stretch undoes itself and keeps the middle natural', () => {
    for (const a of [0.6, 0.75, 1]) for (let x = -1; x <= 1; x += 0.1) expect(stretchX(a, unstretchX(a, x))).toBeCloseTo(x, 6);
    expect(stretchX(0.75, 1)).toBe(1);
    expect(superview.stretch).toBeCloseTo(0.75);
  });
  it('reads a diagonal field of view', () => {
    const l = lensFor({ model: 'HERO12', fovMode: 'W', diagonalFov: 150 }, 3840, 2160);
    const c = pictureToDir(l, 1, 1);
    expect((2 * Math.acos(c[2])) / R).toBeCloseTo(150, 0);
    expect(l.from).toBe('file');
  });
  it('adjusting: width, and how bent', () => {
    expect(adjustLens(wide, { hfov: 100 }).hfov).toBe(100);
    expect(adjustLens(wide, undefined)).toBe(wide);
    const straight = adjustLens({ ...wide, hfov: 80 }, { bend: 0 });
    const y = [-0.6, 0, 0.6].map((x) => dirToPicture(straight, [x, 0.3, 1]).y);
    expect(Math.abs(y[0]! - y[1]!)).toBeLessThan(0.004);
  });
});

/** Max 2, HyperView, 4K60: exactly as stored in the recording. */
export const MAX2_HYPERVIEW = {
  model: 'MAX2', fovMode: 'H', diagonalFov: 179.9762420654297, aspectUnwarped: 1.1428571939468384, polyScale: 1.147070288658142,
  poly: [0, 1.3743869066238403, 0.060712363570928574, -0.28420791029930115, 0.11512325704097748, -2.6171293661413943e-14, 8.322173245672859e-15],
  mapX: [1.580514, -8.166883, 74.51987, -451.5002, 1551.292, -2735.542, 1923.157, -0.1086027],
  mapY: [1.023822546005249, -0.10256711393594742, -0.2639929950237274, 0.29792657494544983],
};
describe('GoPro’s own lens description', () => {
  const l = lensFor(MAX2_HYPERVIEW, 3840, 2160);
  it('is used, and agrees with the field of view in the same file', () => {
    expect(l).toMatchObject({ kind: 'gopro', from: 'file', name: 'HyperView' });
    const c = pictureToDir(l, 1, 1);
    expect((2 * Math.acos(c[2])) / R).toBeGreaterThan(178);
    expect((2 * Math.acos(c[2])) / R).toBeLessThan(181);
    expect(l.hfov).toBeGreaterThan(140);
    expect(l.hfov).toBeLessThan(149);
  });
  it('point → direction → point comes back exactly, and grows outwards', () => {
    for (let x = -1; x <= 1; x += 0.1) for (let y = -1; y <= 1; y += 0.1) {
      const p = dirToPicture(l, pictureToDir(l, x, y));
      expect(Math.hypot(p.x - x, p.y - y), `${x.toFixed(1)},${y.toFixed(1)}`).toBeLessThan(2e-3);
    }
    let last = 0;
    for (let x = 0.02; x <= 1; x += 0.02) { const d = pictureToDir(l, x, 0), a = Math.atan2(d[0], d[2]); expect(a).toBeGreaterThan(last); last = a; }
  });
  it('knows what is outside', () => {
    expect(dirToPicture(l, [0, 1, 0.05]).inside).toBe(false);
    expect(dirToPicture(l, [0.1, 0.1, -1]).inside).toBe(false);
    expect(dirToPicture(l, [0.3, 0.2, 1]).inside).toBe(true);
  });
  it('never shows past the edge', () => {
    for (const mode of ['source', 'custom'] as const) for (const [y, p, r] of [[0, 0, 0], [25, 5, 0], [-15, -12, 20], [10, 0, 40]]) {
      const m = viewRotation(y! * R, p! * R, r! * R), s = planeScale(16 / 9, 16 / 9, 'fill');
      const v = { fov: l.hfov, fisheye: 0, lens: mode };
      const fov = insideFov(l, v, 16 / 9, s, m);
      expect(fov).toBeGreaterThan(10);
      expect(viewInside(l, { ...v, fov }, 16 / 9, s, m, 1.004)).toBe(true);
    }
    expect(insideFov(l, { fov: l.hfov, fisheye: 0, lens: 'source' }, 16 / 9, [1, 1], IDENTITY)).toBe(l.hfov);
  });
  it('can be nudged wider, but ignores nonsense', () => {
    expect(adjustLens(l, { hfov: 120 }).hfov).toBeCloseTo(120, 1);
    expect(lensFor({ ...MAX2_HYPERVIEW, polyScale: 9 }, 3840, 2160).kind).not.toBe('gopro');
    expect(lensFor({ ...MAX2_HYPERVIEW, fovMode: 'L' }, 3840, 2160).kind).toBe('linear');
    // Wide: the same glass without the stretch.
    const wide2 = lensFor({ ...MAX2_HYPERVIEW, fovMode: 'W', mapX: undefined, mapY: undefined, diagonalFov: undefined, polyScale: 2 }, 3840, 2160);
    expect(wide2.kind).toBe('gopro');
  });
});

describe('views of a regular clip', () => {
  it('an untouched view shows the picture exactly', () => {
    for (const [, l] of all) for (const [out, how] of [[16 / 9, 'fill'], [9 / 16, 'fill'], [1, 'fit']] as const) {
      const s = planeScale(out, 16 / 9, how);
      for (const [nx, ny] of [[0, 0], [0.4, -0.7], [-0.9, 0.9]] as const) {
        const p = dirToPicture(l, flatRay(l, { fov: l.hfov, fisheye: 0, lens: 'source' }, 16 / 9, s, nx, ny)!);
        expect(p.x).toBeCloseTo(nx * s[0], 4);
        expect(p.y).toBeCloseTo(ny * s[1], 4);
      }
    }
  });
  it('fill crops, fit adds bars', () => {
    expect(planeScale(9 / 16, 16 / 9, 'fill')[0]).toBeCloseTo(81 / 256);
    expect(planeScale(1, 16 / 9, 'fit')[1]).toBeCloseTo(16 / 9);
    expect(planeScale(16 / 9, 16 / 9, 'fill')).toEqual([1, 1]);
  });
  it('never shows past the edge, whatever the pan, tilt, roll or lens', () => {
    let r = 3;
    const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (const [name, l] of all) for (let i = 0; i < 60; i++) {
      const v = { fov: l.hfov * (0.4 + 0.6 * Math.abs(rnd())), fisheye: Math.abs(rnd()), lens: i % 2 ? ('source' as const) : ('custom' as const) };
      const m = viewRotation(rnd() * 25 * R, rnd() * 12 * R, rnd() * 30 * R);
      const out = [16 / 9, 9 / 16, 1][i % 3]!;
      const s = planeScale(out, 16 / 9, 'fill');
      const fov = insideFov(l, v, 16 / 9, s, m);
      expect(fov).toBeGreaterThan(0.5);
      expect(viewInside(l, { ...v, fov }, 16 / 9, s, m, 1.003), name).toBe(true);
    }
  });
  it('an untouched fill view needs no zoom; a fisheye shown as linear needs some', () => {
    const s = planeScale(16 / 9, 16 / 9, 'fill');
    expect(insideFov(wide, { fov: wide.hfov, fisheye: 0, lens: 'source' }, 16 / 9, s, IDENTITY)).toBe(wide.hfov);
    expect(insideFov(wide, { fov: wide.hfov, fisheye: 0, lens: 'custom' }, 16 / 9, s, IDENTITY)).toBeLessThan(wide.hfov);
  });
  it('unknown cameras get a plain lens', () => {
    expect(lensFor({}, 1920, 1080)).toMatchObject({ kind: 'linear', coeffs: LINEAR, from: 'guess' });
  });
});

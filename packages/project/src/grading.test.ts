import { describe, expect, it } from 'vitest';
import {
  applyWheels, bakeCurves, cleanCurves, cleanQualifier, cleanWheels, curvesUsed, filmColor, filmCube, filmLut, FILM_LOOKS, hueAt, mixWheels, NEUTRAL_CURVES, NEUTRAL_WHEELS,
  puckRgb, qualifierMatte, rgbToHsv, hsvToRgb, toneAt, wheelUniforms, DEFAULT_QUALIFIER, CURVE_SIZE, denoiseFrames, cleanDenoise,
} from './grading';
import { mixLook } from './keyframes';
import { DEFAULT_LOOK, withOff } from './look';
import { loadTimeline } from './timeline';

describe('colour wheels', () => {
  it('leave the picture alone when centred', () => {
    const u = wheelUniforms(NEUTRAL_WHEELS);
    for (const c of [[0, 0, 0], [0.2, 0.5, 0.9], [1, 1, 1]] as [number, number, number][]) applyWheels(c, u).forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 6));
  });
  it('push colour without changing brightness', () => {
    const [r, g, b] = puckRgb(0.3, -0.7);
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(0, 3);
    // Up is red.
    expect(puckRgb(0, 1)[0]).toBeGreaterThan(0.5);
    expect(puckRgb(1, 0)[2]).toBeGreaterThan(0.5);
  });
  it('lift moves the blacks, gain the whites, gamma the middle', () => {
    const w = (k: 'lift' | 'gamma' | 'gain', master: number) => wheelUniforms({ ...NEUTRAL_WHEELS, [k]: { x: 0, y: 0, master } });
    expect(applyWheels([0, 0, 0], w('lift', 0.5))[0]).toBeGreaterThan(0.1);
    expect(applyWheels([1, 1, 1], w('lift', 0.5))[0]).toBeCloseTo(1, 6);
    expect(applyWheels([1, 1, 1], w('gain', -0.5))[0]).toBeLessThan(0.8);
    expect(applyWheels([0, 0, 0], w('gain', -0.5))[0]).toBeCloseTo(0, 6);
    const mid = applyWheels([0.5, 0.5, 0.5], w('gamma', 0.5))[0];
    expect(mid).toBeGreaterThan(0.57);
    expect(applyWheels([1, 1, 1], w('gamma', 0.5))[0]).toBeCloseTo(1, 6);
  });
  it('keyframe with the look and switch off to compare', () => {
    const a = { ...DEFAULT_LOOK, wheels: { ...NEUTRAL_WHEELS, gain: { x: 0, y: 0.4, master: 0.2 } } };
    const m = mixLook(a, DEFAULT_LOOK, 0.5);
    expect(m.wheels!.gain.y).toBeCloseTo(0.2);
    expect(mixWheels(undefined, undefined, 0.3)).toBeUndefined();
    expect(withOff(a, ['wheels']).wheels).toBeUndefined();
    expect(cleanWheels({ lift: { x: 3, y: 4, master: 9 } })!.lift).toEqual({ x: 0.6, y: 0.8, master: 1 });
    expect(cleanWheels({})).toBeUndefined();
  });
});

describe('curves', () => {
  it('pass straight through when untouched', () => {
    const d = bakeCurves(NEUTRAL_CURVES);
    for (const i of [0, 64, 200, 255]) {
      expect(d[i * 4]).toBeCloseTo(i / 255, 5);
      expect(d[(CURVE_SIZE + i) * 4]).toBeCloseTo(0.5, 5);
    }
    expect(curvesUsed(NEUTRAL_CURVES)).toEqual({ tone: false, color: false });
  });
  it('bend smoothly through their points without overshooting', () => {
    const pts: [number, number][] = [[0, 0], [0.25, 0.15], [0.75, 0.9], [1, 1]];
    expect(toneAt(pts, 0.25)).toBeCloseTo(0.15, 6);
    let last = -1;
    for (let x = 0; x <= 1; x += 0.01) { const y = toneAt(pts, x); expect(y).toBeGreaterThanOrEqual(last - 1e-9); expect(y).toBeLessThanOrEqual(1); last = y; }
  });
  it('wrap round at red for hue curves', () => {
    const pts: [number, number][] = [[0.05, 0.8], [0.5, 0.5], [0.9, 0.7]];
    expect(hueAt(pts, 0)).toBeCloseTo(hueAt(pts, 1), 6);
    expect(hueAt(pts, 0.05)).toBeCloseTo(0.8, 6);
  });
  it('are kept only when they change something', () => {
    expect(cleanCurves({ master: [[0, 0], [1, 1]] })).toBeUndefined();
    const c = cleanCurves({ master: [[1, 1], [0, 0.1], [0.5, 'x']], hueSat: [[0.6, 0.9]] })!;
    expect(c.master).toEqual([[0, 0.1], [1, 1]]);
    expect(curvesUsed(c)).toEqual({ tone: true, color: true });
  });
});

describe('HSL qualifier', () => {
  it('picks blue sky and leaves the trail', () => {
    const q = { ...DEFAULT_QUALIFIER, hue: 210, hueWidth: 25 };
    expect(qualifierMatte([0.35, 0.55, 0.85], q)).toBeGreaterThan(0.95);
    expect(qualifierMatte([0.55, 0.4, 0.25], q)).toBeLessThan(0.05);
    expect(qualifierMatte([0.55, 0.4, 0.25], { ...q, invert: true })).toBeGreaterThan(0.95);
  });
  it('converts colours to hue and back', () => {
    for (const c of [[0.9, 0.2, 0.1], [0.1, 0.8, 0.3], [0.3, 0.3, 0.9]] as [number, number, number][]) hsvToRgb(...rgbToHsv(...c)).forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 6));
  });
  it('cleans saved settings', () => {
    const q = cleanQualifier({ hue: 400, sat: [0.9, 0.1], hueWidth: 0 })!;
    expect(q.hue).toBe(360);
    expect(q.sat).toEqual([0.1, 0.9]);
    expect(q.hueWidth).toBe(1);
  });
});

describe('film looks and noise reduction', () => {
  it('each film look is a different, valid LUT', () => {
    const seen = new Set<string>();
    for (const [name] of FILM_LOOKS) {
      const { size, data } = filmLut(name, 9);
      expect(data.length).toBe(size ** 3 * 3);
      for (const v of data) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
      seen.add(filmColor(name, [0.6, 0.45, 0.3]).map((v) => v.toFixed(3)).join());
    }
    expect(seen.size).toBe(FILM_LOOKS.length);
    const mono = filmColor('Silver mono', [0.8, 0.2, 0.1]);
    expect(mono[0]).toBeCloseTo(mono[2], 6);
    expect(filmCube('Warm print', 3).split('\n').filter((l) => /^[\d.]+ /.test(l)).length).toBe(27);
  });
  it('temporal reduction looks back over more frames when stronger', () => {
    expect(denoiseFrames(undefined)).toBe(1);
    expect(denoiseFrames({ spatial: 0, temporal: 0.1 })).toBe(2);
    expect(denoiseFrames({ spatial: 0, temporal: 1 })).toBe(6);
    expect(cleanDenoise({ spatial: 0, temporal: 0 })).toBeUndefined();
  });
  it('a saved project keeps the grading and drops what does nothing', () => {
    const tl = loadTimeline({ clips: [{ id: 'a', mediaPath: 'x.mp4', inUs: 0, outUs: 1e6, look: { wheels: { gain: { x: 0.2, y: 0, master: 0 } } }, curves: { master: [[0, 0], [1, 1]] }, film: { look: 'Sepia', mix: 0.5 }, denoise: { spatial: 0.4 }, qualifier: { hue: 20 } }] });
    const c = tl.clips[0]!;
    expect(c.look.wheels?.gain.x).toBeCloseTo(0.2);
    expect(c.curves).toBeUndefined();
    expect(c.film).toEqual({ look: 'Sepia', mix: 0.5 });
    expect(c.denoise).toEqual({ spatial: 0.4, temporal: 0 });
    expect(c.qualifier?.hue).toBe(20);
    expect(c.look.fx.vhs).toBe(0);
  });
});

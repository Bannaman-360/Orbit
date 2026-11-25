import { describe, expect, it } from 'vitest';
import { limit, measureLufs, normalizeLoudness } from './loudness';

const FS = 48000;
const sine = (amp: number, hz = 997, s = 5) => {
  const a = new Float32Array(FS * s);
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / FS);
  return a;
};

describe('loudness (BS.1770)', () => {
  it('a full-scale 1 kHz sine in one channel reads −3 LUFS', () => {
    expect(measureLufs([sine(1)], FS)).toBeCloseTo(-3.01, 1);
  });
  it('stereo at −20 dBFS reads about −20 LUFS; silence reads nothing', () => {
    expect(measureLufs([sine(0.1), sine(0.1)], FS)).toBeCloseTo(-20, 0);
    expect(measureLufs([new Float32Array(FS)], FS)).toBe(-Infinity);
  });
  it('quiet passages below the gate do not pull the reading down', () => {
    const a = new Float32Array(FS * 10);
    a.set(sine(0.1, 997, 5));
    a.set(sine(0.0001, 997, 5), FS * 5);
    expect(measureLufs([a, a.slice()], FS)).toBeCloseTo(-20, 0);
  });
  it('brings sound to the target and keeps peaks under the ceiling', () => {
    const l = sine(0.05), r = sine(0.05);
    const out = normalizeLoudness([l, r], FS, -14, -1);
    expect(out.gainDb).toBeGreaterThan(5);
    const peak = Math.max(...[l, r].map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    expect(peak).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    // A sine pushed into the limiter loses some loudness, but lands close.
    expect(measureLufs([l, r], FS)).toBeGreaterThan(-16);
  });
  it('the limiter leaves quiet sound untouched', () => {
    const a = sine(0.2), b = a.slice();
    limit([a], FS, 0.9);
    expect(a).toEqual(b);
  });
});

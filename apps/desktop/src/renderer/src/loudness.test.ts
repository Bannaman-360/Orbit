import { describe, expect, it } from 'vitest';
import { limit, measureLufs, normalizeLoudness, truePeakDb } from './loudness';

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

describe('true peak', () => {
  it('finds the peak between samples', () => {
    // A sine at a quarter of the sample rate, sampled 45° off its peaks: samples read 0.707, the wave reaches 1.
    const a = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    expect(Math.max(...a)).toBeCloseTo(0.7071, 3);
    expect(truePeakDb([a])).toBeGreaterThan(-0.6);
  });
  it('the limiter holds true peaks under −1 dBTP', () => {
    const a = Float32Array.from({ length: FS }, (_, i) => 0.95 * Math.sin((2 * Math.PI * 11025 * i) / FS + Math.PI / 4));
    const r = normalizeLoudness([a], FS, -14, -1);
    expect(r.truePeak).toBeLessThanOrEqual(-0.9);
    expect(truePeakDb([a])).toBeLessThanOrEqual(-0.9);
  });
  it('can leave the level and only limit', () => {
    const a = sine(0.1);
    const r = normalizeLoudness([a, a.slice()], FS, null);
    expect(r.gainDb).toBe(0);
    expect(r.after).toBeCloseTo(r.before, 3);
  });
});

describe('peaky sound', () => {
  it('still reaches the target after limiting', () => {
    // A quiet tone with loud clicks every half second, like drums or knocks on the microphone.
    const a = sine(0.02, 440, 6);
    for (let i = 0; i < a.length; i += FS / 2) for (let k = 0; k < 400; k++) a[i + k] = (k % 2 ? 0.9 : -0.9) * (1 - k / 400);
    const b = a.slice();
    const r = normalizeLoudness([a, b], FS, -14, -1);
    expect(Math.abs(r.after + 14)).toBeLessThan(0.6);
    expect(r.truePeak).toBeLessThanOrEqual(-0.9);
  });
});

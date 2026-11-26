import { describe, expect, it } from 'vitest';
import { barsAt, BANDS, bandEdges, column, fft, SPECTRUM_STEP_US, type Columns } from './spectrum';

const SR = 48000;
const tone = (hz: number, amp = 0.5, n = SR) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));

describe('sound spectrum', () => {
  it('fft finds a sine', () => {
    const n = 64, re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n)), im = new Float64Array(n);
    fft(re, im);
    expect(Math.hypot(re[5]!, im[5]!)).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[9]!, im[9]!)).toBeLessThan(1e-9);
  });

  it('a tone lights its own band', () => {
    const edges = bandEdges();
    for (const hz of [100, 1000, 8000]) {
      const out = new Uint8Array(BANDS);
      column(tone(hz), SR / 2, SR, out);
      const band = edges.findIndex((e, i) => hz >= e && hz < edges[i + 1]!);
      const loudest = out.indexOf(Math.max(...out));
      expect(Math.abs(loudest - band)).toBeLessThanOrEqual(1);
      // Bands well away from it stay low.
      expect(out[Math.max(0, band - 8)]! + out[Math.min(BANDS - 1, band + 8)]!).toBeLessThan(out[loudest]!);
    }
  });

  it('silence is empty, louder is taller', () => {
    const quiet = new Uint8Array(BANDS), loud = new Uint8Array(BANDS), none = new Uint8Array(BANDS);
    column(tone(1000, 0.05), SR / 2, SR, quiet);
    column(tone(1000, 0.5), SR / 2, SR, loud);
    column(new Float32Array(SR), SR / 2, SR, none);
    expect(Math.max(...none)).toBe(0);
    expect(Math.max(...loud)).toBeGreaterThan(Math.max(...quiet) + 40);
  });

  it('bars fall back smoothly and peak caps hold, then drop', () => {
    // A loud moment at step 10, then nothing.
    const steps = 200, data = new Uint8Array(steps * BANDS);
    data.fill(255, 10 * BANDS, 11 * BANDS);
    const c: Columns = { data, steps, known: new Uint8Array(steps).fill(1) };
    const at = (s: number) => barsAt(c, s * 1e6 + 10 * SPECTRUM_STEP_US);
    expect(at(0).bars[0]).toBeCloseTo(1, 2);
    expect(at(0.25).bars[0]).toBeCloseTo(1 - 0.25 * 1.6, 1);
    expect(at(1).bars[0]).toBe(0);
    expect(at(0.4).peaks[0]).toBeCloseTo(1, 2);
    expect(at(1).peaks[0]).toBeCloseTo(1 - 0.5 * 1.2, 1);
    expect(at(2).peaks[0]).toBe(0);
    // Before it: nothing.
    expect(barsAt(c, 5 * SPECTRUM_STEP_US).bars[0]).toBe(0);
  });
});

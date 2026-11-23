import { describe, expect, it } from 'vitest';
import { HOP, WIN, wsola } from './wsola';

const RATE = 48000;
const tone = (hz: number, s: number) => Float32Array.from({ length: Math.round(RATE * s) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE));
/** Frequency from zero crossings (rising), over the middle of a signal. */
function freq(x: Float32Array) {
  const a = Math.floor(x.length * 0.2), b = Math.floor(x.length * 0.8);
  let first = -1, last = -1, n = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 && x[i]! >= 0) { const t = i - 1 + -x[i - 1]! / (x[i]! - x[i - 1]!); if (first < 0) first = t; last = t; n++; }
  return ((n - 1) * RATE) / (last - first);
}
const level = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i]! ** 2; return Math.sqrt(s / (b - a)); };
/** Where the source is read for each step at a constant speed. */
const steady = (speed: number, length: number) => Float64Array.from({ length: Math.ceil(length / HOP) + 2 }, (_, k) => (k * HOP + WIN / 2) * speed);

describe('sound at another speed, same pitch', () => {
  for (const speed of [0.25, 0.5, 0.8, 1.5, 2, 4]) it(`${speed}×`, () => {
    const src = tone(300, 6), len = Math.floor((src.length / speed) * 0.9);
    const [out] = wsola([src], steady(speed, len), len);
    expect(out!.length).toBe(len);
    expect(Math.abs(freq(out!) / 300 - 1)).toBeLessThan(0.01);
    // Even loudness: no gaps or bumps where pieces meet.
    const rms = [0.3, 0.45, 0.6, 0.75].map((f) => level(out!, Math.floor(len * f), Math.floor(len * f) + 4800));
    for (const r of rms) expect(Math.abs(r / (0.5 / Math.SQRT2) - 1)).toBeLessThan(0.08);
  });
  it('a click lands where it should', () => {
    const src = new Float32Array(RATE * 4);
    for (let i = 0; i < 200; i++) src[RATE * 2 + i] = Math.sin(i / 3) * (1 - i / 200);
    const speed = 0.5, len = RATE * 7, [out] = wsola([src], steady(speed, len), len);
    let peak = 0, at = 0;
    for (let i = 0; i < len; i++) if (Math.abs(out![i]!) > peak) { peak = Math.abs(out![i]!); at = i; }
    expect(Math.abs(at / RATE - 4)).toBeLessThan(0.012);
  });
  it('keeps both channels', () => {
    const l = tone(300, 2), r = tone(450, 2), len = RATE * 3;
    const [a, b] = wsola([l, r], steady(2 / 3, len), len);
    expect(Math.abs(freq(a!) / 300 - 1)).toBeLessThan(0.015);
    expect(Math.abs(freq(b!) / 450 - 1)).toBeLessThan(0.015);
  });
});

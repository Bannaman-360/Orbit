import { describe, expect, it } from 'vitest';
import { findBeats } from './beats';

const RATE = 44100;

/** A drum pattern: a kick on bar starts, snare-ish clicks on other beats, some noise. */
function pattern(bpm: number, seconds: number, offset = 0.25, noise = 0.02) {
  const n = Math.round(seconds * RATE), x = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < n; i++) x[i] = rnd() * noise;
  const period = 60 / bpm;
  for (let b = 0, t = offset; t < seconds - 0.2; b++, t += period) {
    const start = Math.round(t * RATE), kick = b % 4 === 0;
    for (let i = 0; i < 0.12 * RATE && start + i < n; i++) {
      const e = Math.exp(-i / (0.02 * RATE));
      x[start + i]! += kick ? 0.8 * e * Math.sin((2 * Math.PI * 60 * i) / RATE) : 0.4 * e * rnd() * 2;
    }
  }
  return { x, period, offset };
}

describe('beat detection', () => {
  for (const bpm of [90, 120, 140, 174]) {
    it(`finds ${bpm} BPM and its beats to about 20 ms`, () => {
      const { x, period, offset } = pattern(bpm, 20);
      const g = findBeats([x], RATE);
      // (Half or double tempo would also be musically right, but these are clear.)
      expect(Math.abs(g.bpm - bpm)).toBeLessThan(bpm * 0.02);
      const inner = g.beats.filter((t) => t > 2 && t < 18);
      for (const t of inner) {
        const k = Math.round((t - offset) / period);
        expect(Math.abs(t - (offset + k * period))).toBeLessThan(0.025);
      }
      expect(inner.length).toBeGreaterThan(((16 / 60) * bpm) * 0.9);
    });
  }
  it('puts bars on the kicks', () => {
    const { x, period, offset } = pattern(120, 16);
    const g = findBeats([x], RATE);
    const firstBar = g.beats[g.downbeats[0]!]!;
    const k = Math.round((firstBar - offset) / period);
    expect(((k % 4) + 4) % 4).toBe(0);
  });
  it('says when there is no steady beat', () => {
    const { x } = pattern(120, 10, 0.25, 0.3);
    const steady = findBeats([x], RATE).confidence;
    const silenceish = findBeats([new Float32Array(10 * RATE).map(() => (Math.random() - 0.5) * 0.1)], RATE).confidence;
    expect(silenceish).toBeLessThan(steady);
  });
});

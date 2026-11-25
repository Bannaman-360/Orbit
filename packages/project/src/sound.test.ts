import { describe, expect, it } from 'vitest';
import { cleanSound, duckBlock, fftInPlace, isNeutralSound, newDuckState, WIND_FRAME, WindReducer } from './sound';

const SR = 48000;
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; }; }
/** Low rumble like wind: noise through a one-pole low-pass. */
function rumble(n: number, seed: number) {
  const r = rng(seed), out = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) { y = 0.985 * y + 0.015 * r() * 40; out[i] = y; }
  return out;
}
const tone = (n: number, f: number, a: number) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));
const run = (w: WindReducer, chans: Float32Array[]) => {
  const n = chans[0]!.length, out = chans.map(() => new Float32Array(n));
  for (let i = 0; i < n; i += 128) w.process(chans.map((c) => c.subarray(i, i + 128)), out.map((c) => c.subarray(i, i + 128)));
  return out;
};
/** Energy in a band (Hz) of a stretch of signal. */
function band(x: Float32Array, from: number, to: number) {
  const N = 8192, re = new Float32Array(N), im = new Float32Array(N);
  re.set(x.subarray(x.length - N));
  fftInPlace(re, im);
  let e = 0;
  for (let k = Math.round((from * N) / SR); k <= Math.round((to * N) / SR); k++) e += re[k]! ** 2 + im[k]! ** 2;
  return e;
}

describe('FFT', () => {
  it('goes there and back', () => {
    const r = rng(1), re = Float32Array.from({ length: 64 }, r), keep = re.slice(), im = new Float32Array(64);
    fftInPlace(re, im); fftInPlace(re, im, true);
    re.forEach((v, i) => expect(v).toBeCloseTo(keep[i]!, 5));
  });
});

describe('wind reduction', () => {
  it('passes sound through untouched (one frame late) when off', () => {
    const x = tone(SR / 2, 440, 0.5);
    const [y] = run(new WindReducer(1, SR, 0), [x]);
    for (let i = 5000; i < 6000; i++) expect(y![i]!).toBeCloseTo(x[i - (WIND_FRAME - 1)]!, 3);
  });
  it('turns down wind and keeps the voice', () => {
    const n = SR * 2;
    const voice = tone(n, 1200, 0.1);
    const l = rumble(n, 7), r = rumble(n, 99);
    const L = l.map((v, i) => v + voice[i]!), R = r.map((v, i) => v + voice[i]!);
    const [yl] = run(new WindReducer(2, SR, 1), [L, R]);
    const windBefore = band(L, 20, 300), windAfter = band(yl!, 20, 300);
    expect(10 * Math.log10(windBefore / windAfter)).toBeGreaterThan(8);
    const vBefore = band(L, 1100, 1300), vAfter = band(yl!, 1100, 1300);
    expect(Math.abs(10 * Math.log10(vBefore / vAfter))).toBeLessThan(1.5);
  });
  it('leaves a low sound that both microphones hear alike', () => {
    const n = SR * 2, bass = tone(n, 110, 0.3);
    const [y] = run(new WindReducer(2, SR, 1), [bass, bass]);
    expect(Math.abs(10 * Math.log10(band(bass, 90, 130) / band(y!, 90, 130)))).toBeLessThan(3);
  });
});

describe('ducking', () => {
  it('turns music down while there is talking and back up after', () => {
    const n = SR * 4, music = [new Float32Array(n).fill(0.5)], key = [new Float32Array(n)];
    for (let i = SR; i < 2 * SR; i++) key[0]![i] = Math.sin(i / 7) * 0.3;
    const out = [new Float32Array(n)], st = newDuckState();
    for (let i = 0; i < n; i += 128) duckBlock(music.map((c) => c.subarray(i, i + 128)), key.map((c) => c.subarray(i, i + 128)), 12, SR, st, out.map((c) => c.subarray(i, i + 128)));
    expect(out[0]![SR - 10]).toBeCloseTo(0.5, 3);
    expect(20 * Math.log10(out[0]![Math.round(1.8 * SR)]! / 0.5)).toBeCloseTo(-12, 0);
    expect(out[0]![n - 1]!).toBeGreaterThan(0.45);
  });
  it('a steady roar does not keep the music down, words above it do', () => {
    const n = SR * 8, r = rng(3);
    const noise = Float32Array.from({ length: n }, () => r() * 0.02);
    const words = noise.slice();
    // Bursts of "speech" (20 dB above the roar) from 5 s on: 0.3 s on, 0.2 s off.
    for (let i = 5 * SR; i < n; i++) if ((i % (SR / 2)) < 0.3 * SR) words[i] = words[i]! + Math.sin(i / 5) * 0.2;
    const duck = (key: Float32Array) => {
      const music = [new Float32Array(n).fill(0.5)], out = [new Float32Array(n)], st = newDuckState();
      for (let i = 0; i < n; i += 128) duckBlock(music.map((c) => c.subarray(i, i + 128)), [key.subarray(i, i + 128)], 12, SR, st, out.map((c) => c.subarray(i, i + 128)));
      return out[0]!;
    };
    const steady = duck(noise), talking = duck(words);
    // (The first moment, before the background is known, doesn't count.)
    expect(steady.subarray(2 * SR, 5 * SR).reduce((a, b) => Math.min(a, b), 1)).toBeGreaterThan(0.45);
    expect(talking[Math.round(7.2 * SR)]!).toBeLessThan(0.2);
  });
});

describe('sound settings', () => {
  it('are cleaned when loaded', () => {
    expect(cleanSound(null)).toBeUndefined();
    expect(cleanSound({ low: 50, comp: 'loud', wind: 2, lowCut: 5, duck: 40, voice: 'yes' })).toEqual({ low: 12, mid: 0, high: 0, lowCut: 20, comp: 'off', wind: 1, duck: 24 });
    expect(isNeutralSound(cleanSound({}))).toBe(true);
    expect(isNeutralSound(cleanSound({ wind: 0.2 }))).toBe(false);
  });
});

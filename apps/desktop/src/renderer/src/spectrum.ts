// Sound spectrum, the maths: how strong each band of pitches is, moment by moment, and how the
// bars fall back and their peak caps drop. Pure (tested in spectrum.test.ts); soundSpectrum.ts
// reads each file's sound and keeps the result.

/** Bands, spaced evenly in pitch from LOW_HZ to HIGH_HZ. */
export const BANDS = 32;
export const LOW_HZ = 40, HIGH_HZ = 16000;
/** One column of bands every this many µs. */
export const SPECTRUM_STEP_US = 25_000;
/** Window analysed for each column (samples, a power of two). */
export const FFT_N = 2048;
/** Levels shown: this many dB below full scale is empty, FLOOR_DB + RANGE_DB is full. */
const FLOOR_DB = -72, RANGE_DB = 60;

/** In-place radix-2 FFT of re/im (length a power of two). */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q]! * cr - im[q]! * ci, ti = re[q]! * ci + im[q]! * cr;
        re[q] = re[p]! - tr; im[q] = im[p]! - ti;
        re[p] = re[p]! + tr; im[p] = im[p]! + ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Band edges (Hz), BANDS + 1 of them. */
export const bandEdges = (): number[] => Array.from({ length: BANDS + 1 }, (_, i) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / BANDS));

const hann = Float64Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));

/**
 * One column: band levels 0–255 for the window of `mono` centred on sample `at`. Higher bands get
 * a gentle lift (3 dB an octave), as music analyzers do, so cymbals show beside the bass.
 */
export function column(mono: Float32Array, at: number, sampleRate: number, out: Uint8Array, offset = 0) {
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const s0 = Math.round(at - FFT_N / 2);
  for (let i = 0; i < FFT_N; i++) { const s = mono[s0 + i]; re[i] = (s ?? 0) * hann[i]!; }
  fft(re, im);
  const edges = bandEdges(), hz = sampleRate / FFT_N;
  // (A full-scale sine wave through the window comes out at 0 dB.)
  const norm = 4 / (FFT_N * FFT_N);
  for (let b = 0; b < BANDS; b++) {
    const k0 = Math.max(1, Math.floor(edges[b]! / hz)), k1 = Math.max(k0 + 1, Math.ceil(edges[b + 1]! / hz));
    let p = 0;
    for (let k = k0; k < Math.min(k1, FFT_N / 2); k++) p = Math.max(p, re[k]! * re[k]! + im[k]! * im[k]!);
    const db = 10 * Math.log10(p * norm + 1e-12) + 3 * Math.log2(Math.sqrt(edges[b]! * edges[b + 1]!) / 1000);
    out[offset + b] = Math.round(255 * Math.max(0, Math.min(1, (db - FLOOR_DB) / RANGE_DB)));
  }
}

/** A file's columns: BANDS values per step, in order. NaN-free: missing columns are all 0. */
export interface Columns { data: Uint8Array; steps: number; known: Uint8Array }

/** How fast bars fall (share of full height a second), and how long peak caps hold before dropping. */
export const FALL_PER_S = 1.6, PEAK_HOLD_S = 0.5, PEAK_FALL_PER_S = 1.2;

/**
 * The bars at a time (0–1 each), falling back smoothly after loud moments, and their peak caps.
 * Worked out from the columns alone, so any frame draws the same however it's reached.
 */
export function barsAt(c: Columns | null, mediaUs: number): { bars: Float32Array; peaks: Float32Array } {
  const bars = new Float32Array(BANDS), peaks = new Float32Array(BANDS);
  if (!c) return { bars, peaks };
  const x = mediaUs / SPECTRUM_STEP_US, i = Math.floor(x), f = x - i;
  const dt = SPECTRUM_STEP_US / 1e6;
  const val = (j: number, b: number) => (j >= 0 && j < c.steps ? c.data[j * BANDS + b]! / 255 : 0);
  const look = Math.ceil(1 / (FALL_PER_S * dt));
  const peakLook = Math.ceil((PEAK_HOLD_S + 1 / PEAK_FALL_PER_S) / dt);
  for (let b = 0; b < BANDS; b++) {
    const now = val(i, b) * (1 - f) + val(i + 1, b) * f;
    let v = now;
    for (let k = 1; k <= look; k++) v = Math.max(v, val(i - k + 1, b) - (k - f) * dt * FALL_PER_S);
    let p = v;
    for (let k = 1; k <= peakLook; k++) {
      const age = (k - f) * dt;
      p = Math.max(p, val(i - k + 1, b) - Math.max(0, age - PEAK_HOLD_S) * PEAK_FALL_PER_S);
    }
    bars[b] = v;
    peaks[b] = p;
  }
  return { bars, peaks };
}

/** A made-up song for gauge previews: a kick on the beat, a bass line and a hi-hat. */
export function sampleBars(mediaUs: number): { bars: Float32Array; peaks: Float32Array } {
  const t = mediaUs / 1e6, beat = Math.exp(-((t * 2) % 1) * 5);
  const bars = new Float32Array(BANDS), peaks = new Float32Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const u = b / (BANDS - 1);
    const v = 0.25 + 0.55 * beat * Math.exp(-u * 4) + 0.3 * Math.exp(-(((u - 0.35) / 0.12) ** 2)) * (0.6 + 0.4 * Math.sin(t * 3 + b)) + 0.25 * Math.exp(-(((u - 0.85) / 0.1) ** 2)) * ((t * 4) % 1 < 0.3 ? 1 : 0.3);
    bars[b] = Math.min(1, v * (0.9 + 0.1 * Math.sin(b * 1.7 + t * 5)));
    peaks[b] = Math.min(1, bars[b]! + 0.08);
  }
  return { bars, peaks };
}

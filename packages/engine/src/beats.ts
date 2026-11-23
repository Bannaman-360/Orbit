// Beats in music: where the onsets are (spectral flux), how fast the music goes (autocorrelation
// of the onsets, preferring the usual 70–180 BPM), then the beat positions that best follow both
// (dynamic programming, after Ellis 2007). Bars are guessed from where the low notes hit hardest.

export interface BeatGrid {
  /** Beats per minute. */
  bpm: number;
  /** Beat times, seconds from the start of the audio. */
  beats: number[];
  /** Indexes into `beats` that start a bar (every 4th, at the strongest phase). */
  downbeats: number[];
  /** 0–1: how clearly the music has a steady beat. */
  confidence: number;
}

const RATE = 11025;
const FRAME = 1024;
const HOP = 128;
const FPS = RATE / HOP;
const ONSET_LAG_S = 0.033;

/** Mono samples at any rate → about 11 kHz (box filter, enough for onsets). */
function downmix(channels: Float32Array[], rate: number): Float32Array {
  const n = channels[0]?.length ?? 0;
  const step = rate / RATE, out = new Float32Array(Math.floor(n / step));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * step), b = Math.min(n, Math.floor((i + 1) * step));
    let s = 0;
    for (let k = a; k < b; k++) for (const ch of channels) s += ch[k]!;
    out[i] = s / Math.max(1, (b - a) * channels.length);
  }
  return out;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Onset strength per hop (log-magnitude spectral flux), plus low-band energy for bar finding. */
export function onsetStrength(mono: Float32Array): { onset: Float32Array; low: Float32Array } {
  const frames = Math.max(0, Math.floor((mono.length - FRAME) / HOP) + 1);
  const onset = new Float32Array(frames), low = new Float32Array(frames);
  const win = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  let prev = new Float64Array(FRAME / 2);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const lowBins = Math.round((150 / RATE) * FRAME);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = mono[o + i]! * win[i]!; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(FRAME / 2);
    let flux = 0, lo = 0;
    for (let k = 1; k < FRAME / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      const d = mag[k]! - prev[k]!;
      if (d > 0) flux += d;
      if (k <= lowBins) lo += mag[k]!;
    }
    onset[f] = flux;
    low[f] = lo;
    prev = mag;
  }
  // Take away the slowly changing part, keep only rises.
  const out = new Float32Array(frames), w = Math.round(FPS * 0.5);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) { s += onset[k]!; c++; }
    out[f] = Math.max(0, onset[f]! - s / c);
  }
  return { onset: out, low };
}

/** The beat period (in hops) the onsets repeat at most strongly, weighted towards ~120 BPM. */
function tempoOf(onset: Float32Array): { period: number; strength: number } {
  const minLag = Math.floor((60 / 200) * FPS), maxLag = Math.ceil((60 / 55) * FPS);
  let mean = 0;
  for (const v of onset) mean += v;
  mean /= onset.length || 1;
  const ac = (lag: number) => { let s = 0; for (let i = lag; i < onset.length; i++) s += (onset[i]! - mean) * (onset[i - lag]! - mean); return s / (onset.length - lag); };
  const zero = ac(0) || 1;
  let best = minLag, bestScore = -Infinity, bestRaw = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // A beat at this lag also shows at twice the lag: count both.
    const raw = ac(lag) + 0.5 * (2 * lag < onset.length ? ac(2 * lag) : 0);
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = raw * prior;
    if (score > bestScore) { bestScore = score; best = lag; bestRaw = raw; }
  }
  // Fast music (drum & bass, punk) also repeats at twice the beat length: when the half-length
  // repeat is nearly as strong, the faster tempo is the real one.
  const half = Math.round(best / 2);
  if ((60 * FPS) / half <= 200 && half >= minLag && ac(half) > 0.6 * ac(best)) { best = half; bestRaw = ac(half); }
  // Refine to a fraction of a hop.
  const y0 = ac(best - 1), y1 = ac(best), y2 = ac(best + 1);
  const d = y0 - 2 * y1 + y2 ? (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2) : 0;
  return { period: best + Math.max(-0.5, Math.min(0.5, d)), strength: Math.max(0, Math.min(1, bestRaw / zero)) };
}

export function findBeats(channels: Float32Array[], sampleRate: number): BeatGrid {
  const mono = downmix(channels, sampleRate);
  const { onset, low } = onsetStrength(mono);
  const n = onset.length;
  if (n < FPS * 2) return { bpm: 0, beats: [], downbeats: [], confidence: 0 };
  const { period, strength } = tempoOf(onset);
  // Best path of beats: each beat scores its onset, minus a penalty for straying from the period.
  const tight = 100;
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  let norm = 0;
  for (const v of onset) norm = Math.max(norm, v);
  const o = Array.from(onset, (v) => v / (norm || 1));
  for (let i = 0; i < n; i++) {
    let best = 0, from = -1;
    for (let j = Math.max(0, Math.round(i - 2 * period)); j <= i - Math.round(period / 2); j++) {
      const s = score[j]! - tight * Math.log((i - j) / period) ** 2;
      if (s > best) { best = s; from = j; }
    }
    score[i] = o[i]! + best;
    back[i] = from;
  }
  // Start from the best place near the end and walk back.
  let end = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i]! > score[end]!) end = i;
  const idx: number[] = [];
  for (let i = end; i >= 0; i = back[i]!) idx.push(i);
  idx.reverse();
  // (A hit shows up in the onsets about a third of a window after it starts: measured 33 ms.)
  const beats = idx.map((i) => +((i * HOP + FRAME / 2) / RATE + ONSET_LAG_S).toFixed(4));
  // Bars: of the four phases, the one whose beats carry the most low-end energy.
  let phase = 0, bestLow = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let k = ph; k < idx.length; k += 4) s += low[idx[k]!]!;
    if (s > bestLow) { bestLow = s; phase = ph; }
  }
  const downbeats: number[] = [];
  for (let k = phase; k < beats.length; k += 4) downbeats.push(k);
  return { bpm: +((60 * FPS) / period).toFixed(1), beats, downbeats, confidence: +strength.toFixed(2) };
}

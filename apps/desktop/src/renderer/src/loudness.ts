// Loudness of the exported sound (ITU-R BS.1770: K-weighting, 400 ms blocks, gated), and bringing
// it to a target (an export preset's: −14 LUFS for most platforms) with a peak limiter so the
// louder result never clips. Pure functions on plain sample arrays, so they can be tested.

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** The two K-weighting filters for a sample rate (shelf, then high-pass), normalised so a0 = 1. */
function kWeighting(fs: number): [Biquad, Biquad] {
  // Stage 1: high shelf (+4 dB above ~1.7 kHz, the head's effect). Same design as libebur128.
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs), Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q + K * K;
  const shelf: Biquad = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  // Stage 2: high-pass at ~38 Hz.
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / fs), d = 1 + K1 / Q1 + K1 * K1;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K1 * K1 - 1)) / d, a2: (1 - K1 / Q1 + K1 * K1) / d };
  return [shelf, hp];
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const o = f.b0 * v + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o;
    y[i] = o;
  }
  return y;
}

/** Integrated loudness in LUFS (−Infinity for silence). Channels are treated as left/right/centre (weight 1). */
export function measureLufs(channels: Float32Array[], sampleRate: number): number {
  if (!channels.length || !channels[0]!.length) return -Infinity;
  const [shelf, hp] = kWeighting(sampleRate);
  const weighted = channels.map((c) => filter(filter(c, shelf), hp));
  const block = Math.round(0.4 * sampleRate), step = Math.round(0.1 * sampleRate);
  const n = weighted[0]!.length;
  // Running sums of squares make every 400 ms block cheap.
  const sq = weighted.map((c) => {
    const s = new Float64Array(c.length + 1);
    for (let i = 0; i < c.length; i++) s[i + 1] = s[i]! + c[i]! * c[i]!;
    return s;
  });
  const powers: number[] = [];
  for (let start = 0; start + block <= n || (powers.length === 0 && start === 0); start += step) {
    const end = Math.min(n, start + block), len = end - start;
    if (len <= 0) break;
    let z = 0;
    for (const s of sq) z += (s[end]! - s[start]!) / len;
    powers.push(z);
    if (end >= n) break;
  }
  const lufs = (z: number) => -0.691 + 10 * Math.log10(z);
  const loud = powers.filter((z) => z > 0 && lufs(z) > -70);
  if (!loud.length) return -Infinity;
  const mean = (l: number[]) => l.reduce((a, b) => a + b, 0) / l.length;
  const gate = lufs(mean(loud)) - 10;
  const kept = loud.filter((z) => lufs(z) > gate);
  return lufs(mean(kept.length ? kept : loud));
}

// ---- True peak (BS.1770-4 annex 2): the peak between samples, found by 4× oversampling ---------

const OVER = 4, TAPS = 12; // taps per phase (48 in all)
/** Polyphase interpolation filter: phase p gives the value p/4 of the way to the next sample. */
const PHASES: Float32Array[] = Array.from({ length: OVER - 1 }, (_, k) => {
  const frac = (k + 1) / OVER, h = new Float32Array(TAPS);
  for (let j = 0; j < TAPS; j++) {
    const x = j - (TAPS / 2 - 1) - frac; // sample offset from the point
    const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS / 2)); // Hann window
    h[j] = sinc * w;
  }
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / sum);
});

/** The highest peak at or just after each sample (the sample and the three points to the next one). */
function peaksBetween(c: Float32Array): Float32Array {
  const n = c.length, out = new Float32Array(n);
  const at = (i: number) => (i < 0 || i >= n ? 0 : c[i]!);
  for (let i = 0; i < n; i++) {
    let p = Math.abs(c[i]!);
    for (const h of PHASES) {
      let v = 0;
      for (let j = 0; j < TAPS; j++) v += h[j]! * at(i + j - (TAPS / 2 - 1));
      p = Math.max(p, Math.abs(v));
    }
    out[i] = p;
  }
  return out;
}

/** True peak of the sound, dBTP (−Infinity for silence). */
export function truePeakDb(channels: Float32Array[]): number {
  let p = 0;
  for (const c of channels) { const q = peaksBetween(c); for (let i = 0; i < q.length; i++) if (q[i]! > p) p = q[i]!; }
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

export interface LoudnessResult {
  /** Loudness before (LUFS) and after; gain applied (dB); true peak after (dBTP). */
  before: number;
  after: number;
  gainDb: number;
  truePeak: number;
}

/**
 * Brings the sound to `target` LUFS (or leaves its level when target is null), with true peaks held
 * under `ceilingDb` dBTP by a limiter that turns down just ahead of each peak and recovers
 * smoothly. Changes the channels in place. Silence is left alone.
 */
export function normalizeLoudness(channels: Float32Array[], sampleRate: number, target: number | null, ceilingDb = -1): LoudnessResult {
  const before = measureLufs(channels, sampleRate);
  if (!Number.isFinite(before)) return { before, after: before, gainDb: 0, truePeak: -Infinity };
  // (Never more than +24 dB: very quiet sound is mostly noise.)
  let gainDb = target === null ? 0 : Math.max(-40, Math.min(24, target - before));
  const scale = (db: number) => { const g = 10 ** (db / 20); for (const c of channels) for (let i = 0; i < c.length; i++) c[i]! *= g; };
  if (gainDb) scale(gainDb);
  limit(channels, sampleRate, 10 ** (ceilingDb / 20));
  let after = measureLufs(channels, sampleRate);
  // Peaky sound (drums, knocks on the mic) loses loudness in the limiter: make up for it a few
  // times, until it lands within half a dB of the target (or the gain limit is reached).
  for (let i = 0; i < 10 && target !== null && after < target - 0.5 && gainDb < 24; i++) {
    const more = Math.min(24 - gainDb, (target - after) * 1.5);
    scale(more);
    gainDb += more;
    limit(channels, sampleRate, 10 ** (ceilingDb / 20));
    after = measureLufs(channels, sampleRate);
  }
  // (Pushed a little past it: turning down needs no limiting.)
  if (target !== null && after > target + 0.3) {
    scale(target - after);
    gainDb += target - after;
    after = measureLufs(channels, sampleRate);
  }
  return { before, after, gainDb, truePeak: truePeakDb(channels) };
}

/**
 * Holds every true peak under `ceiling`: a gain that ramps down 5 ms before a peak and back up
 * over 80 ms. (Aims a little under, since turning down changes the in-between points slightly.)
 */
export function limit(channels: Float32Array[], sampleRate: number, ceiling: number) {
  const n = channels[0]?.length ?? 0;
  const need = new Float32Array(n);
  let over = false;
  const aim = ceiling * 0.985;
  const peaks = channels.map(peaksBetween);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const q of peaks) p = Math.max(p, q[i]!, i > 0 ? q[i - 1]! : 0);
    need[i] = p > aim ? aim / p : 1;
    if (p > aim) over = true;
  }
  if (!over) return;
  const attack = 1 / Math.max(1, 0.005 * sampleRate), release = 1 / Math.max(1, 0.08 * sampleRate);
  for (let i = n - 2; i >= 0; i--) need[i] = Math.min(need[i]!, need[i + 1]! + attack);
  for (let i = 1; i < n; i++) need[i] = Math.min(need[i]!, need[i - 1]! + release);
  for (const c of channels) for (let i = 0; i < n; i++) c[i]! *= need[i]!;
}

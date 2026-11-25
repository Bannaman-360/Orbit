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

/**
 * Brings the sound to `target` LUFS, with peaks held under `ceilingDb` (dBFS) by a limiter that
 * turns down just ahead of each peak and recovers smoothly. Changes the channels in place and
 * returns the loudness before and the gain applied (dB). Silence is left alone.
 */
export function normalizeLoudness(channels: Float32Array[], sampleRate: number, target: number, ceilingDb = -1): { before: number; gainDb: number } {
  const before = measureLufs(channels, sampleRate);
  if (!Number.isFinite(before)) return { before, gainDb: 0 };
  // (Never more than +24 dB: very quiet sound is mostly noise.)
  const gainDb = Math.max(-40, Math.min(24, target - before));
  const g = 10 ** (gainDb / 20);
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i]! *= g;
  limit(channels, sampleRate, 10 ** (ceilingDb / 20));
  return { before, gainDb };
}

/** Holds every sample under `ceiling`: a gain that ramps down 5 ms before a peak and back up over 80 ms. */
export function limit(channels: Float32Array[], sampleRate: number, ceiling: number) {
  const n = channels[0]?.length ?? 0;
  const need = new Float32Array(n);
  let over = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of channels) p = Math.max(p, Math.abs(c[i]!));
    need[i] = p > ceiling ? ceiling / p : 1;
    if (p > ceiling) over = true;
  }
  if (!over) return;
  const attack = 1 / Math.max(1, 0.005 * sampleRate), release = 1 / Math.max(1, 0.08 * sampleRate);
  for (let i = n - 2; i >= 0; i--) need[i] = Math.min(need[i]!, need[i + 1]! + attack);
  for (let i = 1; i < n; i++) need[i] = Math.min(need[i]!, need[i - 1]! + release);
  for (const c of channels) for (let i = 0; i < n; i++) c[i]! *= need[i]!;
}

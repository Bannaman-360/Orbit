// Changing how long sound lasts without changing its pitch (WSOLA: waveform-similarity
// overlap-add). Pieces of the original are laid end to end at the new pace; each is shifted a
// little to fit the one before, so the waves join without a seam.

/** Window length and step (samples at 48 kHz: about 21 ms and 10.7 ms). */
export const WIN = 1024;
export const HOP = WIN / 2;
/** How far a piece may be shifted to fit (samples). */
export const SEEK = 256;

let hann: Float32Array | null = null;
const window = () => (hann ??= Float32Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN)));

/**
 * `src`: channels of the original. `centres[k]`: where in `src` (samples) the output's k-th step
 * (centred at k·HOP + WIN/2) should come from. Returns `length` samples per channel.
 */
export function wsola(src: Float32Array[], centres: Float64Array, length: number): Float32Array[] {
  const w = window(), n = src[0]?.length ?? 0;
  const out = src.map(() => new Float32Array(length + WIN));
  const mono = src.length > 1 ? Float32Array.from(src[0]!, (v, i) => (v + src[1]![i]!) / 2) : src[0]!;
  const at = (i: number) => (i >= 0 && i < n ? mono[i]! : 0);
  let prev = -1;
  for (let k = 0; k < centres.length; k++) {
    const os = k * HOP;
    if (os >= length + WIN) break;
    let start = Math.round(centres[k]! - WIN / 2);
    if (prev >= 0) {
      // Fit to what would naturally have followed the last piece.
      const want = prev + HOP;
      let best = -Infinity, bestD = 0;
      for (let d = -SEEK; d <= SEEK; d += 2) {
        let c = 0;
        const s = start + d;
        for (let j = 0; j < HOP; j += 4) c += at(s + j) * at(want + j);
        if (c > best) { best = c; bestD = d; }
      }
      for (const d of [bestD - 1, bestD + 1]) {
        let c = 0;
        const s = start + d;
        for (let j = 0; j < HOP; j += 4) c += at(s + j) * at(want + j);
        if (c > best) { best = c; bestD = d; }
      }
      start += bestD;
    }
    for (let ch = 0; ch < src.length; ch++) {
      const o = out[ch]!, x = src[ch]!;
      for (let j = 0; j < WIN; j++) { const i = start + j; if (i >= 0 && i < n) o[os + j]! += x[i]! * w[j]!; }
    }
    prev = start;
  }
  return out.map((o) => o.subarray(0, length));
}

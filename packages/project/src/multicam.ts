// Multicam: recordings of the same moment from several cameras ("angles"), lined up in time.
// A group stores where each angle starts on a shared clock. Cutting between angles writes
// ordinary main-row cuts tagged with the group, so every later edit works as usual, and the angle
// of any cut can still be switched.

import { newClip, newId, type Timeline, type TimelineClip } from './timeline';

export interface MulticamAngle {
  path: string;
  /** Where the recording starts on the group's clock (µs). */
  offsetUs: number;
  durationUs: number;
}
export interface MulticamGroup {
  id: string;
  name: string;
  angles: MulticamAngle[];
}

/** Most angles in a group (keys 1–4, a 2×2 viewer). */
export const MAX_ANGLES = 4;

export const groupOf = (tl: Timeline, c: TimelineClip) => (c.multicam ? tl.multicams?.find((g) => g.id === c.multicam!.group) : undefined);

/** The group clock's span where any angle has pictures. */
export function groupSpan(g: MulticamGroup): { start: number; end: number } {
  return { start: Math.min(...g.angles.map((a) => a.offsetUs)), end: Math.max(...g.angles.map((a) => a.offsetUs + a.durationUs)) };
}

/**
 * Adds a group and puts it on the main row as one clip of the first angle (over the part of the
 * clock that angle covers). Offsets are moved so the earliest angle starts at 0.
 */
export function addMulticam(tl: Timeline, angles: MulticamAngle[], name: string, is360 = false): { tl: Timeline; group: MulticamGroup; clip: TimelineClip } {
  const lo = Math.min(...angles.map((a) => a.offsetUs));
  const group: MulticamGroup = { id: newId('g'), name, angles: angles.slice(0, MAX_ANGLES).map((a) => ({ ...a, offsetUs: Math.round(a.offsetUs - lo) })) };
  const a0 = group.angles[0]!;
  const clip: TimelineClip = { ...newClip(a0.path, a0.durationUs, is360), multicam: { group: group.id, angle: 0 } };
  return { tl: { ...tl, multicams: [...(tl.multicams ?? []), group], clips: [...tl.clips, clip] }, group, clip };
}

/**
 * The clip showing another angle of the same moment: same place and length on the timeline,
 * the other camera's recording. Null when that camera wasn't recording for the whole clip.
 * Only clips at one speed can switch (a ramp belongs to one recording).
 */
export function switchedAngle(tl: Timeline, c: TimelineClip, angle: number): TimelineClip | null {
  const g = groupOf(tl, c);
  const from = g?.angles[c.multicam!.angle], to = g?.angles[angle];
  if (!g || !from || !to || c.speedKeys?.length) return null;
  if (angle === c.multicam!.angle) return c;
  const d = from.offsetUs - to.offsetUs;
  const inUs = c.inUs + d, outUs = c.outUs + d;
  if (inUs < 0 || outUs > to.durationUs) return null;
  // Settings that belong to one recording don't carry over.
  return { ...c, mediaPath: to.path, inUs, outUs, multicam: { group: g.id, angle }, keyframes: c.keyframes.map((k) => ({ ...k, t: k.t + d })), track: undefined, masks: undefined, lenses: undefined, lensFix: undefined };
}

/** Switches a clip's angle; the timeline comes back unchanged when it can't. */
export function switchAngle(tl: Timeline, clipId: string, angle: number): Timeline {
  const i = tl.clips.findIndex((c) => c.id === clipId);
  const c = tl.clips[i];
  const next = c && switchedAngle(tl, c, angle);
  if (!c || !next || next === c) return tl;
  const clips = [...tl.clips];
  clips[i] = next;
  return { ...tl, clips };
}

// --- Syncing by sound ---------------------------------------------------------------------------

/** In-place radix-2 FFT (re, im of length 2^k); `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i]! /= n; im[i]! /= n; }
}

/**
 * How much later `b` started than `a` (in envelope steps), found by cross-correlating their sound
 * envelopes (loudness over time; changes in it, so a steady hum doesn't count). `confidence` is how
 * far the best match stands out from the rest (above ~4 is a clear match).
 */
export function envelopeOffset(a: Float32Array, b: Float32Array, maxLag = Infinity): { lag: number; confidence: number } {
  const prep = (x: Float32Array) => {
    // Onsets: how much louder than a moment ago, so both cameras' levels and noise floors don't matter.
    const d = new Float64Array(x.length);
    for (let i = 1; i < x.length; i++) d[i] = Math.max(0, x[i]! - x[i - 1]!);
    const mean = d.reduce((s, v) => s + v, 0) / Math.max(1, d.length);
    let sd = 0;
    for (const v of d) sd += (v - mean) ** 2;
    sd = Math.sqrt(sd / Math.max(1, d.length)) || 1;
    return d.map((v) => (v - mean) / sd);
  };
  const A = prep(a), B = prep(b);
  let n = 1;
  while (n < A.length + B.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(A); br.set(B);
  fft(ar, ai); fft(br, bi);
  // a ⋆ b: peak at lag L means a[t + L] ≈ b[t], so b started L steps after a.
  for (let i = 0; i < n; i++) { const r = ar[i]! * br[i]! + ai[i]! * bi[i]!, im = ai[i]! * br[i]! - ar[i]! * bi[i]!; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  let best = -Infinity, lag = 0;
  const scores: number[] = [];
  for (let i = 0; i < n; i++) {
    const L = i < n / 2 ? i : i - n;
    if (Math.abs(L) > maxLag || L > A.length || -L > B.length) continue;
    // (Fewer overlapping steps at large lags: score per overlapping step.)
    const overlap = Math.max(1, Math.min(A.length - Math.max(0, L), B.length - Math.max(0, -L)));
    const v = ar[i]! / Math.sqrt(overlap);
    scores.push(v);
    if (v > best) { best = v; lag = L; }
  }
  const m = scores.reduce((s, v) => s + v, 0) / Math.max(1, scores.length);
  let sd = 0;
  for (const v of scores) sd += (v - m) ** 2;
  sd = Math.sqrt(sd / Math.max(1, scores.length)) || 1;
  return { lag, confidence: (best - m) / sd };
}

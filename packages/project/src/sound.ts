// Sound tools for a clip or a piece of music: a 3-band EQ with a low cut, a compressor with
// presets, wind reduction, and (music) ducking under speech. The settings live with the clip;
// the audio engine builds them into each sound's chain, so playback and export match.

export type CompPreset = 'off' | 'gentle' | 'voice' | 'punchy' | 'limit';

export interface SoundFx {
  /** EQ, dB (−12…12): low shelf at 150 Hz, a bell at 1 kHz, high shelf at 6 kHz. */
  low: number;
  mid: number;
  high: number;
  /** Cuts rumble below this frequency, Hz (0 = off; 40–300). */
  lowCut: number;
  comp: CompPreset;
  /** Wind reduction strength, 0–1 (0 = off). */
  wind: number;
  /** This sound is talking: music set to duck goes down while it is heard. */
  voice?: boolean;
  /** Music only: how far it goes down under talking, dB (0 = off; up to 24). */
  duck?: number;
}

export const NO_SOUND_FX: SoundFx = { low: 0, mid: 0, high: 0, lowCut: 0, comp: 'off', wind: 0 };

/** Compressor settings (Web Audio DynamicsCompressor values) and make-up gain. */
export interface CompSettings { threshold: number; knee: number; ratio: number; attack: number; release: number; makeup: number }
export const COMP_PRESETS: [CompPreset, string, CompSettings | null][] = [
  ['off', 'Off', null],
  ['gentle', 'Gentle', { threshold: -24, knee: 12, ratio: 2, attack: 0.02, release: 0.25, makeup: 3 }],
  ['voice', 'Voice', { threshold: -28, knee: 8, ratio: 4, attack: 0.005, release: 0.15, makeup: 7 }],
  ['punchy', 'Punchy', { threshold: -20, knee: 4, ratio: 6, attack: 0.03, release: 0.1, makeup: 6 }],
  ['limit', 'Even out', { threshold: -12, knee: 0, ratio: 20, attack: 0.002, release: 0.2, makeup: 4 }],
];
export const compSettings = (p: CompPreset) => COMP_PRESETS.find(([id]) => id === p)?.[2] ?? null;

/** One-click sound settings for typical footage. */
export const SOUND_PRESETS: [string, Partial<SoundFx>][] = [
  ['Windy ride', { wind: 0.8, lowCut: 120, low: -3, mid: 0, high: 1, comp: 'gentle' }],
  ['Talking', { wind: 0.4, lowCut: 90, low: -2, mid: 2, high: 2, comp: 'voice', voice: true }],
  ['Engine', { wind: 0.3, lowCut: 40, low: 2, mid: 0, high: -2, comp: 'punchy' }],
  ['Clean up', { wind: 0, lowCut: 70, low: 0, mid: 0, high: 0, comp: 'gentle' }],
];

/** True when the settings change nothing (no nodes needed). */
export function isNeutralSound(s: SoundFx | undefined): boolean {
  return !s || (!s.low && !s.mid && !s.high && !s.lowCut && s.comp === 'off' && !s.wind);
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
/** Sound settings made safe (from a file); undefined when there are none. */
export function cleanSound(raw: unknown): SoundFx | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<SoundFx>;
  const lowCut = num(r.lowCut, 0, 300, 0);
  const out: SoundFx = {
    low: num(r.low, -12, 12, 0), mid: num(r.mid, -12, 12, 0), high: num(r.high, -12, 12, 0),
    lowCut: lowCut && lowCut < 20 ? 20 : lowCut,
    comp: COMP_PRESETS.some(([id]) => id === r.comp) ? r.comp! : 'off',
    wind: num(r.wind, 0, 1, 0),
  };
  if (r.voice === true) out.voice = true;
  const duck = num(r.duck, 0, 24, 0);
  if (duck) out.duck = duck;
  return out;
}

// ---- Ducking -----------------------------------------------------------------------------------

/**
 * How music ducks: the talking's level is followed, and so is the steady background under it
 * (wind, road). The music goes down while the talking stands out above that background by
 * `overDb` (and is above `thresholdDb` at all), so a steady roar doesn't keep it down.
 */
export const DUCK = { thresholdDb: -66, overDb: 8, floorRiseS: 3, attackS: 0.08, releaseS: 0.5, holdS: 0.6, keyAttackS: 0.01 };

/**
 * Follows the talking (`key`) and turns `music` down by up to `depthDb` while it is heard.
 * Works in blocks across calls; `state` carries on from one block to the next.
 */
export interface DuckState { env: number; gain: number; hold: number; floor: number }
export const newDuckState = (): DuckState => ({ env: 0, gain: 1, hold: 0, floor: 1 });
export function duckBlock(music: Float32Array[], key: Float32Array[], depthDb: number, sampleRate: number, st: DuckState, out: Float32Array[]) {
  const n = music[0]?.length ?? out[0]?.length ?? 0;
  // (env holds the key's mean square over about 30 ms; the floor follows its quiet level.)
  const ka = 1 - Math.exp(-1 / (DUCK.keyAttackS * 3 * sampleRate));
  const ga = Math.exp(-1 / (DUCK.attackS * sampleRate)), gr = Math.exp(-1 / (DUCK.releaseS * sampleRate));
  const thr = 10 ** (DUCK.thresholdDb / 10), over = 10 ** (DUCK.overDb / 10), low = 10 ** (-depthDb / 20), hold = DUCK.holdS * sampleRate;
  const rise = 1 - Math.exp(-1 / (DUCK.floorRiseS * sampleRate)), fall = 1 - Math.exp(-1 / (0.15 * sampleRate));
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (const c of key) k = Math.max(k, Math.abs(c[i] ?? 0));
    st.env += (k * k - st.env) * ka;
    // The background: drops quickly to the quieter level, creeps up slowly.
    st.floor += (st.env - st.floor) * (st.env < st.floor ? fall : rise);
    if (st.env > thr && st.env > st.floor * over) st.hold = hold; else if (st.hold > 0) st.hold--;
    const target = st.hold > 0 ? low : 1;
    st.gain = target < st.gain ? ga * st.gain + (1 - ga) * target : gr * st.gain + (1 - gr) * target;
    for (let c = 0; c < out.length; c++) out[c]![i] = ((music[c] ?? music[0])?.[i] ?? 0) * st.gain;
  }
}

// ---- Wind reduction ----------------------------------------------------------------------------

/** FFT size and hop of the wind reducer; it delays the sound by FRAME − 1 samples (21 ms at 48 kHz). */
export const WIND_FRAME = 1024;
export const WIND_HOP = 256;

/** In-place radix-2 FFT (re, im of length n, a power of two). */
export function fftInPlace(re: Float32Array, im: Float32Array, inverse = false) {
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
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i]! /= n; im[i]! /= n; }
}

/**
 * Wind reduction: a short-time Fourier transform with gated suppression of the low band.
 * Wind is loud, low and different at each microphone, while real sound reaches both alike; so
 * low bins that are loud and don't agree between the channels are turned down (with one channel,
 * low bins far louder than the middle of the spectrum are). Gains move smoothly from frame to
 * frame so the result doesn't warble. Feed it any number of samples; it returns as many, FRAME − 1 samples late.
 */
export class WindReducer {
  private readonly ch: number;
  private readonly win = new Float32Array(WIND_FRAME);
  private readonly inBuf: Float32Array[];
  /** Overlap-add of processed frames; its first HOP samples are finished after each frame. */
  private readonly acc: Float32Array[];
  /** Finished samples waiting to go out. */
  private readonly ready: Float32Array[];
  private readonly re: Float32Array[];
  private readonly im: Float32Array[];
  private readonly sxx: Float32Array; private readonly syy: Float32Array; private readonly sxr: Float32Array; private readonly sxi: Float32Array;
  private readonly gain: Float32Array;
  private readonly top: number;
  private fill = WIND_FRAME - WIND_HOP;
  private readPos = 0;
  constructor(channels: number, private sampleRate: number, public strength = 0.7) {
    this.ch = Math.max(1, Math.min(2, channels));
    // Root-Hann for analysis and synthesis (periodic, so the overlaps add up evenly).
    for (let i = 0; i < WIND_FRAME; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIND_FRAME));
    const make = (n: number) => Array.from({ length: this.ch }, () => new Float32Array(n));
    this.inBuf = make(WIND_FRAME);
    this.acc = make(WIND_FRAME);
    this.ready = make(WIND_HOP);
    this.re = make(WIND_FRAME);
    this.im = make(WIND_FRAME);
    const bins = WIND_FRAME / 2 + 1;
    this.sxx = new Float32Array(bins); this.syy = new Float32Array(bins); this.sxr = new Float32Array(bins); this.sxi = new Float32Array(bins);
    this.gain = new Float32Array(bins).fill(1);
    this.top = Math.min(bins - 1, Math.round((900 * WIND_FRAME) / sampleRate));
  }

  /** Processes input (one array per channel; a missing second channel copies the first) into output. */
  process(input: Float32Array[], output: Float32Array[]) {
    const n = output[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.ch; c++) this.inBuf[c]![this.fill] = (input[c] ?? input[0])?.[i] ?? 0;
      if (++this.fill === WIND_FRAME) this.frame();
      for (let c = 0; c < output.length; c++) output[c]![i] = this.ready[Math.min(c, this.ch - 1)]![this.readPos]!;
      this.readPos = Math.min(WIND_HOP - 1, this.readPos + 1);
    }
  }

  private frame() {
    const N = WIND_FRAME, bins = N / 2 + 1;
    for (let c = 0; c < this.ch; c++) {
      const re = this.re[c]!, im = this.im[c]!, x = this.inBuf[c]!;
      for (let i = 0; i < N; i++) { re[i] = x[i]! * this.win[i]!; im[i] = 0; }
      fftInPlace(re, im);
    }
    // Where is it windy? Per low bin, from how loud it is and (stereo) how little the channels agree.
    const a = 0.75; // smoothing of the spectra over frames
    let mid = 0, midN = 0;
    const lo = Math.round((1000 * N) / this.sampleRate), hi = Math.round((4000 * N) / this.sampleRate);
    for (let k = 0; k < bins; k++) {
      const r0 = this.re[0]![k]!, i0 = this.im[0]![k]!;
      const r1 = this.ch > 1 ? this.re[1]![k]! : r0, i1 = this.ch > 1 ? this.im[1]![k]! : i0;
      this.sxx[k] = a * this.sxx[k]! + (1 - a) * (r0 * r0 + i0 * i0);
      this.syy[k] = a * this.syy[k]! + (1 - a) * (r1 * r1 + i1 * i1);
      this.sxr[k] = a * this.sxr[k]! + (1 - a) * (r0 * r1 + i0 * i1);
      this.sxi[k] = a * this.sxi[k]! + (1 - a) * (i0 * r1 - r0 * i1);
      if (k >= lo && k <= hi) { mid += (this.sxx[k]! + this.syy[k]!) / 2; midN++; }
    }
    mid = mid / Math.max(1, midN) + 1e-12;
    const floor = 1 - 0.94 * this.strength;
    for (let k = 0; k < bins; k++) {
      let target = 1;
      if (k <= this.top && this.strength > 0) {
        const p = (this.sxx[k]! + this.syy[k]!) / 2 + 1e-12;
        // How much louder than the middle of the spectrum: wind is far louder down here.
        const loud = Math.max(0, Math.min(1, (10 * Math.log10(p / mid) - 6) / 18));
        let windy = loud;
        if (this.ch > 1) {
          const coh = (this.sxr[k]! ** 2 + this.sxi[k]! ** 2) / (this.sxx[k]! * this.syy[k]! + 1e-20);
          windy = loud * Math.max(0, Math.min(1, (0.9 - coh) / 0.6)) + 0.1 * loud;
        }
        // Lower bins go down more; the top of the band fades back to untouched.
        const tilt = 1 - (k / this.top) ** 2;
        target = Math.max(floor, 1 - Math.min(1, windy) * tilt * this.strength * 1.2);
      }
      // Turning down fast and back up slowly avoids warbling.
      const g = this.gain[k]!;
      this.gain[k] = target < g ? 0.5 * g + 0.5 * target : 0.9 * g + 0.1 * target;
    }
    for (let c = 0; c < this.ch; c++) {
      const re = this.re[c]!, im = this.im[c]!;
      for (let k = 0; k < bins; k++) {
        const g = this.gain[k]!;
        re[k]! *= g; im[k]! *= g;
        if (k > 0 && k < N / 2) { re[N - k]! *= g; im[N - k]! *= g; }
      }
      fftInPlace(re, im, true);
      // Root-Hann in and out with a hop of a quarter frame adds up to 2: halve it.
      const o = this.acc[c]!;
      for (let i = 0; i < N; i++) o[i]! += re[i]! * this.win[i]! * 0.5;
      this.ready[c]!.set(o.subarray(0, WIND_HOP));
      o.copyWithin(0, WIND_HOP);
      o.fill(0, N - WIND_HOP);
    }
    for (const b of this.inBuf) b.copyWithin(0, WIND_HOP);
    this.fill = N - WIND_HOP;
    this.readPos = 0;
  }
}

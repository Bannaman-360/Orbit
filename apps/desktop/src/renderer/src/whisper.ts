// Whisper, the parts around the model: the sound turned into the log-mel picture it reads, the
// rules for picking each next word, and its tokens turned back into text. Pure, so they're
// tested without the model (whisper.test.ts); the model itself runs in whisperWorker.ts.

export const SAMPLE_RATE = 16000;
export const N_FFT = 400;
export const HOP = 160;
/** One window: 30 s, 3000 columns. */
export const CHUNK = SAMPLE_RATE * 30;
export const FRAMES = CHUNK / HOP;

// --- Mel filters (as librosa.filters.mel with the Slaney scale and norm, which Whisper uses) ----
const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + (27 * Math.log(f / 1000)) / Math.log(6.4));
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp(((m - 15) * Math.log(6.4)) / 27));

export function melFilters(nMels: number, sr = SAMPLE_RATE, nFft = N_FFT): Float32Array[] {
  const bins = nFft / 2 + 1;
  const fft = Array.from({ length: bins }, (_, i) => (i * sr) / nFft);
  const lo = hzToMel(0), hi = hzToMel(sr / 2);
  const pts = Array.from({ length: nMels + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (nMels + 1)));
  return Array.from({ length: nMels }, (_, m) => {
    const w = new Float32Array(bins);
    const enorm = 2 / (pts[m + 2]! - pts[m]!);
    for (let k = 0; k < bins; k++) {
      const lower = (fft[k]! - pts[m]!) / (pts[m + 1]! - pts[m]!);
      const upper = (pts[m + 2]! - fft[k]!) / (pts[m + 2]! - pts[m + 1]!);
      w[k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
    return w;
  });
}

let twiddles: { cos: Float64Array; sin: Float64Array; win: Float64Array } | null = null;
const tw = () => {
  if (twiddles) return twiddles;
  const n = N_FFT, cos = new Float64Array(n * (n / 2 + 1)), sin = new Float64Array(n * (n / 2 + 1));
  for (let k = 0; k <= n / 2; k++) for (let t = 0; t < n; t++) { const a = (-2 * Math.PI * k * t) / n; cos[k * n + t] = Math.cos(a); sin[k * n + t] = Math.sin(a); }
  // A periodic Hann window, as torch.hann_window.
  const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  return (twiddles = { cos, sin, win });
};

/**
 * The log-mel picture of 30 s of 16 kHz sound (shorter is padded with silence): nMels × 3000,
 * row by row, scaled as Whisper expects.
 */
export function logMel(pcm: Float32Array, nMels = 80, filters = melFilters(nMels)): Float32Array {
  const audio = new Float32Array(CHUNK);
  audio.set(pcm.subarray(0, CHUNK));
  const { cos, sin, win } = tw();
  const n = N_FFT, bins = n / 2 + 1, pad = n / 2;
  const out = new Float32Array(nMels * FRAMES);
  const frame = new Float64Array(n), power = new Float64Array(bins);
  // Reflect at the ends (centre = True).
  const sample = (i: number) => audio[i < 0 ? -i : i >= CHUNK ? 2 * CHUNK - 2 - i : i]!;
  let max = -Infinity;
  for (let f = 0; f < FRAMES; f++) {
    const s0 = f * HOP - pad;
    for (let t = 0; t < n; t++) frame[t] = sample(s0 + t) * win[t]!;
    for (let k = 0; k < bins; k++) {
      let re = 0, im = 0;
      const o = k * n;
      for (let t = 0; t < n; t++) { re += frame[t]! * cos[o + t]!; im += frame[t]! * sin[o + t]!; }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < nMels; m++) {
      const w = filters[m]!;
      let v = 0;
      for (let k = 0; k < bins; k++) v += w[k]! * power[k]!;
      const l = Math.log10(Math.max(v, 1e-10));
      out[m * FRAMES + f] = l;
      if (l > max) max = l;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i]!, max - 8) + 4) / 4;
  return out;
}

// --- Tokens ----------------------------------------------------------------------------------
export interface Vocab {
  /** Token id → its text piece (byte-level, as stored). */
  pieces: string[];
  /** Ids of the special tokens. */
  eot: number; sot: number; transcribe: number; noTimestamps: number; noSpeech: number;
  /** First timestamp token (<|0.00|>); each next one is 0.02 s later. */
  timestampBegin: number;
  /** Language tokens: code → id. */
  languages: Record<string, number>;
  suppress: number[];
  beginSuppress: number[];
}

/** GPT-2's map from bytes to printable characters, inverted. */
const byteDecoder = (() => {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
  const m = new Map<string, number>();
  bs.forEach((b, i) => m.set(String.fromCharCode(cs[i]!), b));
  return m;
})();

/** Builds the vocabulary from vocab.json, added_tokens.json and generation_config.json. */
export function makeVocab(vocabJson: Record<string, number>, added: Record<string, number>, gen: { suppress_tokens?: number[]; begin_suppress_tokens?: number[]; lang_to_id?: Record<string, number>; no_timestamps_token_id?: number; eos_token_id?: number; decoder_start_token_id?: number; task_to_id?: Record<string, number> }): Vocab {
  const pieces: string[] = [];
  for (const [p, id] of Object.entries(vocabJson)) pieces[id] = p;
  for (const [p, id] of Object.entries(added)) pieces[id] = p;
  const id = (t: string) => added[t] ?? vocabJson[t] ?? -1;
  const languages: Record<string, number> = {};
  for (const [t, i] of Object.entries(gen.lang_to_id ?? {})) languages[t.replace(/^<\|(.*)\|>$/, '$1')] = i;
  return {
    pieces, languages,
    eot: gen.eos_token_id ?? id('<|endoftext|>'),
    sot: gen.decoder_start_token_id ?? id('<|startoftranscript|>'),
    transcribe: gen.task_to_id?.transcribe ?? id('<|transcribe|>'),
    noTimestamps: gen.no_timestamps_token_id ?? id('<|notimestamps|>'),
    noSpeech: id('<|nospeech|>') >= 0 ? id('<|nospeech|>') : id('<|nocaptions|>'),
    timestampBegin: id('<|0.00|>'),
    suppress: gen.suppress_tokens ?? [],
    beginSuppress: gen.begin_suppress_tokens ?? [],
  };
}

/** The text of ordinary tokens (special ones and timestamps left out). */
export function decodeText(v: Vocab, ids: number[]): string {
  const bytes: number[] = [];
  for (const i of ids) {
    if (i >= v.eot) continue;
    for (const ch of v.pieces[i] ?? '') { const b = byteDecoder.get(ch); if (b !== undefined) bytes.push(b); }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const logSoftmax = (x: Float32Array): Float64Array => {
  let max = -Infinity;
  for (const v of x) if (v > max) max = v;
  let s = 0;
  for (const v of x) s += Math.exp(v - max);
  const l = Math.log(s) + max;
  return Float64Array.from(x, (v) => v - l);
};

/**
 * Picks the next token (greedy), with Whisper's rules for timestamps: text comes between a pair
 * of them, they never go back in time, the first one is within the first second, and when a
 * timestamp is more likely than any one word, a timestamp it is.
 * `sampled`: the tokens picked so far (after the prompt). Returns the token and its log-probability.
 */
export function nextToken(v: Vocab, logitsIn: Float32Array, sampled: number[], maxInitial = 50): { id: number; logp: number } {
  const logits = Float32Array.from(logitsIn);
  const ban = (i: number) => { if (i >= 0 && i < logits.length) logits[i] = -Infinity; };
  v.suppress.forEach(ban);
  ban(v.noTimestamps);
  if (!sampled.length) v.beginSuppress.forEach(ban);
  const T = v.timestampBegin;
  const isTs = (i: number) => i >= T;
  const last = sampled[sampled.length - 1], before = sampled[sampled.length - 2];
  const lastTs = last !== undefined && isTs(last), penultTs = before === undefined || isTs(before);
  if (lastTs) {
    // After a pair of timestamps: text next. After one (closing a stretch of text): a timestamp or the end.
    if (penultTs) for (let i = T; i < logits.length; i++) ban(i);
    else for (let i = 0; i < v.eot; i++) ban(i);
  }
  // Never earlier than the last timestamp.
  const tss = sampled.filter(isTs);
  if (tss.length) {
    const floor = lastTs && !penultTs ? tss[tss.length - 1]! : tss[tss.length - 1]! + 1;
    for (let i = T; i < Math.min(floor, logits.length); i++) ban(i);
  }
  if (!sampled.length) {
    // Start with a timestamp, within the first second.
    for (let i = 0; i < T; i++) ban(i);
    for (let i = T + maxInitial + 1; i < logits.length; i++) ban(i);
  }
  const lp = logSoftmax(logits);
  let tsSum = -Infinity, textMax = -Infinity;
  for (let i = T; i < lp.length; i++) tsSum = tsSum === -Infinity ? lp[i]! : Math.max(tsSum, lp[i]!) + Math.log1p(Math.exp(-Math.abs(tsSum - lp[i]!)));
  for (let i = 0; i < T; i++) if (lp[i]! > textMax) textMax = lp[i]!;
  let best = 0;
  if (tsSum > textMax) { let b = T; for (let i = T; i < lp.length; i++) if (lp[i]! > lp[b]!) b = i; best = b; }
  else for (let i = 1; i < lp.length; i++) if (lp[i]! > lp[best]!) best = i;
  return { id: best, logp: lp[best]! };
}

export interface Segment { start: number; end: number; text: string }

/**
 * The stretches of text between timestamp pairs (seconds, from the window's start), and where the
 * next window should start: at the last complete stretch's end when the window ends mid-sentence.
 */
export function segmentsOf(v: Vocab, tokens: number[], windowS = 30): { segments: Segment[]; next: number } {
  const T = v.timestampBegin, ts = (i: number) => (i - T) * 0.02;
  const segments: Segment[] = [];
  let open: number | null = null, text: number[] = [];
  for (const t of tokens) {
    if (t === v.eot) break;
    if (t >= T) {
      if (open === null) { open = ts(t); text = []; continue; }
      const s = decodeText(v, text).trim();
      if (s) segments.push({ start: open, end: Math.max(open, ts(t)), text: s });
      open = null;
      text = [];
    } else if (t < v.eot) text.push(t);
  }
  // Ended with words still open (the window cut a sentence): start the next window where they began.
  const unfinished = open !== null && text.length > 0;
  return { segments, next: unfinished && open! >= 1 ? Math.min(windowS, open!) : windowS };
}

/** How repetitive a piece of text is (gzip-like): Whisper's guard against stuck, looping output. */
export function repetitive(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) grams.add(words.slice(i, i + 3).join(' '));
  return grams.size / (words.length - 2) < 0.4;
}

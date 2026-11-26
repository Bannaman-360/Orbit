// Runs Whisper (speech to text) away from the screen, so playback and editing stay smooth.
// The model's files come in as bytes (downloaded and checked by the main process); the sound
// comes in as 16 kHz mono. Out go the stretches of speech with their times.

import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { CHUNK, logMel, makeVocab, melFilters, nextToken, repetitive, SAMPLE_RATE, segmentsOf, type Segment, type Vocab } from './whisper';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)) : 1;

export type WhisperIn =
  | { kind: 'load'; encoder: ArrayBuffer; decoder: ArrayBuffer; vocab: Record<string, number>; added: Record<string, number>; gen: Record<string, unknown>; config: { d_model: number; decoder_attention_heads: number; decoder_layers: number; num_mel_bins: number } }
  | { kind: 'run'; pcm: Float32Array; language: string };
export type WhisperOut =
  | { kind: 'ready' }
  | { kind: 'progress'; fraction: number }
  | { kind: 'segment'; segment: Segment }
  | { kind: 'done'; language: string; segments: Segment[]; windows: number; ms: number }
  | { kind: 'error'; message: string };

let enc: ort.InferenceSession | null = null, dec: ort.InferenceSession | null = null;
let vocab: Vocab | null = null;
let cfg: { heads: number; headDim: number; layers: number; mels: number; filters: Float32Array[] } | null = null;
const post = (m: WhisperOut) => (self as unknown as Worker).postMessage(m);

const ids = (xs: number[]) => new ort.Tensor('int64', BigInt64Array.from(xs.map(BigInt)), [1, xs.length]);
const emptyPast = () => new ort.Tensor('float32', new Float32Array(0), [1, cfg!.heads, 0, cfg!.headDim]);

/** Runs the decoder over `tokens` with the pasts so far; returns the last position's logits (and the first's) and the new pasts. */
async function step(hidden: ort.Tensor, tokens: number[], past: Map<string, ort.Tensor> | null) {
  const feeds: Record<string, ort.Tensor> = { input_ids: ids(tokens), encoder_hidden_states: hidden };
  for (const name of dec!.inputNames) {
    if (name.startsWith('past_key_values')) feeds[name] = past?.get(name) ?? emptyPast();
    if (name === 'use_cache_branch') feeds[name] = new ort.Tensor('bool', Uint8Array.from([past ? 1 : 0]), [1]);
  }
  const out = await dec!.run(feeds);
  const logits = out.logits!, V = logits.dims[2]!, n = logits.dims[1]!;
  const data = logits.data as Float32Array;
  const next = new Map<string, ort.Tensor>();
  for (const [k, t] of Object.entries(out)) {
    if (!k.startsWith('present')) continue;
    const name = k.replace('present', 'past_key_values');
    // The cross-attention pasts only come out of the first step; keep those.
    if (past && name.includes('.encoder.')) next.set(name, past.get(name)!);
    else next.set(name, t);
  }
  return { last: data.subarray((n - 1) * V, n * V), first: data.subarray(0, V), past: next };
}

const softmaxAt = (x: Float32Array, i: number) => { let m = -Infinity; for (const v of x) if (v > m) m = v; let s = 0; for (const v of x) s += Math.exp(v - m); return Math.exp(x[i]! - m) / s; };

async function run(pcm: Float32Array, language: string) {
  const v = vocab!, t0 = performance.now();
  const segments: Segment[] = [];
  let seek = 0, windows = 0, lang = language;
  const total = pcm.length;
  while (seek < total - SAMPLE_RATE * 0.5) {
    const piece = pcm.subarray(seek, seek + CHUNK);
    const offset = seek / SAMPLE_RATE;
    // Silence: nothing to listen to.
    let e = 0;
    for (let i = 0; i < piece.length; i++) e += piece[i]! * piece[i]!;
    if (Math.sqrt(e / Math.max(1, piece.length)) < 2e-4) { seek += CHUNK; post({ kind: 'progress', fraction: Math.min(1, seek / total) }); continue; }
    windows++;
    const mel = logMel(piece, cfg!.mels, cfg!.filters);
    const encOut = await enc!.run({ input_features: new ort.Tensor('float32', mel, [1, cfg!.mels, 3000]) });
    const hidden = Object.values(encOut)[0]!;
    if (lang === 'auto') {
      const r = await step(hidden, [v.sot], null);
      let best = 'en', bestV = -Infinity;
      for (const [code, id] of Object.entries(v.languages)) if (r.last[id]! > bestV) { bestV = r.last[id]!; best = code; }
      lang = best;
    }
    const prompt = [v.sot, ...(v.languages[lang] !== undefined ? [v.languages[lang]!] : []), v.transcribe];
    let r = await step(hidden, prompt, null);
    const noSpeech = v.noSpeech >= 0 ? softmaxAt(r.first, v.noSpeech) : 0;
    const sampled: number[] = [];
    let sumLogp = 0;
    for (let k = 0; k < 224; k++) {
      const pick = nextToken(v, r.last, sampled);
      sampled.push(pick.id);
      sumLogp += pick.logp;
      if (pick.id === v.eot) break;
      r = await step(hidden, [pick.id], r.past);
    }
    const avg = sumLogp / Math.max(1, sampled.length);
    const { segments: segs, next } = segmentsOf(v, sampled);
    if (!(noSpeech > 0.6 && avg < -1)) {
      for (const s of segs) {
        if (repetitive(s.text)) continue;
        const seg = { start: s.start + offset, end: Math.min(s.end + offset, total / SAMPLE_RATE), text: s.text };
        segments.push(seg);
        post({ kind: 'segment', segment: seg });
      }
    }
    seek += Math.max(SAMPLE_RATE, Math.round(next * SAMPLE_RATE));
    post({ kind: 'progress', fraction: Math.min(1, seek / total) });
  }
  post({ kind: 'done', language: lang, segments, windows, ms: performance.now() - t0 });
}

self.onmessage = async (e: MessageEvent<WhisperIn>) => {
  try {
    const m = e.data;
    if (m.kind === 'load') {
      const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      enc = await ort.InferenceSession.create(new Uint8Array(m.encoder), opts);
      dec = await ort.InferenceSession.create(new Uint8Array(m.decoder), opts);
      vocab = makeVocab(m.vocab, m.added, m.gen);
      const heads = m.config.decoder_attention_heads;
      cfg = { heads, headDim: m.config.d_model / heads, layers: m.config.decoder_layers, mels: m.config.num_mel_bins, filters: melFilters(m.config.num_mel_bins) };
      post({ kind: 'ready' });
    } else if (m.kind === 'run') await run(m.pcm, m.language);
  } catch (err) {
    post({ kind: 'error', message: (err as Error).message ?? String(err) });
  }
};

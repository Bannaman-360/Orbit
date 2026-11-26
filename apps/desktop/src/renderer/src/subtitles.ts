// Auto subtitles: listens to the edit's own sound (the clips, not the music), writes down what is
// said with Whisper, and turns it into captions on the timeline.

import { captionOverlays, flattenTimeline, makeCaptions, timelineDuration, type Overlay, type Spoken, type Timeline } from '@ace/project';
import { mixTimeline } from './audioEngine';
import { ensureModel, modelFile, modelJson } from './aiModels';
import { SAMPLE_RATE, type Segment } from './whisper';
import type { WhisperIn, WhisperOut } from './whisperWorker';

export const WHISPER = 'whisper-base';

/** Languages offered (Whisper knows many more; these cover most riders). */
export const LANGUAGES: [string, string][] = [
  ['auto', 'Work it out'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'], ['pl', 'Polish'], ['cs', 'Czech'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['hi', 'Hindi'],
];

/** The edit's own sound (clips and their detached sound, not music), 16 kHz mono. */
export async function editSpeech(tl: Timeline): Promise<Float32Array | null> {
  const flat = flattenTimeline(tl);
  const own: Timeline = { ...flat, audio: flat.audio.filter((a) => a.linkedClipId) };
  const mix = await mixTimeline(own, timelineDuration(flat), SAMPLE_RATE);
  if (!mix) return null;
  const n = mix.length, out = new Float32Array(n);
  for (let c = 0; c < mix.numberOfChannels; c++) { const d = mix.getChannelData(c); for (let i = 0; i < n; i++) out[i]! += d[i]! / mix.numberOfChannels; }
  return out;
}

export interface SubtitleProgress { stage: 'download' | 'sound' | 'listen'; fraction: number }
export interface SubtitleResult { captions: Overlay[]; language: string; segments: Segment[]; ms: number }

/** Writes down what is said in the edit. `onSegment` gets each stretch as it's heard. */
export async function makeSubtitles(tl: Timeline, language: string, onProgress: (p: SubtitleProgress) => void, signal: AbortSignal, onSegment?: (s: Spoken) => void): Promise<SubtitleResult> {
  onProgress({ stage: 'download', fraction: 0 });
  await ensureModel(WHISPER);
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  onProgress({ stage: 'sound', fraction: 0 });
  const pcm = await editSpeech(tl);
  if (!pcm) throw new Error('This edit has no sound from its clips to listen to.');
  const [encoder, decoder, vocab, added, gen, config] = await Promise.all([
    modelFile(WHISPER, 'encoder_model_quantized.onnx'), modelFile(WHISPER, 'decoder_model_merged_quantized.onnx'),
    modelJson<Record<string, number>>(WHISPER, 'vocab.json'), modelJson<Record<string, number>>(WHISPER, 'added_tokens.json'),
    modelJson<Record<string, unknown>>(WHISPER, 'generation_config.json'), modelJson<{ d_model: number; decoder_attention_heads: number; decoder_layers: number; num_mel_bins: number }>(WHISPER, 'config.json'),
  ]);
  const worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
  const stop = () => worker.terminate();
  signal.addEventListener('abort', stop);
  try {
    const result = await new Promise<{ language: string; segments: Segment[]; ms: number }>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
      worker.onerror = (e) => reject(new Error(e.message || 'Speech to text stopped.'));
      worker.onmessage = (e: MessageEvent<WhisperOut>) => {
        const m = e.data;
        if (m.kind === 'ready') worker.postMessage({ kind: 'run', pcm, language } satisfies WhisperIn, [pcm.buffer]);
        else if (m.kind === 'progress') onProgress({ stage: 'listen', fraction: m.fraction });
        else if (m.kind === 'segment') onSegment?.({ startUs: m.segment.start * 1e6, endUs: m.segment.end * 1e6, text: m.segment.text });
        else if (m.kind === 'done') resolve(m);
        else if (m.kind === 'error') reject(new Error(m.message));
      };
      // (Copies of the model's bytes: the originals stay kept for the next time.)
      worker.postMessage({ kind: 'load', encoder: encoder.slice().buffer, decoder: decoder.slice().buffer, vocab, added, gen, config } satisfies WhisperIn);
    });
    const spoken = result.segments.map((s) => ({ startUs: Math.round(s.start * 1e6), endUs: Math.round(s.end * 1e6), text: s.text }));
    return { captions: captionOverlays(makeCaptions(spoken)), language: result.language, segments: result.segments, ms: result.ms };
  } finally {
    signal.removeEventListener('abort', stop);
    worker.terminate();
  }
}

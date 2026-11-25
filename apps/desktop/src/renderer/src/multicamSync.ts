// Lines up multicam angles: by their sound (cross-correlating loudness envelopes), or by each
// camera's clock (when the recording started).

import { envelopeOffset, type MulticamAngle } from '@ace/project';
import { clipSound, getMedia } from './media';

/** Envelope steps a second (10 ms). */
const RATE = 100;
/** Sound used for matching: the first minutes of each recording. */
const MAX_S = 12 * 60;

/** Loudness over time (RMS of 10 ms steps, both channels), or null without sound. */
export async function soundEnvelope(path: string, signal?: AbortSignal): Promise<Float32Array | null> {
  const m = await getMedia(path);
  const s = clipSound(m);
  if (!s) return null;
  const seconds = Math.min(s.seconds, MAX_S);
  const out = new Float32Array(Math.floor(seconds * RATE));
  const blocks = s.blockS === Infinity ? 1 : Math.ceil(seconds / s.blockS);
  for (let b = 0; b < blocks; b++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const buf = await s.fetch(b);
    if (!buf) continue;
    const t0 = s.blockS === Infinity ? 0 : b * s.blockS;
    const per = buf.sampleRate / RATE;
    const ch = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    // (Blocks run on a little past their end: only their own part counts.)
    const own = s.blockS === Infinity ? buf.length : Math.min(buf.length, Math.round(s.blockS * buf.sampleRate));
    for (let k = 0; k * per < own; k++) {
      const at = Math.floor(t0 * RATE) + k;
      if (at >= out.length) break;
      let sum = 0, n = 0;
      for (let i = Math.floor(k * per); i < Math.min(own, Math.floor((k + 1) * per)); i++) for (const c of ch) { sum += c[i]! * c[i]!; n++; }
      out[at] = n ? Math.sqrt(sum / n) : 0;
    }
  }
  return out;
}

export interface SyncResult {
  angles: MulticamAngle[];
  /** How each angle (after the first) was placed. */
  how: ('sound' | 'clock' | 'start')[];
}

/**
 * Where each recording starts relative to the first. By sound when it matches clearly; else by the
 * cameras' clocks; else all from the start (the user can slip the cuts later).
 */
export async function syncAngles(paths: string[], method: 'sound' | 'clock', progress?: (f: number) => void, signal?: AbortSignal): Promise<SyncResult> {
  const media = await Promise.all(paths.map((p) => getMedia(p)));
  const angles: MulticamAngle[] = media.map((m) => ({ path: m.path, offsetUs: 0, durationUs: m.durationUs }));
  const how: SyncResult['how'] = [];
  const clock = (i: number) => {
    const a = media[0]!.info.created, b = media[i]!.info.created;
    return a && b && a.getTime() > 86_400_000 * 365 && b.getTime() > 86_400_000 * 365 ? (b.getTime() - a.getTime()) * 1000 : null;
  };
  const env0 = method === 'sound' ? await soundEnvelope(paths[0]!, signal) : null;
  for (let i = 1; i < media.length; i++) {
    progress?.(i / media.length);
    if (method === 'sound' && env0) {
      const e = await soundEnvelope(paths[i]!, signal);
      if (e) {
        const r = envelopeOffset(env0, e);
        if (r.confidence >= 4) { angles[i]!.offsetUs = Math.round((r.lag / RATE) * 1e6); how.push('sound'); continue; }
      }
    }
    const c = clock(i);
    if (c !== null && Math.abs(c) < 6 * 3600e6) { angles[i]!.offsetUs = Math.round(c); how.push('clock'); continue; }
    how.push('start');
  }
  progress?.(1);
  return { angles, how };
}

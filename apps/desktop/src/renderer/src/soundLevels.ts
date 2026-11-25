// How loud a clip's own sound is over time, for the Sound level gauge. Each file's sound is read
// once in the background, a block at a time, and kept as one loudness value every 50 ms; the gauge
// then reads it at any time without waiting, so preview, scrubbing and export draw the same.

import { audioEnd, decodeAudioRange } from '@ace/engine';
import type { Timeline } from '@ace/project';
import { getMedia, mediaNow } from './media';

/** Spacing of the loudness values (µs). */
export const LEVEL_STEP_US = 50_000;
const BLOCK_US = 20_000_000;

/**
 * The camera's microphone isn't calibrated, so its level is shown as an estimate in decibels:
 * full scale ≈ 100 dB (wind or an engine close by), a quiet room ≈ 40 dB.
 */
export const DB_AT_FULL_SCALE = 100;
/** Range a dial or bar covers, dB. */
export const SOUND_SCALE: [number, number] = [30, 110];

interface Levels { db: Float32Array; done: boolean }
const levels = new Map<string, Levels>();
const loading = new Map<string, Promise<Levels | null>>();
const listeners = new Set<() => void>();
/** Called when more of a file's levels are ready (to redraw a paused preview). */
export const onSoundLevels = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** RMS of a stretch of samples, as dB on the gauge's scale (−∞ for silence). */
export function rmsDb(chans: Float32Array[], from: number, to: number): number {
  let sum = 0, n = 0;
  for (const c of chans) for (let i = Math.max(0, from); i < Math.min(c.length, to); i++) { sum += c[i]! * c[i]!; n++; }
  if (!n || !sum) return -Infinity;
  return 10 * Math.log10(sum / n) + DB_AT_FULL_SCALE;
}

/** Starts reading a file's loudness (once); resolves when all of it is known (null: no sound). */
export function loadSoundLevels(path: string): Promise<Levels | null> {
  const have = levels.get(path);
  if (have?.done) return Promise.resolve(have);
  let p = loading.get(path);
  if (!p) {
    p = (async () => {
      const m = mediaNow(path) ?? (await getMedia(path));
      const track = m.info.audioTracks[0];
      if (!track?.samples.length) return null;
      const end = audioEnd(track);
      const out: Levels = { db: new Float32Array(Math.ceil(end / LEVEL_STEP_US)).fill(NaN), done: false };
      levels.set(path, out);
      for (let from = 0; from < end; from += BLOCK_US) {
        const pcm = await decodeAudioRange(m.reader, track, from, Math.min(end, from + BLOCK_US)).catch(() => null);
        if (pcm?.channels.length) {
          const per = Math.round((LEVEL_STEP_US / 1e6) * pcm.sampleRate);
          const first = Math.round(from / LEVEL_STEP_US);
          for (let k = 0; first + k < out.db.length && k * per < pcm.channels[0]!.length; k++) out.db[first + k] = rmsDb(pcm.channels, k * per, (k + 1) * per);
        }
        listeners.forEach((f) => f());
      }
      out.done = true;
      return out;
    })().catch(() => null);
    loading.set(path, p);
  }
  return p;
}

/** Reads the loudness of every clip a timeline's sound gauges might show (for export). */
export async function prepareSoundLevels(tl: Timeline): Promise<void> {
  if (!tl.overlays.some((o) => o.kind === 'sound')) return;
  const paths = new Set([...tl.clips, ...tl.connected].map((c) => c.mediaPath));
  await Promise.all([...paths].map((p) => loadSoundLevels(p)));
}

/**
 * Loudness (dB, estimated) of a file's sound at a media time: NaN while it's still being read or
 * when the file has none. Starts reading it the first time it's asked for.
 */
export function soundLevelAt(path: string, mediaUs: number): number {
  const l = levels.get(path);
  if (!l) { void loadSoundLevels(path); return NaN; }
  const x = mediaUs / LEVEL_STEP_US - 0.5, i = Math.floor(x), f = x - i;
  const a = l.db[Math.max(0, Math.min(l.db.length - 1, i))]!, b = l.db[Math.max(0, Math.min(l.db.length - 1, i + 1))]!;
  // Silence reads as the bottom of the scale.
  const lo = SOUND_SCALE[0];
  const va = Number.isFinite(a) ? a : a === -Infinity ? lo : NaN, vb = Number.isFinite(b) ? b : b === -Infinity ? lo : NaN;
  if (Number.isNaN(va)) return vb;
  if (Number.isNaN(vb)) return va;
  return Math.max(lo, va + (vb - va) * f);
}

/** For checks: how much of a file's loudness is known. */
export function soundLevelsInfo(path: string): { values: number; known: number; done: boolean } | null {
  const l = levels.get(path);
  return l ? { values: l.db.length, known: l.db.filter((x) => !Number.isNaN(x)).length, done: l.done } : null;
}

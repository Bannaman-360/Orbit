// Sound spectrum gauges: each file's sound (a clip's own, or music) read once in the background,
// a block at a time, and kept as columns of band levels every 25 ms. Gauges then read them at any
// time without waiting, so preview, scrubbing and export draw the same.

import { mediaAt, type Overlay, type Timeline } from '@ace/project';
import { clipSound, getMedia, getMusic, type Sound } from './media';
import { BANDS, column, SPECTRUM_STEP_US, type Columns } from './spectrum';
import { gaugeSource } from './overlayRender';

const kept = new Map<string, Columns>();
const loading = new Map<string, Promise<Columns | null>>();
const listeners = new Set<() => void>();
/** Called when more columns are ready (to redraw a paused preview). */
export const onSpectrum = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

async function soundOf(path: string, music: boolean): Promise<Sound | null> {
  if (music) return (await getMusic(path)).sound;
  return clipSound(await getMedia(path));
}

/** Starts reading a file's spectrum (once); resolves when all of it is known (null: no sound). */
export function loadSpectrum(path: string, music: boolean): Promise<Columns | null> {
  const key = `${music ? 'm' : 'c'}|${path}`;
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      const sound = await soundOf(path, music);
      if (!sound) return null;
      const steps = Math.ceil((sound.seconds * 1e6) / SPECTRUM_STEP_US);
      const c: Columns = { data: new Uint8Array(steps * BANDS), steps, known: new Uint8Array(steps) };
      kept.set(key, c);
      const blocks = Number.isFinite(sound.blockS) ? Math.ceil(sound.seconds / sound.blockS) : 1;
      for (let i = 0; i < blocks; i++) {
        const buf = await sound.fetch(i);
        if (!buf) continue;
        const sr = buf.sampleRate, start = Number.isFinite(sound.blockS) ? i * sound.blockS : 0;
        const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
        const mono = new Float32Array(l.length);
        for (let k = 0; k < mono.length; k++) mono[k] = (l[k]! + r[k]!) / 2;
        const end = Number.isFinite(sound.blockS) ? Math.min(sound.seconds, start + sound.blockS) : sound.seconds;
        const s0 = Math.ceil((start * 1e6) / SPECTRUM_STEP_US), s1 = Math.min(steps, Math.ceil((end * 1e6) / SPECTRUM_STEP_US));
        for (let s = s0; s < s1; s++) {
          column(mono, ((s * SPECTRUM_STEP_US) / 1e6 - start) * sr, sr, c.data, s * BANDS);
          c.known[s] = 1;
          // (Let the editor breathe on long files.)
          if (s % 400 === 0) await new Promise((res) => setTimeout(res, 0));
        }
        listeners.forEach((f) => f());
      }
      return c;
    })().catch(() => null);
    loading.set(key, p);
  }
  return p;
}

/** What a spectrum gauge listens to at timeline time T: a file, whether it's music, and where in it. */
export function spectrumSource(tl: Timeline, T: number, o: Pick<Overlay, 'listen' | 'sourceClipId'>): { path: string; music: boolean; mediaUs: number } | null {
  const music = () => {
    const a = tl.audio.find((x) => !x.linkedClipId && T >= x.startUs && T < x.startUs + (x.outUs - x.inUs) / (x.speed ?? 1));
    return a ? { path: a.path, music: true, mediaUs: mediaAt(a, T - a.startUs) } : null;
  };
  const clip = () => { const g = gaugeSource(tl, T, o); return g ? { path: g.clip.mediaPath, music: false, mediaUs: g.mediaUs } : null; };
  if (o.listen === 'music') return music();
  if (o.listen === 'clip') return clip();
  // Missing: the music while there is some, else the clip's own sound.
  return music() ?? clip();
}

/** The columns of a source, when (some of) it is read; starts reading it the first time. */
export function spectrumColumns(path: string, music: boolean): Columns | null {
  const c = kept.get(`${music ? 'm' : 'c'}|${path}`);
  if (!c) void loadSpectrum(path, music);
  return c ?? null;
}

/** Reads every source a timeline's spectrum gauges might show (for export). */
export async function prepareSpectrum(tl: Timeline): Promise<void> {
  if (!tl.overlays.some((o) => o.kind === 'spectrum')) return;
  const jobs: Promise<unknown>[] = [];
  for (const c of [...tl.clips, ...tl.connected]) jobs.push(loadSpectrum(c.mediaPath, false));
  for (const a of tl.audio) if (!a.linkedClipId) jobs.push(loadSpectrum(a.path, true));
  await Promise.all(jobs);
}

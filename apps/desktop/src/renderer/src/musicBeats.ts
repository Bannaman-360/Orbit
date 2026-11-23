// The beats of each music file, found once in the background and kept for the session.
// The timeline shows them and snaps to them.

import { useEffect, useState } from 'react';
import type { BeatGrid } from '@ace/engine/src/beats';
import { musicNow } from './media';

const grids = new Map<string, BeatGrid | null>();
const listeners = new Set<() => void>();
let worker: Worker | null = null, nextId = 0;
const waiting = new Map<number, (g: BeatGrid) => void>();

/** Beats of a music file, if found already (null: being found, or none). */
export const beatsOf = (path: string): BeatGrid | null => grids.get(path) ?? null;

/** Starts finding the beats of a music file (once). */
export function analyseBeats(path: string) {
  if (grids.has(path)) return;
  const m = musicNow.get(path);
  const buffer = m?.sound.ready(0);
  if (!buffer || Number.isFinite(m!.sound.blockS)) return; // (A clip's own sound, read in blocks: not music.)
  grids.set(path, null);
  worker ??= new Worker(new URL('./beatsWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; grid: BeatGrid }>) => { waiting.get(e.data.id)?.(e.data.grid); waiting.delete(e.data.id); };
  const id = nextId++;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  waiting.set(id, (g) => { grids.set(path, g); for (const f of listeners) f(); });
  worker.postMessage({ id, channels, rate: buffer.sampleRate }, channels.map((c) => c.buffer));
}

/** Re-renders when beats arrive. */
export function useBeatsVersion() {
  const [v, setV] = useState(0);
  useEffect(() => { const f = () => setV((x) => x + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  return v;
}

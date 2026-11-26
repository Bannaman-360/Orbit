// AI models in the app: which are on this computer, and getting one the first time it's needed
// (downloaded once, with progress; the main process checks every file, see main/models.ts).

import { useEffect, useState } from 'react';
import { ace, type ModelState } from './api';

const listeners = new Set<() => void>();
let states: ModelState[] = [];
const notify = () => listeners.forEach((f) => f());

export async function refreshModels() {
  states = await ace.modelsList();
  notify();
  return states;
}

let progressHooked = false;
const hookProgress = () => {
  if (progressHooked) return;
  progressHooked = true;
  ace.onModelProgress((id, fraction) => {
    states = states.map((s) => (s.id === id ? { ...s, state: 'downloading', fraction } as ModelState : s));
    notify();
  });
};

/** The models and their state, kept up to date (downloads in progress included). */
export function useModels(): ModelState[] {
  const [, bump] = useState(0);
  useEffect(() => {
    hookProgress();
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    void refreshModels();
    return () => { listeners.delete(f); };
  }, []);
  return states;
}

export const modelState = (id: string) => states.find((s) => s.id === id);

/** Makes sure a model is on this computer, downloading it if needed. Throws with a plain message. */
export async function ensureModel(id: string): Promise<void> {
  hookProgress();
  const s = (await refreshModels()).find((x) => x.id === id);
  if (s?.state === 'ready') return;
  const r = await ace.modelsDownload(id);
  await refreshModels();
  if (!r.ok) throw new Error(r.error === 'Cancelled' ? 'Cancelled' : `The download didn’t work (${r.error}). Check the internet connection and try again.`);
}

export const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

const files = new Map<string, Promise<Uint8Array>>();
/** A model file's bytes (read once per run of the app). */
export function modelFile(id: string, name: string): Promise<Uint8Array> {
  const k = `${id}/${name}`;
  let p = files.get(k);
  if (!p) { p = ace.modelsRead(id, name); files.set(k, p); p.catch(() => files.delete(k)); }
  return p;
}
export const modelJson = async <T,>(id: string, name: string): Promise<T> => JSON.parse(new TextDecoder().decode(await modelFile(id, name))) as T;
/** Forget kept bytes (after a model was removed). */
export const forgetModelFiles = (id: string) => { for (const k of [...files.keys()]) if (k.startsWith(`${id}/`)) files.delete(k); };

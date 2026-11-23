// Importing from a memory card: what is on it, what is picked, and the import that is running.
// Kept outside the window that shows it, so an import carries on while the window is closed.

import { useSyncExternalStore } from 'react';
import { ace, type Card, type ImportEvent, type ListedRecording } from './api';
import { fileThumbnail } from './media';

export type RecordingState = { state: 'waiting' } | { state: 'copying' | 'checking'; fraction: number } | { state: 'done'; paths: string[] } | { state: 'failed'; error: string };

export interface ImportRun {
  ids: string[];
  total: number;
  fraction: number;
  /** Bytes a second, and seconds left (0 while unknown). */
  speed: number;
  left: number;
  paused: boolean;
  states: Map<string, RecordingState>;
  ended: null | { stopped: boolean; error?: string };
}

interface Store {
  cards: Card[];
  root: string | null;
  list: ListedRecording[];
  scanning: boolean;
  scanError: string | null;
  picked: Set<string>;
  thumbs: Map<string, string>;
  dest: { path: string; free: number | null } | null;
  addToProject: boolean;
  hideImported: boolean;
  run: ImportRun | null;
  error: string | null;
}

const flag = (k: string, d: boolean) => { try { return (localStorage.getItem(k) ?? String(d)) === 'true'; } catch { return d; } };
let s: Store = { cards: [], root: null, list: [], scanning: false, scanError: null, picked: new Set(), thumbs: new Map(), dest: null, addToProject: flag('ace.import.add', true), hideImported: flag('ace.import.hide', false), run: null, error: null };
const subs = new Set<() => void>();
const set = (p: Partial<Store>) => { s = { ...s, ...p }; subs.forEach((f) => f()); };
export const cardState = () => s;
export const useCards = <T,>(pick: (s: Store) => T): T => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => pick(s));
export const running = (r: ImportRun | null): r is ImportRun & { ended: null } => !!r && !r.ended;

export function setOption(k: 'addToProject' | 'hideImported', v: boolean) {
  set({ [k]: v });
  try { localStorage.setItem(k === 'addToProject' ? 'ace.import.add' : 'ace.import.hide', String(v)); } catch { /* private mode */ }
}

// --- Cards --------------------------------------------------------------------------------------------
let onAppeared: (c: Card) => void = () => {};
let onFiles: (paths: string[]) => void = () => {};

/** `appeared` is told of a card put in while the app runs; `files` of recordings to add to the project. */
export function startCards(appeared: typeof onAppeared, files: typeof onFiles) {
  onAppeared = appeared;
  onFiles = files;
}
let first = true;
function gotCards(cards: Card[]) {
  const fresh = cards.filter((c) => !s.cards.some((x) => x.root === c.root));
  const gone = s.root && !cards.some((c) => c.root === s.root);
  set({ cards });
  if (gone) set({ root: null, list: [], picked: new Set(), scanError: null });
  if (opened && !s.root && cards[0] && !running(s.run)) void scan(cards[0].root);
  if (!first && !opened && fresh[0]) onAppeared(fresh[0]);
  first = false;
}
let opened = false;
/** The import window opened or closed. */
export async function setOpened(v: boolean) {
  opened = v;
  if (!v) return;
  set({ error: null, run: running(s.run) ? s.run : null });
  set({ dest: await ace.importDest() });
  gotCards(await ace.cards());
  if (s.root && !running(s.run)) await scan(s.root);
}

let scanNo = 0;
export async function scan(root: string) {
  const me = ++scanNo;
  if (s.root !== root) set({ list: [], picked: new Set() });
  set({ root, scanning: true, scanError: null, run: running(s.run) ? s.run : null });
  try {
    const list = await ace.scanCard(root);
    if (me !== scanNo) return;
    const keep = new Set([...s.picked].filter((id) => list.some((r) => r.id === id)));
    // New recordings start picked; ones already imported, or cut off, don't.
    const seen = new Set(s.list.map((r) => r.id));
    for (const r of list) if (!seen.has(r.id) && !r.imported && !r.unfinished) keep.add(r.id);
    set({ list, picked: keep, scanning: false });
    void loadThumbs(list, me);
  } catch (e) {
    if (me === scanNo) set({ scanning: false, list: [], scanError: /EPERM|EACCES/.test(String(e)) ? 'The computer isn’t letting the app look at this card. Allow it in System Settings › Privacy & Security › Files & Folders.' : 'This card couldn’t be read.' });
  }
}

async function loadThumbs(list: ListedRecording[], me: number) {
  const missing: ListedRecording[] = [];
  const add = (id: string, url: string) => set({ thumbs: new Map(s.thumbs).set(id, url) });
  for (const r of list) {
    if (me !== scanNo) return;
    if (s.thumbs.has(r.id)) continue;
    const b = r.thumb ? await ace.cardThumb(r.id).catch(() => null) : null;
    if (b?.length) add(r.id, URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/jpeg' })));
    else if (!r.unfinished) missing.push(r);
  }
  // The camera left no picture: take one from the video. (Not while a copy needs the card.)
  for (const r of missing) {
    if (me !== scanNo || running(s.run)) return;
    const url = await fileThumbnail(r.copies?.[0] ?? r.files[0]!.path).catch(() => null);
    if (url) add(r.id, url);
  }
}

export const pick = (picked: Set<string>) => set({ picked });
export async function chooseDest() { set({ dest: await ace.chooseImportDest(), error: null }); }

// --- The import ---------------------------------------------------------------------------------------
/** A byte checked costs less time than a byte copied from a card. */
const CHECK = 0.15;
let clock = { t: 0, done: 0, rate: 0 };

/** Picked recordings that are already here are just added; the rest are copied. */
export async function startImport() {
  const chosen = s.list.filter((r) => s.picked.has(r.id));
  const here = chosen.filter((r) => r.copies), copy = chosen.filter((r) => !r.copies);
  set({ error: null });
  if (here.length && s.addToProject) onFiles(here.map((r) => r.copies![0]!));
  if (!copy.length) { set({ picked: new Set() }); return; }
  const states = new Map<string, RecordingState>(copy.map((r) => [r.id, { state: 'waiting' }]));
  clock = { t: performance.now(), done: 0, rate: 0 };
  const run: ImportRun = { ids: copy.map((r) => r.id), total: copy.reduce((n, r) => n + r.size, 0), fraction: 0, speed: 0, left: 0, paused: false, states, ended: null };
  set({ run });
  try {
    await ace.importCard(run.ids);
  } catch (e) {
    set({ run: null, error: String(e).replace(/^.*?Error: (?:Error invoking remote method '[^']+': )?(?:Error: )?/, '') });
  }
}
export function pauseImport(paused: boolean) {
  if (!running(s.run)) return;
  void ace.importControl(paused ? 'pause' : 'resume');
  clock.t = performance.now();
  set({ run: { ...s.run, paused } });
}
export const stopImport = () => void ace.importControl('stop');

function gotEvent(e: ImportEvent) {
  const run = s.run;
  if (!run || run.ended) return;
  const states = new Map(run.states);
  if (e.type === 'bytes') {
    const size = s.list.find((r) => r.id === e.id)?.size ?? 0;
    states.set(e.id, { state: e.phase === 'check' ? 'checking' : 'copying', fraction: size ? Math.min(1, e.recCopied / size) : 0 });
    const done = e.copied + CHECK * e.checked, now = performance.now(), dt = (now - clock.t) / 1000;
    if (dt > 1 && !run.paused) {
      const r = Math.max(0, done - clock.done) / dt;
      clock = { t: now, done, rate: clock.rate ? clock.rate * 0.7 + r * 0.3 : r };
    }
    const all = run.total * (1 + CHECK);
    set({ run: { ...run, states, fraction: Math.min(1, done / Math.max(1, all)), speed: clock.rate, left: clock.rate ? (all - done) / clock.rate : 0 } });
  } else if (e.type === 'done') {
    states.set(e.id, { state: 'done', paths: e.paths });
    set({ run: { ...run, states }, list: s.list.map((r) => (r.id === e.id ? { ...r, imported: true, copies: e.paths } : r)) });
    // (A recording that was cut off may not open: it is copied, but not added.)
    if (s.addToProject && !s.list.find((r) => r.id === e.id)?.unfinished) onFiles(e.paths.slice(0, 1));
  } else if (e.type === 'failed') {
    states.set(e.id, { state: 'failed', error: e.error });
    set({ run: { ...run, states } });
  } else if (e.type === 'end') {
    const left = new Set(run.ids.filter((id) => states.get(id)?.state !== 'done'));
    for (const id of left) if (states.get(id)?.state !== 'failed') states.set(id, { state: 'waiting' });
    set({ run: { ...run, states, paused: false, fraction: left.size ? run.fraction : 1, ended: { stopped: e.stopped, error: e.error } }, picked: new Set([...left].filter((id) => s.list.some((r) => r.id === id))) });
    void ace.importDest().then((dest) => set({ dest }));
  }
}

ace.onCards(gotCards);
ace.onImport(gotEvent);
void ace.cards().then(gotCards).catch(() => {});

/** The card a file is on, if it is on one. */
export const cardOf = (path: string) => s.cards.find((c) => path.startsWith(c.root.replace(/[\\/]$/, '') + (c.root.includes('\\') ? '\\' : '/')));

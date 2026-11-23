// Memory cards as the window sees them: which are connected, what is on them, and the one import
// that can be running. The window can only name recordings this file found on a card itself, and
// copies only ever go into the folder the user chose.

import { dialog, ipcMain, powerSaveBlocker, type BrowserWindow } from 'electron';
import { unlinkSync, watch } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import { driveRoots, fileKey, findCards, scanCard, type CardRecording, type ImportEvent, type ImportJob } from './card';
import createWorker from './importWorker?nodeWorker';

interface Saved { dest?: string; /** File → where it was copied to. */ files: Record<string, string> }
export interface ImporterOptions {
  window(): BrowserWindow | null;
  allowRead(paths: string[]): void;
  /** Where to remember what was imported. */
  record: string;
  /** Folder used until the user picks one. */
  dest: string;
  /** Self-tests: a folder standing in for the computer's drives. */
  drives?: string;
}

const samePath = (a: string, b: string) => a === b || (process.platform !== 'linux' && a.toLowerCase() === b.toLowerCase());
const within = (p: string, dir: string) => { const r = path.relative(dir, p); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };

export function setupImporter(o: ImporterOptions) {
  let saved: Saved = { files: {} };
  const loaded = readFile(o.record, 'utf8').then((t) => { const v = JSON.parse(t) as Saved; saved = { dest: typeof v.dest === 'string' ? v.dest : undefined, files: v.files ?? {} }; }).catch(() => {});
  let saving = Promise.resolve();
  const save = () => {
    const text = JSON.stringify(saved);
    saving = saving.then(async () => { await mkdir(path.dirname(o.record), { recursive: true }); await writeFile(`${o.record}.new`, text); await rename(`${o.record}.new`, o.record); }).catch(() => {});
    return saving;
  };
  const dest = () => saved.dest ?? o.dest;
  const send = (ch: string, v: unknown) => { const w = o.window(); if (w && !w.isDestroyed()) w.webContents.send(ch, v); };

  // --- Cards ------------------------------------------------------------------------------------
  let cards: { root: string; name: string }[] = [];
  let looked = '';
  const look = async () => {
    cards = await findCards(await driveRoots(process.platform, o.drives));
    const now = JSON.stringify(cards);
    if (now !== looked) { looked = now; send('card:cards', cards); }
    return cards;
  };
  let soon: ReturnType<typeof setTimeout> | undefined;
  // (A card takes a moment to be ready after its drive appears.)
  const changed = () => { clearTimeout(soon); soon = setTimeout(() => { void look(); setTimeout(() => void look(), 2000); }, 300); };
  const watching = o.drives ?? (process.platform === 'darwin' ? '/Volumes' : null);
  if (watching) { try { watch(watching, changed).on('error', () => {}); } catch { /* looked for when the import window opens */ } }
  else setInterval(() => { if (o.window()?.isFocused()) void look(); }, 4000);

  const known = new Map<string, CardRecording & { root: string }>();

  /** Where an imported file is now: its path, '' when it has been moved or deleted since, null when never imported. */
  const copyOf = async (f: CardRecording['files'][number]): Promise<string | null> => {
    const at = saved.files[fileKey(f)];
    if (!at) return null;
    return stat(at).then((s) => (s.size === f.size ? at : ''), () => '');
  };

  ipcMain.handle('card:cards', look);
  ipcMain.handle('card:scan', async (_e, root: string) => {
    await loaded;
    if (!cards.some((c) => c.root === root)) throw new Error('That card isn’t connected.');
    const list = await scanCard(root);
    for (const [id, r] of known) if (r.root === root) known.delete(id);
    const out = [];
    for (const r of list) {
      known.set(r.id, { ...r, root });
      const copies = await Promise.all(r.files.map(copyOf));
      const here = copies.every((c) => c);
      if (here) o.allowRead(copies as string[]);
      out.push({ ...r, imported: copies.every((c) => c !== null), copies: here ? (copies as string[]) : null });
    }
    // Pictures for recordings without one of their own are made by the window.
    o.allowRead(list.flatMap((r) => (r.thumb ? [] : [r.files[0]!.path])));
    return out;
  });
  ipcMain.handle('card:thumb', async (_e, id: string) => {
    const t = known.get(id)?.thumb;
    if (!t) return null;
    if ((await stat(t)).size > 4_000_000) return null;
    const b = await readFile(t);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  });

  // --- Where to --------------------------------------------------------------------------------------
  const destInfo = async () => {
    await loaded;
    // The folder may not exist yet: ask about the closest one that does.
    let at = dest();
    for (;;) {
      const s = await statfs(at).catch(() => null);
      if (s) return { path: dest(), free: s.bavail * s.bsize };
      const up = path.dirname(at);
      if (up === at) return { path: dest(), free: null };
      at = up;
    }
  };
  ipcMain.handle('card:dest', destInfo);
  ipcMain.handle('card:choose-dest', async () => {
    const r = await dialog.showOpenDialog(o.window()!, { properties: ['openDirectory', 'createDirectory'], defaultPath: dest(), buttonLabel: 'Choose', message: 'Where should recordings be copied to?' });
    if (!r.canceled && r.filePaths[0]) { saved.dest = r.filePaths[0]; await save(); }
    return destInfo();
  });
  /** Self-tests choose a folder without a dialog. */
  const setDest = async (p: string | undefined) => { await loaded; saved.dest = p; await save(); };

  // --- The import ----------------------------------------------------------------------------------------
  let worker: Worker | null = null, part = '', awake = 0;
  const finish = () => { worker = null; part = ''; powerSaveBlocker.stop(awake); void save(); };
  let slowMs = 0;
  const setSlow = (ms: number) => { slowMs = ms; };

  ipcMain.handle('card:import', async (_e, ids: string[]) => {
    await loaded;
    if (worker) throw new Error('An import is already running.');
    const recs = ids.map((id) => known.get(id)).filter((r) => !!r);
    if (!recs.length) throw new Error('Nothing to import.');
    const root = recs[0]!.root;
    if (recs.some((r) => r.root !== root)) throw new Error('Import from one card at a time.');
    const to = dest();
    await mkdir(to, { recursive: true }).catch(() => { throw new Error(`The folder “${to}” can’t be used. Choose another one.`); });
    const [realTo, realRoot] = await Promise.all([realpath(to), realpath(root)]);
    if (within(realTo, realRoot) || samePath(realTo, realRoot)) throw new Error('That folder is on the card. Choose one on the computer or another disk.');
    const need = recs.reduce((s, r) => s + r.size, 0), free = (await destInfo()).free;
    if (free !== null && need > free - 200e6) throw new Error('There isn’t enough free space in that folder’s disk.');
    const job: ImportJob = { root, dest: to, recordings: recs };
    const w = createWorker({ workerData: { job, slowMs } });
    worker = w;
    awake = powerSaveBlocker.start('prevent-app-suspension');
    let ended = false;
    w.on('message', (e: ImportEvent) => {
      if (e.type === 'bytes') part = e.part;
      if (e.type === 'file') { saved.files[e.key] = e.to; void save(); }
      if (e.type === 'done') o.allowRead(e.paths);
      if (e.type === 'end') { ended = true; finish(); }
      send('card:event', e);
    });
    const died = (why: string) => { if (ended) return; ended = true; finish(); send('card:event', { type: 'end', stopped: false, error: why } satisfies ImportEvent); };
    w.on('error', (e) => died(e instanceof Error ? e.message : String(e)));
    w.on('exit', () => died('The import stopped unexpectedly.'));
  });
  ipcMain.handle('card:control', (_e, what: 'pause' | 'resume' | 'stop') => { if (['pause', 'resume', 'stop'].includes(what)) worker?.postMessage(what); });

  return {
    setDest, setSlow,
    /** Self-tests: as if nothing had ever been imported. */
    async forget() { await loaded; saved.files = {}; await save(); },
    busy: () => !!worker,
    /** The app is closing: no half-written file stays behind. */
    async close() {
      const w = worker, p = part;
      worker = null;
      if (!w) return;
      await w.terminate().catch(() => {});
      if (p.endsWith('.part')) { try { unlinkSync(p); } catch { /* already gone */ } }
    },
  };
}

// Getting recordings off a camera's memory card: which ones are there, and copying them with
// every byte checked. Nothing here ever writes to, renames or deletes anything on the card.

import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, stat, unlink, utimes, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { findBox } from '@ace/engine/src/boxes';
import { chapterName } from '@ace/engine/src/chapters';

const VIDEO = /\.(360|mp4|mov|m4v)$/i;

export interface CardFile { path: string; name: string; size: number; mtimeMs: number; /** Length (s); 0 when it can't be told. */ seconds: number; /** When it was recorded by the camera's clock (as if that were UTC). */ created: number }
export interface CardRecording {
  id: string;
  name: string;
  /** The files it is split into, in order. */
  files: CardFile[];
  size: number;
  seconds: number;
  created: number;
  /** "2026-11-22", by the camera's clock. */
  day: string;
  is360: boolean;
  /** Small picture the camera stored next to it. */
  thumb: string | null;
  /** The recording was cut off and may not open. */
  unfinished: boolean;
}

// --- Which drives are cards ------------------------------------------------------------------------

/** Where drives appear on this computer. */
export async function driveRoots(platform: string, at?: string): Promise<string[]> {
  if (platform === 'win32' && !at) return [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`);
  const bases = at ? [at] : platform === 'darwin' ? ['/Volumes'] : [`/media/${process.env.USER}`, `/run/media/${process.env.USER}`];
  const out: string[] = [];
  for (const b of bases) {
    // (The start-up disk appears as a link: skipped.)
    for (const e of await readdir(b, { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && !e.name.startsWith('.')) out.push(path.join(b, e.name));
  }
  return out;
}

/** Drives with the DCIM folder every camera makes. A drive that doesn't answer is left out. */
export async function findCards(roots: string[]): Promise<{ root: string; name: string }[]> {
  const has = async (root: string) => {
    const there = stat(path.join(root, 'DCIM')).then((s) => s.isDirectory(), () => false);
    return Promise.race([there, new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
  };
  const ok = await Promise.all(roots.map(has));
  return roots.filter((_, i) => ok[i]).map((root) => ({ root, name: path.basename(root) || root.replace(/[\\/]+$/, '') }));
}

// --- What is on it ------------------------------------------------------------------------------------

const MAC_EPOCH = Date.UTC(1904, 0, 1);

/** Length and recording time, from the file's own index (a few tiny reads, however big it is). */
async function readHeader(file: string, size: number): Promise<{ seconds: number; created: number } | null> {
  const h = await open(file, 'r');
  try {
    const reader = { size, read: async (o: number, n: number) => { const b = new Uint8Array(Math.max(0, Math.min(n, size - o))); const r = await h.read(b, 0, b.length, o); return b.subarray(0, r.bytesRead); } };
    const box = await findBox(reader, { from: 0, to: size }, 'moov', 'mvhd');
    if (!box) return null;
    const b = await reader.read(box.from, 32), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const long = b[0] === 1;
    const made = long ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
    const scale = dv.getUint32(long ? 20 : 12), len = long ? Number(dv.getBigUint64(24)) : dv.getUint32(16);
    return { seconds: scale ? len / scale : 0, created: MAC_EPOCH + made * 1000 };
  } finally {
    await h.close();
  }
}

interface Found { dir: string; name: string }
async function walk(dir: string, depth: number, out: Found[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    // (Names starting with a dot are the computer's own notes, such as ._GX010133.MP4.)
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) { if (depth > 0) await walk(path.join(dir, e.name), depth - 1, out).catch(() => {}); }
    else if (e.isFile()) out.push({ dir, name: e.name });
  }
}

const headers = new Map<string, { seconds: number; created: number } | null>();

/** Every recording on a card, oldest first, with the parts of long ones together. */
export async function scanCard(root: string): Promise<CardRecording[]> {
  const all: Found[] = [];
  await walk(path.join(root, 'DCIM'), 3, all);
  const videos = all.filter((f) => VIDEO.test(f.name));
  const files: (CardFile & { dir: string; unfinished: boolean })[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < videos.length; i = next++) {
      const { dir, name } = videos[i]!, p = path.join(dir, name);
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      const key = `${p}|${st.size}|${st.mtimeMs}`;
      if (!headers.has(key)) headers.set(key, await readHeader(p, st.size).catch(() => null));
      const h = headers.get(key)!;
      // A card has no time zone: file times are the camera's clock, read as this computer's.
      const local = st.mtimeMs - new Date(st.mtimeMs).getTimezoneOffset() * 60_000;
      const good = h && h.created > Date.UTC(2005, 0, 1);
      files.push({ path: p, name, dir, size: st.size, mtimeMs: st.mtimeMs, seconds: h?.seconds ?? 0, created: good ? h.created : local, unfinished: !h || !st.size });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  // Parts of one recording: same folder, same recording number, part numbers that follow on.
  const groups = new Map<string, { part: number; f: (typeof files)[number] }[]>();
  for (const f of files) {
    const c = chapterName(f.name);
    const k = `${f.dir}|${c?.key ?? f.name}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push({ part: c?.part ?? 1, f });
  }
  const out: CardRecording[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.part - b.part);
    let run: typeof g = [];
    const end = () => {
      if (!run.length) return;
      const list = run.map((x) => x.f), first = list[0]!;
      out.push({
        id: first.path, name: first.name, files: list.map(({ dir: _d, unfinished: _u, ...f }) => f), size: list.reduce((s, f) => s + f.size, 0), seconds: list.reduce((s, f) => s + f.seconds, 0),
        created: first.created, day: new Date(first.created).toISOString().slice(0, 10), is360: /\.360$/i.test(first.name) || /^GS\w{2}\d{4}/i.test(first.name),
        thumb: thumbFor(first, all), unfinished: list.some((f) => f.unfinished),
      });
    };
    for (const x of g) {
      if (run.length && x.part !== run[run.length - 1]!.part + 1) { end(); run = []; }
      run.push(x);
    }
    end();
  }
  return out.sort((a, b) => a.created - b.created || (a.name < b.name ? -1 : 1));
}

function thumbFor(f: { dir: string; name: string }, all: Found[]): string | null {
  const want = f.name.replace(/\.\w+$/, '.thm').toLowerCase();
  const hit = all.find((x) => x.dir === f.dir && x.name.toLowerCase() === want);
  return hit ? path.join(hit.dir, hit.name) : null;
}

/** Recognises a recording again, whichever folder or drive letter it turns up under. */
export const fileKey = (f: Pick<CardFile, 'name' | 'size' | 'created' | 'seconds'>) => `${f.name.toLowerCase()}|${f.size}|${f.seconds ? Math.round(f.created / 1000) : ''}`;

// --- Copying ---------------------------------------------------------------------------------------------

export class Stopped extends Error {}

export interface Control {
  /** Resolves when not paused; throws Stopped when the user stopped the import. */
  gate(): Promise<void>;
}

const CHUNK = 4 * 1024 * 1024;

async function readInto(h: FileHandle, buf: Buffer, pos: number): Promise<number> {
  let n = 0;
  while (n < buf.length) {
    const r = await h.read(buf, n, buf.length - n, pos + n);
    if (!r.bytesRead) break;
    n += r.bytesRead;
  }
  return n;
}

async function hashFile(file: string, ctl: Control, onBytes: (n: number) => void): Promise<string> {
  const h = await open(file, 'r'), sum = createHash('sha256'), buf = Buffer.allocUnsafe(CHUNK);
  try {
    for (let pos = 0; ; ) {
      await ctl.gate();
      const n = await readInto(h, buf, pos);
      if (!n) break;
      sum.update(buf.subarray(0, n));
      pos += n;
      onBytes(n);
    }
  } finally {
    await h.close();
  }
  return sum.digest('hex');
}

export interface CopyHooks { onCopy(bytes: number): void; onCheck(bytes: number): void; /** Tests: after writing, before checking. */ written?(part: string): Promise<void> }

/** The half-written copy of the file being imported, for cleaning up if the app is closed. */
export const partOf = (to: string) => `${to}.part`;

/**
 * Copies a file, then reads the copy back and compares checksums. Only then does it get its
 * real name; until that moment it is "<name>.part".
 */
export async function copyVerified(from: string, to: string, f: { size: number; mtimeMs: number }, ctl: Control, hooks: CopyHooks): Promise<void> {
  const part = partOf(to);
  let src: FileHandle | undefined, dst: FileHandle | undefined;
  try {
    await mkdir(path.dirname(to), { recursive: true });
    src = await open(from, 'r');
    dst = await open(part, 'w');
    const sum = createHash('sha256');
    // Reads the next piece while the last one is being written.
    let a = Buffer.allocUnsafe(CHUNK), b = Buffer.allocUnsafe(CHUNK), pos = 0;
    let reading = readInto(src, a, 0);
    for (;;) {
      const n = await reading;
      if (!n) break;
      await ctl.gate();
      reading = readInto(src, b, pos + n);
      // (Seen when it is awaited next; this stops it being reported as unhandled meanwhile.)
      reading.catch(() => {});
      sum.update(a.subarray(0, n));
      for (let w = 0; w < n; ) w += (await dst.write(a, w, n - w, pos + w)).bytesWritten;
      pos += n;
      hooks.onCopy(n);
      [a, b] = [b, a];
    }
    if (pos !== f.size) throw new Error('The file on the card ended early.');
    await dst.sync();
    await dst.close();
    dst = undefined;
    await hooks.written?.(part);
    if ((await hashFile(part, ctl, hooks.onCheck)) !== sum.digest('hex')) throw new Mismatch();
    await utimes(part, new Date(), new Date(f.mtimeMs));
    if (await stat(to).then(() => true, () => false)) throw new Error('A file with that name appeared in the folder meanwhile.');
    await rename(part, to);
  } catch (e) {
    await dst?.close().catch(() => {});
    await unlink(part).catch(() => {});
    throw e;
  } finally {
    await src?.close().catch(() => {});
  }
}
export class Mismatch extends Error { constructor() { super('The copy didn’t match the card, twice.'); } }

/**
 * The folder for a recording: `base`, or "base 2" … when that one holds something different under
 * the same name or recording number (cameras count from 0001 again on every new card). Names are
 * never changed, so parts keep belonging together. `have` are files already there, identical.
 */
export async function place(base: string, files: CardFile[], ctl: Control): Promise<{ dir: string; have: Set<string> }> {
  const mine = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const keys = new Set(files.map((f) => chapterName(f.name)?.key).filter(Boolean));
  for (let n = 1; n < 1000; n++) {
    const dir = n === 1 ? base : `${base} ${n}`, have = new Set<string>();
    let clash = false;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const f = mine.get(name.toLowerCase());
      const c = chapterName(name)?.key;
      if (f) {
        const there = path.join(dir, name), st = await stat(there);
        const same = st.size === f.size && (await hashFile(there, ctl, () => {})) === (await hashFile(f.path, ctl, () => {}));
        if (!same) { clash = true; break; }
        have.add(f.name);
      } else if (c && keys.has(c)) {
        // Another part of the same recording, from the same folder of the card, belongs here.
        const size = (p: string) => stat(p).then((x) => x.size, () => -1);
        const [there, onCard] = await Promise.all([size(path.join(dir, name)), size(path.join(path.dirname(files[0]!.path), name))]);
        if (there !== onCard) { clash = true; break; }
      }
    }
    if (!clash) return { dir, have };
  }
  throw new Error('No free folder name was found.');
}

export interface ImportJob { root: string; dest: string; recordings: CardRecording[] }
export type ImportEvent =
  | { type: 'bytes'; id: string; phase: 'copy' | 'check'; copied: number; checked: number; recCopied: number; part: string }
  | { type: 'file'; key: string; to: string }
  | { type: 'done'; id: string; paths: string[] }
  | { type: 'failed'; id: string; error: string }
  | { type: 'end'; stopped: boolean; error?: string };

const errorCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? '';

/** Copies recordings one after another. One that fails is reported and the rest carry on, unless the card or the space is gone. */
export async function runImport(job: ImportJob, ctl: Control, emit: (e: ImportEvent) => void, test?: { written?(part: string): Promise<void> }): Promise<void> {
  let copied = 0, checked = 0;
  for (const rec of job.recordings) {
    const startC = copied, startK = checked;
    let last = 0;
    const tell = (phase: 'copy' | 'check', part: string, force = false) => {
      const now = Date.now();
      if (!force && now - last < 100) return;
      last = now;
      emit({ type: 'bytes', id: rec.id, phase, copied, checked, recCopied: copied - startC, part });
    };
    try {
      await ctl.gate();
      const { dir, have } = await place(path.join(job.dest, rec.day), rec.files, ctl);
      const paths: string[] = [];
      for (const f of rec.files) {
        const to = path.join(dir, f.name);
        if (have.has(f.name)) { copied += f.size; checked += f.size; }
        else {
          const c0 = copied, k0 = checked;
          for (let attempt = 1; ; attempt++) {
            tell('copy', partOf(to), true);
            try {
              await copyVerified(f.path, to, f, ctl, {
                onCopy: (n) => { copied += n; tell('copy', partOf(to)); },
                onCheck: (n) => { checked += n; tell('check', partOf(to)); },
                written: test?.written,
              });
              break;
            } catch (e) {
              copied = c0; checked = k0;
              if (!(e instanceof Mismatch) || attempt === 2) throw e;
            }
          }
        }
        paths.push(to);
        emit({ type: 'file', key: fileKey(f), to });
      }
      emit({ type: 'done', id: rec.id, paths });
    } catch (e) {
      copied = startC + rec.size; checked = startK + rec.size;
      if (e instanceof Stopped) { emit({ type: 'end', stopped: true }); return; }
      const gone = !(await stat(path.join(job.root, 'DCIM')).then(() => true, () => false));
      const code = errorCode(e);
      const fatal = gone ? 'The card was removed before everything was copied.' : code === 'ENOSPC' ? 'The disk is full.' : code === 'EROFS' ? 'That folder can’t be written to.' : null;
      const error = fatal ?? (code === 'EFBIG' ? 'The destination disk can’t hold files this large. Choose a folder on another disk.'
        : code === 'EIO' || code === 'ENXIO' ? 'This file couldn’t be read from the card.'
          : code === 'EACCES' || code === 'EPERM' ? 'The computer didn’t allow this file to be copied.' : e instanceof Error ? e.message : String(e));
      emit({ type: 'failed', id: rec.id, error });
      if (fatal) { emit({ type: 'end', stopped: false, error: fatal }); return; }
    }
  }
  emit({ type: 'end', stopped: false });
}

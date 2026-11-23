// What a set of dropped or picked files and folders holds that can be imported.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const VIDEO_EXT = ['360', 'mp4', 'mov', 'lrv', 'm4v'];
export const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'];
const ext = (p: string) => path.extname(p).slice(1).toLowerCase();
export const hasExt = (p: string, list: string[]) => list.includes(ext(p));

export interface Found {
  video: string[];
  audio: string[];
  /** Things left out, and why (shown to the user). */
  skipped: { name: string; why: string }[];
}

/** Folders are looked into this deep (a card's DCIM/100GOPRO is two levels down). */
const DEPTH = 3;
const MAX_FILES = 2000;

/**
 * Sorts paths into videos and sound. Folders are searched (hidden ones and macOS packages are
 * not). A GoPro's low-resolution .LRV copy is left out when its full recording is there too.
 */
export async function findImportable(paths: string[]): Promise<Found> {
  const files: string[] = [];
  const skipped: Found['skipped'] = [];
  const walk = async (p: string, depth: number, top: boolean) => {
    if (files.length >= MAX_FILES) return;
    const s = await stat(p).catch(() => null);
    if (!s) { if (top) skipped.push({ name: path.basename(p), why: 'not found' }); return; }
    if (s.isDirectory()) {
      if (depth >= DEPTH || /\.(app|photoslibrary|fcpbundle|aplibrary)$/i.test(p)) return;
      const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.')) continue;
        await walk(path.join(p, e.name), depth + 1, false);
      }
      return;
    }
    if (!s.isFile()) return;
    if (hasExt(p, VIDEO_EXT) || hasExt(p, AUDIO_EXT)) files.push(path.resolve(p));
    else if (top) skipped.push({ name: path.basename(p), why: ext(p) ? `.${ext(p)} files can’t be imported` : 'not a video' });
  };
  for (const p of paths) await walk(p, 0, true);

  // GoPro: GL010133.LRV is the proxy of GX010133.MP4 (same number, same folder).
  const full = new Set(files.filter((f) => !hasExt(f, ['lrv'])).map((f) => path.join(path.dirname(f), path.basename(f, path.extname(f)).slice(2).toLowerCase())));
  const video: string[] = [], audio: string[] = [];
  for (const f of [...new Set(files)]) {
    if (hasExt(f, ['lrv']) && full.has(path.join(path.dirname(f), path.basename(f, path.extname(f)).slice(2).toLowerCase()))) continue;
    (hasExt(f, AUDIO_EXT) ? audio : video).push(f);
  }
  if (files.length >= MAX_FILES) skipped.push({ name: `More than ${MAX_FILES} files`, why: 'only the first ones were imported' });
  return { video, audio, skipped };
}

// The projects library: every project the user saved, in one list.
// Projects saved without choosing a place go in the app's own Projects folder; projects saved or
// opened anywhere else are remembered by path. The renderer may only read and write projects in
// this list (or a file the user just chose in a save dialog).
import { app, ipcMain, shell } from 'electron';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectFileName, uniqueName } from './projectNames';

/** What the list knows about a project beyond the file itself. */
interface Meta { thumb?: string; clips?: number; durationUs?: number; opened?: number }
export interface ProjectEntry { path: string; name: string; modified: number; inLibrary: boolean; thumb?: string; clips?: number; durationUs?: number }

const EXT = '.acproj';

export function setupProjects(o: { allowMedia: (text: string) => void; chosen: (p: string) => boolean }) {
  const dir = () => path.join(app.getPath('userData'), 'Projects');
  const indexFile = () => path.join(app.getPath('userData'), 'projects.json');
  let index: Record<string, Meta> | null = null;

  const load = async () => {
    if (index) return index;
    try {
      const raw = JSON.parse(await readFile(indexFile(), 'utf8')) as unknown;
      index = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Meta>) : {};
    } catch {
      index = {};
    }
    return index;
  };
  const persist = async () => {
    const tmp = `${indexFile()}.tmp`;
    await writeFile(tmp, JSON.stringify(index ?? {}));
    await rename(tmp, indexFile());
  };
  const inLibrary = (p: string) => path.dirname(path.resolve(p)) === dir();
  const isProject = (p: string) => typeof p === 'string' && path.isAbsolute(p) && p.toLowerCase().endsWith(EXT);
  /** A project the renderer may touch: in the library, in the list, or just chosen in a dialog. */
  const known = async (p: string) => isProject(p) && (inLibrary(p) || path.resolve(p) in (await load()) || o.chosen(p));
  const guard = async (p: string) => { if (!(await known(p))) throw new Error('File access denied'); return path.resolve(p); };
  const namesIn = async (d: string) => readdir(d).catch(() => [] as string[]);

  /** Adds a project the user opened or saved somewhere to the list. */
  const remember = async (p: string, meta: Meta = {}) => {
    const idx = await load(), key = path.resolve(p);
    idx[key] = { ...idx[key], ...meta };
    await persist().catch(() => {});
  };

  ipcMain.handle('projects:list', async (): Promise<ProjectEntry[]> => {
    const idx = await load();
    await mkdir(dir(), { recursive: true });
    const files = (await namesIn(dir())).filter((n) => n.toLowerCase().endsWith(EXT)).map((n) => path.join(dir(), n));
    const all = [...new Set([...files, ...Object.keys(idx)])];
    const out: ProjectEntry[] = [];
    let changed = false;
    for (const p of all) {
      const s = await stat(p).catch(() => null);
      // Projects deleted or moved outside the app drop off the list.
      if (!s?.isFile()) { if (p in idx) { delete idx[p]; changed = true; } continue; }
      const m = idx[p] ?? {};
      // (Thumbnails saved by beta 3 were blob: addresses, which don't outlast the app: left out.)
      out.push({ path: p, name: path.basename(p, path.extname(p)), modified: s.mtimeMs, inLibrary: inLibrary(p), thumb: m.thumb?.startsWith('data:image/') ? m.thumb : undefined, clips: m.clips, durationUs: m.durationUs });
    }
    if (changed) await persist().catch(() => {});
    return out.sort((a, b) => b.modified - a.modified);
  });

  ipcMain.handle('projects:open', async (_e, p: string) => {
    const key = await guard(p);
    const text = await readFile(key, 'utf8');
    o.allowMedia(text);
    await remember(key, { opened: Date.now() });
    return { path: key, text };
  });

  /** Saves to `path`, or (without one) as a new project called `name` in the library. Returns where. */
  ipcMain.handle('projects:save', async (_e, a: { path?: string; name?: string; text: string; meta?: Meta }) => {
    let key: string;
    if (a.path) key = await guard(a.path);
    else {
      await mkdir(dir(), { recursive: true });
      key = path.join(dir(), uniqueName(projectFileName(a.name ?? ''), await namesIn(dir()), EXT));
    }
    const tmp = `${key}.saving`;
    await writeFile(tmp, a.text);
    await rename(tmp, key);
    await remember(key, { thumb: a.meta?.thumb, clips: a.meta?.clips, durationUs: a.meta?.durationUs });
    return key;
  });

  ipcMain.handle('projects:rename', async (_e, p: string, name: string) => {
    const key = await guard(p);
    const d = path.dirname(key);
    const want = projectFileName(name);
    if (want === path.basename(key, path.extname(key))) return key;
    const others = (await namesIn(d)).filter((n) => n !== path.basename(key));
    const to = path.join(d, uniqueName(want, others, EXT));
    await rename(key, to);
    const idx = await load();
    if (idx[key]) { idx[to] = idx[key]!; delete idx[key]; }
    else idx[to] = {};
    await persist().catch(() => {});
    return to;
  });

  ipcMain.handle('projects:duplicate', async (_e, p: string) => {
    const key = await guard(p);
    await mkdir(dir(), { recursive: true });
    const to = path.join(dir(), uniqueName(`${path.basename(key, path.extname(key))} copy`, await namesIn(dir()), EXT));
    await copyFile(key, to);
    const idx = await load();
    idx[to] = { ...idx[key], opened: undefined };
    await persist().catch(() => {});
    return to;
  });

  /** Library projects go to the Trash / Recycle Bin; ones saved elsewhere just leave the list. */
  ipcMain.handle('projects:remove', async (_e, p: string) => {
    const key = await guard(p);
    if (inLibrary(key)) await shell.trashItem(key);
    const idx = await load();
    delete idx[key];
    await persist().catch(() => {});
  });

  ipcMain.handle('projects:reveal', async (_e, p: string) => shell.showItemInFolder(await guard(p)));

  return { remember };
}

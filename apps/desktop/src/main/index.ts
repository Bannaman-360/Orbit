import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { open, mkdir, readdir, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { extractOrientation, type GpmfRequest } from '@ace/telemetry/node';

const SELFTEST = process.argv.includes('--selftest');
// apps/desktop → repo root
const REPO_ROOT = path.resolve(app.getAppPath(), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'fixtures');
const SELFTEST_OUT = path.join(REPO_ROOT, 'selftest-out');
const MEDIA_EXT = new Set(['.360', '.mp4', '.mov']);

/** Files the renderer may read: ones the user picked, plus anything under fixtures/. */
const allowed = new Set<string>();
const handles = new Map<string, FileHandle>();
let win: BrowserWindow | null = null;

function isAllowed(p: string) {
  const r = path.resolve(p);
  return allowed.has(r) || r.startsWith(FIXTURES + path.sep);
}

async function handle(p: string): Promise<FileHandle> {
  if (!isAllowed(p)) throw new Error('File access denied');
  let h = handles.get(p);
  if (!h) {
    h = await open(p, 'r');
    handles.set(p, h);
  }
  return h;
}

async function readRange(p: string, offset: number, length: number): Promise<Buffer> {
  const h = await handle(p);
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await h.read(buf, 0, length, offset);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

async function listMedia(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMedia(p)));
    else if (MEDIA_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out.sort();
}

ipcMain.handle('app:info', () => ({ selftest: SELFTEST, fixtures: FIXTURES, versions: process.versions }));

ipcMain.handle('media:open-dialog', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['360', 'mp4', 'MP4', 'mov', 'MOV'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = path.resolve(r.filePaths[0]);
  allowed.add(p);
  return { path: p, size: (await stat(p)).size };
});

ipcMain.handle('media:stat', async (_e, p: string) => {
  if (!isAllowed(p)) throw new Error('File access denied');
  return { path: p, size: (await stat(p)).size };
});

ipcMain.handle('media:read', async (_e, p: string, offset: number, length: number) => {
  const b = await readRange(p, offset, length);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
});

ipcMain.handle('media:list-fixtures', () => listMedia(FIXTURES));

ipcMain.handle('telemetry:orientation', async (_e, p: string, req: GpmfRequest) => {
  return extractOrientation((o, l) => readRange(p, o, l), req);
});

ipcMain.handle('fixtures:write', async (_e, name: string, data: Uint8Array) => {
  const dir = path.join(FIXTURES, 'synthetic');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, path.basename(name));
  await handles.get(p)?.close();
  handles.delete(p);
  await writeFile(p, data);
  return p;
});

ipcMain.handle('selftest:capture', async (_e, name: string) => {
  await mkdir(SELFTEST_OUT, { recursive: true });
  const img = await win!.webContents.capturePage();
  const p = path.join(SELFTEST_OUT, `${path.basename(name)}.png`);
  await writeFile(p, img.toPNG());
  return p;
});

ipcMain.handle('selftest:done', async (_e, report: unknown) => {
  await mkdir(SELFTEST_OUT, { recursive: true });
  await writeFile(path.join(SELFTEST_OUT, 'report.json'), JSON.stringify(report, null, 2));
  setTimeout(() => app.quit(), 200);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#111317',
    title: 'Action Cam Editor — Phase 0 spike',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    if (SELFTEST) console.log(`[renderer] ${e.message}`);
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  for (const h of handles.values()) void h.close();
});

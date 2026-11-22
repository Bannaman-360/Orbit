import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { createHash } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { extractOrientation, type GpmfRequest } from '@ace/telemetry/node';

const SELFTEST = process.argv.includes('--selftest');
const SELFTEST_MODE = process.argv.find((a) => a.startsWith('--selftest-mode='))?.split('=')[1] ?? 'full';
// apps/desktop → repo root
const REPO_ROOT = path.resolve(app.getAppPath(), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'fixtures');
const SELFTEST_OUT = path.join(REPO_ROOT, 'selftest-out');
const VIDEO_EXT = ['360', 'mp4', 'MP4', 'mov', 'MOV', 'lrv', 'LRV'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'MP3', 'M4A', 'WAV'];

// Self-tests run in the background: no Dock icon, no visible window, no sound, never in front of
// what the user is doing, and with their own app data (layout, autosave, proxies).
// `--selftest-show` brings the window back for watching a test.
const HIDDEN = SELFTEST && !process.argv.includes('--selftest-show');
if (SELFTEST) app.setPath('userData', path.join(app.getPath('appData'), 'ace-selftest'));
if (HIDDEN) {
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  // A hidden window must keep drawing at full speed.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

/** Files the renderer may read: ones the user picked, plus anything under fixtures/. */
const readable = new Set<string>();
/** Files the renderer may write: ones the user chose in a save dialog. */
const writable = new Set<string>();
const handles = new Map<string, FileHandle>();
let win: BrowserWindow | null = null;

const inside = (p: string, dir: string) => path.resolve(p).startsWith(dir + path.sep);
const canRead = (p: string) => readable.has(path.resolve(p)) || writable.has(path.resolve(p)) || inside(p, FIXTURES) || inside(p, SELFTEST_OUT);
const canWrite = (p: string) => writable.has(path.resolve(p)) || inside(p, SELFTEST_OUT) || inside(p, path.join(FIXTURES, 'synthetic'));
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.acproj');

function allowRead(paths: string[]) {
  for (const p of paths) readable.add(path.resolve(p));
}

async function handle(p: string): Promise<FileHandle> {
  if (!canRead(p)) throw new Error('File access denied');
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
    else if (VIDEO_EXT.includes(path.extname(e.name).slice(1))) out.push(p);
  }
  return out.sort();
}

const asBytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

ipcMain.handle('app:info', () => ({ selftest: SELFTEST, selftestMode: SELFTEST_MODE, fixtures: FIXTURES, versions: process.versions }));

// --- Dialogs -----------------------------------------------------------------

ipcMain.handle('dialog:open-media', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: VIDEO_EXT }] });
  if (r.canceled) return [];
  allowRead(r.filePaths);
  return r.filePaths;
});

ipcMain.handle('dialog:open-audio', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: AUDIO_EXT }] });
  if (r.canceled) return [];
  allowRead(r.filePaths);
  return r.filePaths;
});

ipcMain.handle('dialog:open-lut', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube', 'CUBE'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  allowRead(r.filePaths);
  return r.filePaths[0];
});

ipcMain.handle('dialog:open-project', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Project', extensions: ['acproj'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const text = await readFile(r.filePaths[0], 'utf8');
  allowProjectMedia(text);
  return { path: r.filePaths[0], text };
});

/** A project the user opened may read the media files it references. */
function allowProjectMedia(text: string) {
  const found: string[] = [];
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string') {
      if (['mediaPath', 'path', 'lutPath', 'library'].includes(key) && path.isAbsolute(v)) found.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    /* not JSON */
  }
  allowRead(found);
}

ipcMain.handle('dialog:open-theme', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Theme or interface settings', extensions: ['acetheme', 'json'] }] });
  return r.canceled || !r.filePaths[0] ? null : readFile(r.filePaths[0], 'utf8');
});

ipcMain.handle('dialog:save', async (_e, kind: 'project' | 'video' | 'image' | 'theme', defaultName: string) => {
  const filters = {
    project: [{ name: 'Project', extensions: ['acproj'] }],
    video: [{ name: 'MP4 video', extensions: ['mp4'] }],
    image: [{ name: 'Image', extensions: ['jpg', 'png'] }],
    theme: [{ name: 'Theme or interface settings', extensions: ['acetheme'] }],
  }[kind];
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  writable.add(path.resolve(r.filePath));
  return r.filePath;
});

// --- File access ---------------------------------------------------------------

ipcMain.handle('file:stat', async (_e, p: string) => {
  if (!canRead(p)) throw new Error('File access denied');
  return { path: p, size: (await stat(p)).size };
});

ipcMain.handle('file:read', async (_e, p: string, offset: number, length: number) => asBytes(await readRange(p, offset, length)));

ipcMain.handle('file:read-all', async (_e, p: string) => {
  if (!canRead(p)) throw new Error('File access denied');
  return asBytes(await readFile(p));
});

ipcMain.handle('file:write', async (_e, p: string, data: Uint8Array | string) => {
  if (!canWrite(p)) throw new Error('File access denied');
  await mkdir(path.dirname(p), { recursive: true });
  await handles.get(p)?.close();
  handles.delete(p);
  await writeFile(p, data);
  readable.add(path.resolve(p));
  return p;
});

/** Positional writes for streaming exports. Call file:create first. */
const writeHandles = new Map<string, FileHandle>();
ipcMain.handle('file:create', async (_e, p: string) => {
  if (!canWrite(p)) throw new Error('File access denied');
  await mkdir(path.dirname(p), { recursive: true });
  await writeHandles.get(p)?.close();
  writeHandles.set(p, await open(p, 'w'));
});
ipcMain.handle('file:write-at', async (_e, p: string, position: number, data: Uint8Array) => {
  const h = writeHandles.get(p);
  if (!h) throw new Error('File not open for writing');
  await h.write(data, 0, data.byteLength, position);
});
ipcMain.handle('file:close', async (_e, p: string) => {
  await writeHandles.get(p)?.close();
  writeHandles.delete(p);
  readable.add(path.resolve(p));
});

// --- Preview proxies ------------------------------------------------------------
// Low-resolution copies of media for smooth preview on slower machines. Stored in the app's
// data folder, named from the source file's path, size and modification time (so an edited
// source gets a fresh proxy).
const proxyDir = () => path.join(app.getPath('userData'), 'proxies');
const inProxyDir = (p: string) => inside(p, proxyDir());
ipcMain.handle('proxy:path', async (_e, src: string, level: number) => {
  if (!canRead(src)) throw new Error('File access denied');
  const st = await stat(src);
  const key = createHash('sha1').update(`${path.resolve(src)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  const file = path.join(proxyDir(), `${key}-${Math.round(level)}.mp4`);
  const exists = await stat(file).then(() => true, () => false);
  readable.add(file);
  writable.add(file);
  writable.add(`${file}.part`);
  return { path: file, exists };
});
/** Finishes a proxy: the .part file becomes the real one. */
ipcMain.handle('proxy:finish', async (_e, file: string) => {
  if (!inProxyDir(file)) throw new Error('File access denied');
  await rename(`${file}.part`, file);
  readable.add(path.resolve(file));
});
ipcMain.handle('proxy:discard', async (_e, file: string) => {
  if (!inProxyDir(file)) throw new Error('File access denied');
  await unlink(`${file}.part`).catch(() => {});
});

ipcMain.handle('media:list-fixtures', () => listMedia(FIXTURES));

ipcMain.handle('telemetry:orientation', async (_e, p: string, req: GpmfRequest) => extractOrientation((o, l) => readRange(p, o, l), req));

// --- Autosave ------------------------------------------------------------------

ipcMain.handle('autosave:load', async () => {
  try {
    const text = await readFile(autosavePath(), 'utf8');
    // Media referenced by the last session may be read again.
    allowProjectMedia(text);
    return text;
  } catch {
    return null;
  }
});
ipcMain.handle('autosave:save', async (_e, text: string) => {
  await mkdir(path.dirname(autosavePath()), { recursive: true });
  await writeFile(autosavePath(), text);
});

// --- Self-test -------------------------------------------------------------------

ipcMain.handle('selftest:capture', async (_e, name: string) => {
  await mkdir(SELFTEST_OUT, { recursive: true });
  const img = await win!.webContents.capturePage();
  const p = path.join(SELFTEST_OUT, `${path.basename(name)}.png`);
  await writeFile(p, img.toPNG());
  return p;
});
// Self-test only: run code as if the user had clicked (full screen needs a user gesture).
ipcMain.handle('selftest:gesture', async (_e, code: string) => (SELFTEST ? win!.webContents.executeJavaScript(code, true) : null));
// Where the window's processor time goes (seconds since start): script, style, layout, all tasks.
ipcMain.handle('selftest:metrics', async () => {
  const d = win!.webContents.debugger;
  if (!d.isAttached()) { d.attach('1.3'); await d.sendCommand('Performance.enable'); }
  const r = (await d.sendCommand('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  return Object.fromEntries(r.metrics.filter((m) => /Duration|Count|Nodes/.test(m.name)).map((m) => [m.name, m.value]));
});
// Real mouse and key presses (proper hit-testing and pointer capture), for interface tests.
ipcMain.handle('selftest:input', (_e, ev: Electron.MouseInputEvent | Electron.KeyboardInputEvent) => { if (SELFTEST) win!.webContents.sendInputEvent(ev); });
ipcMain.handle('selftest:out', (_e, name: string) => path.join(SELFTEST_OUT, path.basename(name)));
ipcMain.handle('selftest:done', async (_e, report: unknown) => {
  await mkdir(SELFTEST_OUT, { recursive: true });
  await writeFile(path.join(SELFTEST_OUT, 'report.json'), JSON.stringify(report, null, 2));
  setTimeout(() => app.quit(), 200);
});

// --- Window appearance & menu bar ---------------------------------------------------------------

const MAC = process.platform === 'darwin';
// The window follows the app's theme: light/dark, and the see-through material behind panels.
ipcMain.handle('ui:window', (_e, o: { mode: 'auto' | 'light' | 'dark'; translucent: boolean }) => {
  nativeTheme.themeSource = o.mode === 'light' || o.mode === 'dark' ? o.mode : 'system';
  if (MAC && win) win.setVibrancy(o.translucent ? 'under-window' : null);
});

const send = (cmd: string) => () => win?.webContents.send('menu:command', cmd);
/** The menu bar. Shortcuts are handled in the window (they can be changed), so none are set here. */
function buildMenu() {
  const it = (label: string, cmd: string): MenuItemConstructorOptions => ({ label, click: send(cmd) });
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  const template: MenuItemConstructorOptions[] = [
    ...(MAC ? [{ label: app.name, submenu: [{ role: 'about' }, sep, it('Customize…', 'customize'), sep, { role: 'services' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }] as MenuItemConstructorOptions[] }] : []),
    { label: 'File', submenu: [it('Import Media…', 'import'), it('Add Music…', 'music'), sep, it('Open Project…', 'open'), it('Save Project…', 'save'), sep, it('Export Video…', 'export'), it('Save Frame…', 'grab'), sep, MAC ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', submenu: [it('Undo', 'undo'), it('Redo', 'redo'), sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, sep, it('Split', 'split'), it('Split and Delete Left', 'delLeft'), it('Split and Delete Right', 'delRight'), it('Duplicate Clip', 'duplicate'), it('Delete', 'delete'), sep, it('Add Keyframe', 'keyframe'), it('Add Text', 'text'), it('Track Subject…', 'track')] },
    { label: 'View', submenu: [it('Media', 'toggleMedia'), it('Inspector', 'toggleInspector'), it('Timeline', 'toggleTimeline'), sep, it('Customize…', 'customize'), it('Arrange Interface', 'arrange'), it('Undo Interface Change', 'undoUi'), sep, it('Show Before / After', 'compare'), it('Full-Screen Preview', 'fullscreen'), { role: 'togglefullscreen', label: 'Enter Full Screen Window' }, ...(app.isPackaged ? [] : [sep, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(MAC ? [sep, { role: 'front' }] as MenuItemConstructorOptions[] : [])] },
    { label: 'Help', submenu: [it('Keyboard Shortcuts', 'shortcuts')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  buildMenu();
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    // On a Mac the app's toolbar is the title bar, and panels sit on the system material.
    backgroundColor: MAC ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ececf0',
    ...(MAC ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 19 }, vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const } : {}),
    title: 'Action Cam Editor',
    show: !HIDDEN,
    focusable: !HIDDEN,
    // (Full screen then fills the hidden window instead of taking over a display.)
    fullscreenable: !HIDDEN,
    skipTaskbar: HIDDEN,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  if (HIDDEN) win.webContents.setAudioMuted(true);
  win.on('enter-full-screen', () => win?.webContents.send('win:fullscreen', true));
  win.on('leave-full-screen', () => win?.webContents.send('win:fullscreen', false));
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
  for (const h of writeHandles.values()) void h.close();
});

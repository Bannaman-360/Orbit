// The problem log: errors from every part of the app go to one file on this computer
// (userData/logs/app.log, kept under about 2 MB), with folders and the user's name removed.
// Help → Report a Problem shows the log with a few facts about the computer, for the user to copy
// and send. Nothing is sent anywhere by the app.

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logLine, makeLimiter } from './diagnosticsText';

const MAX_BYTES = 1_000_000;
let file = '';
const home = os.homedir();
const allowed = makeLimiter();

/** Where the log lives (inside `dir`, normally userData/logs). */
export function logFile() { return file; }

export function log(level: 'error' | 'warn' | 'info', source: string, message: unknown) {
  if (!file) return;
  const text = message instanceof Error ? `${message.message}\n${message.stack ?? ''}`.trim() : String(message);
  if (!allowed(`${source}|${text.slice(0, 200)}`)) return;
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.log$/, '.old.log'));
    appendFileSync(file, logLine(level, source, text, home));
  } catch { /* a full or read-only disk: nothing more to do */ }
}

function tail(n: number) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch { return '(no problems logged)'; }
}

interface Setup {
  dir: string;
  window: () => BrowserWindow | null;
  /** Hardware encoders found for the deep formats. */
  encoders: () => Promise<Record<string, string | undefined>>;
  /** Self-tests: no dialogs. */
  quiet: boolean;
}

export function setupDiagnostics(o: Setup) {
  mkdirSync(o.dir, { recursive: true });
  file = path.join(o.dir, 'app.log');
  // Each self-test starts with an empty log, so it sees only its own problems.
  if (o.quiet) try { rmSync(file, { force: true }); } catch { /* fine */ }
  log('info', 'app', `Started ${app.getName()} ${app.getVersion()} on ${process.platform} ${os.release()} (${process.arch})`);

  process.on('uncaughtException', (e) => log('error', 'main', e));
  process.on('unhandledRejection', (e) => log('error', 'main', e instanceof Error ? e : `Unhandled rejection: ${String(e)}`));

  app.on('child-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') log('error', 'process', `${d.type}${d.name ? ` (${d.name})` : ''} stopped: ${d.reason}, exit code ${d.exitCode}`);
  });
  app.on('render-process-gone', (_e, wc, d) => {
    if (d.reason === 'clean-exit') return;
    log('error', 'window', `The window stopped: ${d.reason}, exit code ${d.exitCode}`);
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || o.quiet) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'error',
      message: 'Something went wrong and the editor stopped.',
      detail: 'Reload it to carry on: your edit is saved every few seconds and comes back. If it keeps happening, choose Help → Report a Problem after reloading.',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r === 0) win.reload(); else app.quit();
  });

  // Errors from the window: its console errors, and the messages it shows the user.
  ipcMain.on('log:error', (_e, source: string, message: string) => log('error', String(source).slice(0, 40), String(message)));

  ipcMain.handle('report:text', async (_e, fromWindow: string) => {
    const gpu = (await app.getGPUInfo('basic').catch(() => null)) as { gpuDevice?: { vendorId: number; deviceId: number; active?: boolean }[] } | null;
    const dev = gpu?.gpuDevice?.find((d) => d.active) ?? gpu?.gpuDevice?.[0];
    const enc = await o.encoders().catch(() => ({}));
    const cpu = os.cpus()[0]?.model ?? 'unknown';
    const lines = [
      `${app.getName()} ${app.getVersion()}${app.isPackaged ? '' : ' (development)'}`,
      `System: ${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform} ${process.getSystemVersion()} (${process.arch})`,
      `Processor: ${cpu}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB memory`,
      `Graphics: ${dev ? `vendor 0x${dev.vendorId.toString(16)} device 0x${dev.deviceId.toString(16)}` : 'unknown'}${fromWindow ? `; ${String(fromWindow).slice(0, 300)}` : ''}`,
      `10-bit HEVC: ${(enc as Record<string, string>).hevc10 ?? 'not available'}; ProRes: ${(enc as Record<string, string>).prores ?? 'not available'}`,
      `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
      '',
      'Recent problems:',
      tail(200),
    ];
    return lines.join('\n');
  });
  // (Self-tests leave the clipboard alone: it's the user's.)
  ipcMain.handle('report:copy', (_e, text: string) => { if (!o.quiet) clipboard.writeText(String(text)); });
  // Any text the user asked to copy (chapters, …). Self-tests keep what would have been copied instead.
  let lastCopied = '';
  ipcMain.handle('clipboard:write', (_e, text: string) => { lastCopied = String(text); if (!o.quiet) clipboard.writeText(lastCopied); });
  ipcMain.handle('clipboard:last', () => (o.quiet ? lastCopied : ''));
  ipcMain.handle('report:reveal', () => {
    if (o.quiet) return; if (existsSync(file)) shell.showItemInFolder(file); else void shell.openPath(o.dir); });
}

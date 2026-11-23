// 10-bit and ProRes export: the window hands finished 10-bit pictures to a bundled ffmpeg
// (LGPL build), which encodes them with the computer's own hardware encoder.

import { app, ipcMain } from 'electron';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DeepKind = 'hevc10' | 'prores';
interface StartOpts { path: string; width: number; height: number; fps: number; kind: DeepKind; bitrate: number; layout: 'p010le' | 'p210le'; audio?: Uint8Array }
interface Job { p: ChildProcessByStdio<Writable, null, Readable>; out: string; wav?: string; log: string[]; done: Promise<number> }

const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
export const ffmpegPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg', exe) : path.join(app.getAppPath(), 'resources', 'ffmpeg', exe));

/** Hardware encoders to try, best first, for each platform. */
const HEVC10: Record<string, string[]> = { darwin: ['hevc_videotoolbox'], win32: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv'], linux: ['hevc_nvenc', 'hevc_vaapi'] };
const PRORES: Record<string, string[]> = { darwin: ['prores_videotoolbox', 'prores_ks'], win32: ['prores_ks'], linux: ['prores_ks'] };

const run = (args: string[], input?: Buffer) => new Promise<{ code: number; err: string }>((resolve) => {
  const p = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += String(d); });
  p.on('error', (e) => resolve({ code: -1, err: String(e) }));
  p.on('close', (code) => resolve({ code: code ?? -1, err }));
  p.stdin.on('error', () => {});
  p.stdin.end(input);
});

const encArgs = (enc: string, kind: DeepKind) =>
  kind === 'prores'
    ? ['-c:v', enc, '-profile:v', enc === 'prores_ks' ? '3' : 'hq', ...(enc === 'prores_ks' ? ['-pix_fmt', 'yuv422p10le'] : []), '-vendor', 'apl0']
    : ['-c:v', enc, '-profile:v', 'main10', '-tag:v', 'hvc1', ...(enc === 'hevc_videotoolbox' ? [] : ['-pix_fmt', 'p010le'])];

let found: Promise<Partial<Record<DeepKind, string>>> | null = null;
/** Which of the deep formats this computer can write, and with which encoder (tried once, on a tiny picture). */
export function deepEncoders() {
  found ??= (async () => {
    if (!existsSync(ffmpegPath())) return {};
    const out: Partial<Record<DeepKind, string>> = {};
    for (const [kind, list, layout] of [['hevc10', HEVC10, 'p010le'], ['prores', PRORES, 'p210le']] as const) {
      for (const enc of list[process.platform] ?? []) {
        const w = 256, h = 256, frame = Buffer.alloc(layout === 'p010le' ? w * h * 3 : w * h * 4);
        const r = await run(['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', layout, '-s', `${w}x${h}`, '-r', '30', '-i', 'pipe:0', ...encArgs(enc, kind), '-frames:v', '1', '-f', 'null', '-'], frame);
        if (r.code === 0) { out[kind] = enc; break; }
      }
    }
    return out;
  })();
  return found;
}

export function setupEncoder(o: { canWrite: (p: string) => boolean }) {
  const jobs = new Map<number, Job>();
  let next = 1;
  ipcMain.handle('encoder:available', () => deepEncoders());
  ipcMain.handle('encoder:start', async (_e, s: StartOpts) => {
    if (!o.canWrite(s.path)) throw new Error('File access denied');
    const enc = (await deepEncoders())[s.kind];
    if (!enc) throw new Error(s.kind === 'prores' ? 'ProRes export isn’t available on this computer' : '10-bit HEVC export isn’t available on this computer (it needs a graphics chip that can encode it)');
    let wav: string | undefined;
    if (s.audio?.length) { wav = path.join(os.tmpdir(), `ace-export-${process.pid}-${next}.wav`); await writeFile(wav, s.audio); }
    const tags = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', s.layout, '-s', `${s.width}x${s.height}`, '-r', String(s.fps), ...tags, '-i', 'pipe:0',
      ...(wav ? ['-i', wav] : []),
      '-map', '0:v', ...(wav ? ['-map', '1:a'] : []),
      ...encArgs(enc, s.kind), ...(s.kind === 'hevc10' ? ['-b:v', String(Math.round(s.bitrate)), '-g', String(Math.round(s.fps * 2))] : []),
      ...tags,
      ...(wav ? (s.kind === 'prores' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '256k']) : []),
      '-movflags', '+faststart', s.path,
    ];
    const p = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const log: string[] = [];
    p.stderr.on('data', (d) => { log.push(String(d)); if (log.length > 40) log.shift(); });
    p.stdin.on('error', () => {});
    const done = new Promise<number>((resolve) => { p.on('close', (c) => resolve(c ?? -1)); p.on('error', () => resolve(-1)); });
    const id = next++;
    jobs.set(id, { p, out: s.path, wav, log, done });
    return id;
  });
  ipcMain.handle('encoder:frame', async (_e, id: number, data: Uint8Array) => {
    const j = jobs.get(id);
    if (!j) throw new Error('No such export');
    if (j.p.exitCode !== null) throw new Error(`The encoder stopped: ${j.log.join('').trim().slice(-400)}`);
    // Wait while the encoder catches up, so pictures don't pile up in memory.
    if (!j.p.stdin.write(data)) await new Promise<void>((r) => { j.p.stdin.once('drain', r); j.p.once('close', () => r()); });
  });
  ipcMain.handle('encoder:finish', async (_e, id: number) => {
    const j = jobs.get(id);
    if (!j) throw new Error('No such export');
    j.p.stdin.end();
    const code = await j.done;
    jobs.delete(id);
    if (j.wav) await rm(j.wav, { force: true });
    if (code !== 0) throw new Error(`The encoder failed: ${j.log.join('').trim().slice(-400)}`);
  });
  ipcMain.handle('encoder:cancel', async (_e, id: number) => {
    const j = jobs.get(id);
    if (!j) return;
    j.p.kill('SIGKILL');
    await j.done;
    jobs.delete(id);
    if (j.wav) await rm(j.wav, { force: true });
    await rm(j.out, { force: true });
  });
  app.on('will-quit', () => { for (const j of jobs.values()) j.p.kill('SIGKILL'); });
}

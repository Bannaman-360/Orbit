// Improved copies of clips (AI): the part of a clip in use, made once with in-between frames
// where it plays slowly (RIFE) and/or bigger and sharper (Real-ESRGAN), kept on this computer.
// The copy has the recording's own timeline (the same media times, more of them where smoothed),
// so the player and the export just read it instead of the original.

import { CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_VERY_HIGH, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { find360Pair, openMedia, TrackDecoder, type VideoTrackInfo } from '@ace/engine';
import { equirectLayout, goproMaxLayout, ReframeRenderer } from '@ace/media360';
import { enhancedSize, enhanceKey, enhanceOn, framesPerGap, type TimelineClip } from '@ace/project';
import { ace, ipcReader } from './api';
import { ensureModel, modelFile } from './aiModels';
import { copyInput, specialColor } from './color';
import { getMedia, type Media } from './media';
import type { PreviewSource } from './proxy';
import type { EnhanceIn, EnhanceOut } from './enhanceWorker';

export const RIFE = 'rife-4.25-lite', ESRGAN = 'realesr-general-x4v3';
const KEYFRAME_S = 0.5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keyOf = (c: TimelineClip) => `${c.mediaPath}|${enhanceKey(c)}`;
/** Ready copies, by key. */
const opened = new Map<string, PreviewSource>();
/** Build progress (0–1) by key, and why a build failed. */
export const copyProgress = new Map<string, number>();
export const copyErrors = new Map<string, string>();
const listeners = new Set<() => void>();
export const onCopyChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const notify = () => listeners.forEach((f) => f());

/** The copy to play for a clip, when it is ready (null: play the original). */
export function aiSource(c: TimelineClip): PreviewSource | null {
  return enhanceOn(c.enhance) ? opened.get(keyOf(c)) ?? null : null;
}
/** What a clip's copy is doing: ready, being made (with progress), waiting, failed, or none wanted. */
export function copyState(c: TimelineClip): { state: 'none' } | { state: 'ready' } | { state: 'making'; fraction: number } | { state: 'waiting' } | { state: 'failed'; error: string } {
  if (!enhanceOn(c.enhance)) return { state: 'none' };
  const k = keyOf(c);
  if (opened.has(k)) return { state: 'ready' };
  if (copyProgress.has(k)) return { state: 'making', fraction: copyProgress.get(k)! };
  if (copyErrors.has(k)) return { state: 'failed', error: copyErrors.get(k)! };
  return { state: 'waiting' };
}

/** The recorded frames the copy is made from: the clip's part, and one frame either side. */
function sourceTimes(c: TimelineClip, m: Media): number[] {
  const all = m.tracks[0]!.samples.map((s) => s.timestamp).sort((a, b) => a - b);
  let i0 = all.findIndex((t) => t >= c.inUs - 1);
  if (i0 < 0) i0 = all.length - 1;
  let i1 = all.findIndex((t) => t >= c.outUs);
  if (i1 < 0) i1 = all.length - 1;
  return all.slice(Math.max(0, i0 - 1), Math.min(all.length, i1 + 2));
}

async function openCopy(c: TimelineClip, m: Media, file: string): Promise<PreviewSource> {
  const { size } = await ace.stat(file);
  const reader = ipcReader(file, size);
  const info = await openMedia(reader);
  const pair = find360Pair(info);
  const raw = pair ?? info.videoTracks.slice(0, 1);
  if (!raw.length) throw new Error('The copy has no video');
  // Written from 0: back onto the recording's own times.
  const base = sourceTimes(c, m)[0] ?? 0;
  const tracks: VideoTrackInfo[] = raw.map((t) => {
    const shift = base - (t.samples.length ? Math.min(...t.samples.map((s) => s.timestamp)) : 0);
    return { ...t, samples: t.samples.map((s) => ({ ...s, timestamp: s.timestamp + shift })) };
  });
  const t0 = tracks[0]!;
  return { level: 1, reader, tracks, layout: pair ? goproMaxLayout(t0.width, t0.height) : m.layout?.equirect ? equirectLayout(t0.width, t0.height) : null };
}

// --- The models, in a worker ---------------------------------------------------------------------
let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (m: EnhanceOut) => void; fail: (e: Error) => void }>();
function ask(m: EnhanceIn, transfer: Transferable[] = []): Promise<EnhanceOut> {
  if (!worker) {
    worker = new Worker(new URL('./enhanceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<EnhanceOut>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.kind === 'error') w?.fail(new Error(e.data.message)); else w?.ok(e.data);
    };
    worker.onerror = (e) => { for (const w of waiting.values()) w.fail(new Error(e.message || 'The picture tools stopped.')); waiting.clear(); worker = null; };
  }
  return new Promise((ok, fail) => { waiting.set(m.id, { ok, fail }); worker!.postMessage(m, transfer); });
}
/** How the models run, for checking ('webgpu' on the graphics chip, 'wasm' if not). */
export let enhanceEp = '';
const loaded = { rife: false, esrgan: false };
async function loadModels(smooth: boolean, upscale: boolean) {
  if (smooth && !loaded.rife) { await ensureModel(RIFE); const b = await modelFile(RIFE, 'rife_v425lite.onnx'); const r = await ask({ kind: 'load', id: nextId++, rife: b.slice().buffer }); enhanceEp = r.kind === 'ready' ? r.ep : ''; loaded.rife = true; }
  if (upscale && !loaded.esrgan) { await ensureModel(ESRGAN); const b = await modelFile(ESRGAN, 'realesr-general-x4v3.onnx'); const r = await ask({ kind: 'load', id: nextId++, esrgan: b.slice().buffer }); enhanceEp = r.kind === 'ready' ? r.ep : ''; loaded.esrgan = true; }
}
export const between = async (a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, ts: number[]) => {
  const r = await ask({ kind: 'between', id: nextId++, a, b, w, h, ts });
  return r.kind === 'frames' ? r.frames : [];
};
export const upscale4 = async (img: Uint8ClampedArray, w: number, h: number) => {
  const r = await ask({ kind: 'upscale', id: nextId++, img, w, h }, [img.buffer]);
  if (r.kind !== 'image') throw new Error('Upscaling gave nothing back');
  return r;
};

/** For checking: loads RIFE another way (layout, graph optimisation, CPU). */
export async function rifeVariant(variant: { layout?: 'NCHW' | 'NHWC'; opt?: 'disabled' | 'basic' | 'extended' | 'all'; ep?: 'webgpu' | 'wasm' }) {
  await ensureModel(RIFE);
  const b = await modelFile(RIFE, 'rife_v425lite.onnx');
  const r = await ask({ kind: 'load', id: nextId++, rife: b.slice().buffer, variant });
  enhanceEp = r.kind === 'ready' ? r.ep : '';
  loaded.rife = true;
}

/** Stats of the last copy made, for checking. */
export const lastBuild = { frames: 0, made: 0, ms: 0, width: 0, height: 0 };

/** Makes the copy of a clip into `file`. `onProgress`: 0–1. */
async function build(c: TimelineClip, m: Media, file: string, onProgress: (f: number) => void, signal: AbortSignal) {
  const e = c.enhance!;
  const smooth = !!e.smooth, up = !!e.upscale && !m.is360;
  onProgress(0);
  await loadModels(smooth, up);
  const t0 = performance.now();
  const times = sourceTimes(c, m);
  const gaps = smooth ? framesPerGap(c, times) : times.slice(0, -1).map(() => 1);
  const sw = m.tracks[0]!.width, sh = m.tracks[0]!.height;
  const size = up ? enhancedSize(sw, sh, e) : { w: sw, h: sh, scale: 1 };
  const codec = (await canEncodeVideo('avc', { width: size.w, height: size.h })) ? 'avc' : (await canEncodeVideo('hevc', { width: size.w, height: size.h })) ? 'hevc' : 'vp9';
  const part = `${file}.part`;
  await ace.createFile(part);
  const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => ace.writeAt(part, chunk.position, chunk.data) });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable) });
  // One picture per stream (two for a .360): read at its recorded size, written at the copy's.
  const readers = m.tracks.map(() => new OffscreenCanvas(sw, sh));
  const rctx = readers.map((cv) => cv.getContext('2d', { willReadFrequently: true })!);
  const writers = m.tracks.map(() => new OffscreenCanvas(size.w, size.h));
  const wctx = writers.map((cv) => { const x = cv.getContext('2d')!; x.imageSmoothingQuality = 'high'; return x; });
  const big = up ? new OffscreenCanvas(sw * 4, sh * 4) : null, bctx = big?.getContext('2d') ?? null;
  // Log, HLG and wide-colour files keep their recorded values (as preview copies do).
  const special = specialColor(m.color);
  const renderers = special ? await Promise.all(m.tracks.map(() => ReframeRenderer.create(new OffscreenCanvas(sw, sh)))) : null;
  const sources = writers.map((cv) => new CanvasSource(cv, { codec, bitrate: QUALITY_VERY_HIGH, keyFrameInterval: KEYFRAME_S }));
  for (const s of sources) output.addVideoTrack(s, { frameRate: m.fps * Math.max(...gaps) });
  await output.start();
  const decs = m.tracks.map((t) => new TrackDecoder(m.reader, t));
  decs.forEach((d) => { d.maxAhead = 6; d.seek(times[0]!); });
  const base = times[0]!;
  const total = gaps.reduce((a, b) => a + b, 0) + 1;
  let made = 0;
  /** The recorded picture at a time, as RGBA bytes, per stream. */
  const grab = async (t: number): Promise<Uint8ClampedArray[]> => {
    let frames: (VideoFrame | null)[] = [];
    for (let tries = 0; ; tries++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      for (const d of decs) void d.pump();
      frames = decs.map((d) => d.frameAt(t));
      if (frames.every(Boolean)) break;
      if (tries > 3000) throw new Error(`Decoding stalled at ${(t / 1e6).toFixed(2)} s`);
      await sleep(2);
    }
    return frames.map((f, k) => {
      if (renderers) {
        const r = renderers[k]!;
        r.resetHistory();
        r.pushFrame({ frames: [f!], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true, input: copyInput(m) });
        r.present({ blendFrames: 1, bypass: true });
        rctx[k]!.drawImage(r.canvas as OffscreenCanvas, 0, 0);
      } else rctx[k]!.drawImage(f!, 0, 0, sw, sh);
      return rctx[k]!.getImageData(0, 0, sw, sh).data;
    });
  };
  /** Writes one picture per stream at media time t, shown for `dur`. */
  const write = async (pics: Uint8ClampedArray[], t: number, dur: number) => {
    for (let k = 0; k < pics.length; k++) {
      if (up) {
        const r = await upscale4(new Uint8ClampedArray(pics[k]!), sw, sh);
        bctx!.putImageData(new ImageData(r.img as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
        wctx[k]!.drawImage(big!, 0, 0, size.w, size.h);
      } else wctx[k]!.putImageData(new ImageData(pics[k]! as Uint8ClampedArray<ArrayBuffer>, sw, sh), 0, 0);
      await sources[k]!.add((t - base) / 1e6, dur / 1e6);
    }
    made++;
    onProgress(Math.min(0.999, made / total));
  };
  try {
    let cur = await grab(times[0]!);
    for (let i = 0; i < times.length; i++) {
      const t = times[i]!, next = times[i + 1];
      if (next === undefined) { await write(cur, t, 1e6 / m.fps); break; }
      const n = gaps[i]!, step = (next - t) / n;
      await write(cur, t, step);
      const after = await grab(next);
      if (n > 1) {
        const ts = Array.from({ length: n - 1 }, (_, j) => (j + 1) / n);
        const mids = await Promise.all(cur.map((a, k) => between(a, after[k]!, sw, sh, ts)));
        for (let j = 0; j < n - 1; j++) await write(mids.map((x) => x[j]!), t + step * (j + 1), step);
      }
      cur = after;
    }
    await output.finalize();
    await ace.closeFile(part);
    await ace.aiCopyFinish(file);
    Object.assign(lastBuild, { frames: times.length, made, ms: performance.now() - t0, width: size.w, height: size.h });
  } catch (err) {
    await output.cancel().catch(() => {});
    await ace.closeFile(part).catch(() => {});
    await ace.aiCopyDiscard(file).catch(() => {});
    throw err;
  } finally {
    decs.forEach((d) => d.close());
    renderers?.forEach((r) => r.destroy());
  }
}

const tagOf = (c: TimelineClip, m: Media) => `${enhanceKey(c)}|${m.parts.length > 1 ? `${m.parts.length}|${m.size}` : ''}|${specialColor(m.color) ? 'recorded1' : ''}|v3`;

/** The copy of a clip, made first if needed (the export waits for it). */
export async function copyFor(c: TimelineClip, onProgress: (f: number) => void = () => {}, signal: AbortSignal = new AbortController().signal): Promise<PreviewSource> {
  const k = keyOf(c);
  const have = opened.get(k);
  if (have) return have;
  const m = await getMedia(c.mediaPath);
  const { path: file, exists } = await ace.aiCopyPath(m.path, tagOf(c, m));
  if (!exists) {
    copyProgress.set(k, 0);
    notify();
    try {
      await build(c, m, file, (f) => { copyProgress.set(k, f); onProgress(f); notify(); }, signal);
      copyErrors.delete(k);
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && (e as Error).message !== 'Cancelled') copyErrors.set(k, (e as Error).message);
      throw e;
    } finally {
      copyProgress.delete(k);
      notify();
    }
  }
  const src = await openCopy(c, m, file);
  opened.set(k, src);
  notify();
  return src;
}

// --- Background: one copy at a time, for the clips that want one ---------------------------------
const queue: TimelineClip[] = [];
let running: { key: string; abort: AbortController } | null = null;
async function runQueue() {
  if (running) return;
  for (;;) {
    const c = queue.shift();
    if (!c) break;
    const k = keyOf(c);
    if (opened.has(k) || copyErrors.has(k)) continue;
    running = { key: k, abort: new AbortController() };
    try { await copyFor(c, () => {}, running.abort.signal); } catch { /* kept in copyErrors */ }
    running = null;
  }
}

/** Makes sure the copies these clips want exist or are being made; stops ones no longer wanted. */
export function ensureCopies(clips: TimelineClip[]) {
  const want = clips.filter((c) => enhanceOn(c.enhance));
  const keys = new Set(want.map(keyOf));
  if (running && !keys.has(running.key)) running.abort.abort();
  queue.length = 0;
  for (const c of want) if (!opened.has(keyOf(c)) && running?.key !== keyOf(c)) queue.push(c);
  void runQueue();
}
/** Tries a failed copy again. */
export function retryCopy(c: TimelineClip) { copyErrors.delete(keyOf(c)); notify(); ensureCopies([c]); }
/** Waits for the background copies (self-test). */
export async function copiesIdle() { while (running || queue.length) await sleep(100); }
/** After the copies were deleted. */
export function forgetCopies() { opened.clear(); copyErrors.clear(); running?.abort.abort(); queue.length = 0; notify(); }

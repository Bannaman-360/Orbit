// Preview proxies: smaller copies of each clip (½, ¼ or ⅛ size) with a keyframe every
// quarter second, so playback and scrubbing stay smooth on slower machines. Export always
// uses the original files. Proxies are built in the background, one at a time.

import { CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_MEDIUM, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { find360Pair, openMedia, TrackDecoder, type ByteReader, type VideoTrackInfo } from '@ace/engine';
import { equirectLayout, goproMaxLayout, ReframeRenderer, type EacLayout } from '@ace/media360';
import { ace, ipcReader } from './api';
import { copyInput, specialColor } from './color';
import type { Media } from './media';

export type PreviewLevel = 1 | 2 | 4 | 8;

export const PREVIEW_LEVELS: [PreviewLevel, string, string][] = [
  [1, 'Full', 'Original files (best quality, needs a fast machine)'],
  [2, '½', 'Half resolution'],
  [4, '¼', 'Quarter resolution (good for most laptops)'],
  [8, '⅛', 'Eighth resolution (slowest machines)'],
];

/** What the preview decodes: the original file or one of its proxies. */
export interface PreviewSource {
  level: PreviewLevel;
  reader: ByteReader;
  tracks: VideoTrackInfo[];
  layout: EacLayout | null;
}

const originals = new WeakMap<Media, PreviewSource>();
/** The original file as a preview source (one object per media, so it compares equal). */
export function originalSource(m: Media): PreviewSource {
  let s = originals.get(m);
  if (!s) originals.set(m, (s = { level: 1, reader: m.reader, tracks: m.tracks, layout: m.layout }));
  return s;
}

const KEYFRAME_S = 0.25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opened proxies, by media path and level. */
const opened = new Map<string, PreviewSource>();
const key = (path: string, level: PreviewLevel) => `${level}|${path}`;

/** Build progress (0–1) by media path, for the level being built. */
export const proxyProgress = new Map<string, number>();
const listeners = new Set<() => void>();
export const onProxyChange = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
const notify = () => listeners.forEach((f) => f());

let level: PreviewLevel = 1;
export const previewLevel = () => level;

/** The source to decode for preview: the proxy at the chosen level if it's ready, else the original. */
export function previewSource(m: Media): PreviewSource {
  return (level > 1 && opened.get(key(m.path, level))) || originalSource(m);
}

export const hasProxy = (m: Media, l: PreviewLevel) => l === 1 || opened.has(key(m.path, l));

async function openProxy(m: Media, file: string, l: PreviewLevel): Promise<PreviewSource> {
  const { size } = await ace.stat(file);
  const reader = ipcReader(file, size);
  const info = await openMedia(reader);
  const pair = find360Pair(info);
  const tracks = pair ?? info.videoTracks.slice(0, 1);
  if (!tracks.length) throw new Error('Proxy has no video');
  const src: PreviewSource = { level: l, reader, tracks, layout: pair ? goproMaxLayout(pair[0].width, pair[0].height) : m.layout?.equirect ? equirectLayout(tracks[0]!.width, tracks[0]!.height) : null };
  opened.set(key(m.path, l), src);
  return src;
}

/** Encodes a proxy of `m` at 1/l size into `file`. */
async function build(m: Media, l: PreviewLevel, file: string, signal: AbortSignal) {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const W = even(m.tracks[0]!.width / l), H = even(m.tracks[0]!.height / l);
  const codec = (await canEncodeVideo('avc', { width: W, height: H })) ? 'avc' : 'vp9';
  const part = `${file}.part`;
  await ace.createFile(part);
  const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => ace.writeAt(part, chunk.position, chunk.data) });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable) });
  const canvases = m.tracks.map(() => new OffscreenCanvas(W, H));
  // Log, HLG and wide-colour files: keep the recorded values (drawing them would convert them).
  const special = specialColor(m.color);
  const renderers = special ? await Promise.all(canvases.map((c) => ReframeRenderer.create(c))) : null;
  const ctxs = special ? [] : canvases.map((c) => c.getContext('2d')!);
  const sources = canvases.map((c) => new CanvasSource(c, { codec, bitrate: QUALITY_MEDIUM, keyFrameInterval: KEYFRAME_S }));
  for (const s of sources) output.addVideoTrack(s, { frameRate: m.fps });
  await output.start();
  const decs = m.tracks.map((t) => new TrackDecoder(m.reader, t));
  const times = m.tracks[0]!.samples.map((s) => s.timestamp).sort((a, b) => a - b);
  const frameS = 1 / m.fps;
  decs.forEach((d) => { d.maxAhead = 6; d.seek(times[0] ?? 0); });
  try {
    for (let i = 0; i < times.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const t = times[i]!;
      let frames: (VideoFrame | null)[] = [];
      for (let tries = 0; ; tries++) {
        for (const d of decs) void d.pump();
        frames = decs.map((d) => d.frameAt(t));
        if (frames.every(Boolean)) break;
        if (tries > 3000) throw new Error(`Decoding stalled at ${(t / 1e6).toFixed(2)}s`);
        await sleep(2);
      }
      for (let k = 0; k < frames.length; k++) {
        if (renderers) {
          renderers[k]!.resetHistory();
          renderers[k]!.pushFrame({ frames: [frames[k]!], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true, input: copyInput(m) });
          renderers[k]!.present({ blendFrames: 1, bypass: true });
        } else ctxs[k]!.drawImage(frames[k]!, 0, 0, W, H);
        await sources[k]!.add(t / 1e6, frameS);
      }
      if (i % 10 === 0) {
        proxyProgress.set(m.path, i / times.length);
        notify();
      }
    }
    await output.finalize();
    await ace.closeFile(part);
    await ace.proxyFinish(file);
  } catch (e) {
    await output.cancel().catch(() => {});
    await ace.closeFile(part).catch(() => {});
    await ace.proxyDiscard(file).catch(() => {});
    throw e;
  } finally {
    decs.forEach((d) => d.close());
    renderers?.forEach((r) => r.destroy());
  }
}

// --- Queue: one proxy at a time, for the current level ---------------------------------------
const queue: Media[] = [];
let running: AbortController | null = null;
let runningPath: string | null = null;
export const proxyErrors = new Map<string, string>();

async function runQueue() {
  if (running) return;
  for (;;) {
    const m = queue.shift();
    if (!m) break;
    const l = level;
    if (l === 1 || opened.has(key(m.path, l))) continue;
    running = new AbortController();
    runningPath = m.path;
    try {
      const { path: file, exists } = await ace.proxyPath(m.path, l, `${m.parts.length > 1 ? `|${m.parts.length}|${m.size}` : ''}${specialColor(m.color) ? '|recorded1' : ''}`);
      if (!exists) {
        proxyProgress.set(m.path, 0);
        notify();
        await build(m, l, file, running.signal);
      }
      await openProxy(m, file, l);
      proxyErrors.delete(m.path);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') proxyErrors.set(m.path, String(e));
    } finally {
      proxyProgress.delete(m.path);
      running = null;
      runningPath = null;
      notify();
    }
  }
}

/** Makes sure proxies at the current level exist (or are being built) for these media. */
export function ensureProxies(media: Media[]) {
  if (level === 1) return;
  for (const m of media) {
    if (opened.has(key(m.path, level)) || queue.includes(m) || runningPath === m.path) continue;
    queue.push(m);
  }
  void runQueue();
}

/** Switches the preview level; proxies for it are built as needed. */
export function setPreviewLevel(l: PreviewLevel, media: Media[]) {
  if (l === level) return;
  level = l;
  queue.length = 0;
  // A build for another level is no longer wanted.
  running?.abort();
  notify();
  ensureProxies(media);
}

/** Waits for the proxy queue to finish (self-test). */
export async function proxiesIdle() {
  while (running || queue.length) await sleep(100);
}

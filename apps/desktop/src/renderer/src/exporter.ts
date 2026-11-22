// Exports the edit to an MP4: every output frame composited from the clips on screen
// (two during a transition) plus overlays; every source frame is reframed so motion blur
// matches the preview; encoded in hardware, with the mixed audio.

import { AudioBufferSource, CanvasSource, canEncodeAudio, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { TrackDecoder } from '@ace/engine';
import { parseCube, ReframeRenderer } from '@ace/media360';
import { framingAspect, layersAt, timelineDuration, type Timeline, type TransitionLook } from '@ace/project';
import { ace } from './api';
import { mixTimeline } from './audioEngine';
import { framesAt } from './calib';
import { getMedia } from './media';
import { clipLookAt, presentLook, pushClipFrame } from './frameRender';
import { compositeLayers, drawOverlays, transitionLook } from './overlayRender';
import type { LayerFrame } from './timelinePlayer';

export type Resolution = 720 | 1080 | 1440 | 2160;
export type Quality = 'standard' | 'high' | 'max';

export interface ExportOptions {
  path: string;
  resolution: Resolution;
  fps: number;
  codec: 'avc' | 'hevc';
  quality: Quality;
}

export interface ExportProgress {
  fraction: number;
  stage: string;
  fps?: number;
}

/** Output pixel size for a framing and resolution (the short side = resolution). */
export function outputSize(framing: string, res: Resolution): { width: number; height: number } {
  const a = framingAspect(framing);
  const even = (v: number) => Math.round(v / 2) * 2;
  return a >= 1 ? { width: even(res * a), height: res } : { width: res, height: even(res / a) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadLut(r: ReframeRenderer, path: string | null) {
  if (!path) return r.setLut(null);
  const text = new TextDecoder().decode(await ace.readAll(path));
  r.setLut(parseCube(text));
}

/** One clip being decoded for export: its decoders and which source frames were pushed. */
interface ExportSlot {
  clipId: string;
  decoders: TrackDecoder[];
  times: number[];
  /** Index into `times` of the next source frame to push. */
  next: number;
  pushedAny: boolean;
}

/**
 * Two reframe renderers (one per clip on screen; clips alternate between them so a clip keeps
 * its motion-blur history through a transition) plus a 2D canvas that composites them and
 * draws overlays. Used for export and frame grabs.
 */
class Compositor {
  readonly out: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  private constructor(readonly renderers: [ReframeRenderer, ReframeRenderer], readonly width: number, readonly height: number) {
    this.out = new OffscreenCanvas(width, height);
    this.ctx = this.out.getContext('2d')!;
  }
  static async create(width: number, height: number, lutPath: string | null) {
    const rs = await Promise.all([0, 1].map(() => ReframeRenderer.create(new OffscreenCanvas(width, height))));
    for (const r of rs) await loadLut(r, lutPath);
    return new Compositor(rs as [ReframeRenderer, ReframeRenderer], width, height);
  }
  rendererFor(clipIndex: number) {
    return this.renderers[clipIndex % 2]!;
  }
  compose(tl: Timeline, T: number, aIndex: number, bIndex: number | null, look: TransitionLook | null) {
    const a = this.rendererFor(aIndex).canvas as OffscreenCanvas;
    const b = bIndex === null ? null : (this.rendererFor(bIndex).canvas as OffscreenCanvas);
    compositeLayers(this.ctx, this.width, this.height, a, b, look);
    drawOverlays(this.ctx, this.width, this.height, tl, T);
  }
  destroy() {
    for (const r of this.renderers) r.destroy();
  }
}

export async function exportTimeline(tl: Timeline, opts: ExportOptions, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<void> {
  const { width, height } = outputSize(tl.framing, opts.resolution);
  const total = timelineDuration(tl);
  if (!tl.clips.length || total <= 0) throw new Error('The timeline is empty');

  let codec = opts.codec;
  if (!(await canEncodeVideo(codec, { width, height }))) codec = 'avc';
  if (!(await canEncodeVideo(codec, { width, height }))) throw new Error(`This computer cannot encode ${width}×${height} video`);

  const comp = await Compositor.create(width, height, tl.lutPath);

  onProgress({ fraction: 0, stage: 'Mixing audio' });
  const mix = await mixTimeline(tl, total);

  await ace.createFile(opts.path);
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => ace.writeAt(opts.path, chunk.position, chunk.data),
  });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable) });
  const bitrate = opts.quality === 'max' ? QUALITY_VERY_HIGH : opts.quality === 'high' ? QUALITY_HIGH : QUALITY_MEDIUM;
  const video = new CanvasSource(comp.out, { codec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: opts.fps });
  let audio: AudioBufferSource | null = null;
  if (mix) {
    const ac = (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 })) ? 'aac' : 'opus';
    audio = new AudioBufferSource({ codec: ac, bitrate: QUALITY_HIGH });
    output.addAudioTrack(audio);
  }
  await output.start();

  const step = 1e6 / opts.fps;
  const slots = new Map<string, ExportSlot>();
  const t0 = performance.now();
  let written = 0;

  /** Pushes every source frame of a clip up to media time `upTo` (so motion blur sees them all). */
  const feed = async (index: number, upTo: number) => {
    const clip = tl.clips[index]!;
    const media = await getMedia(clip.mediaPath);
    let slot = slots.get(clip.id);
    if (!slot) {
      const times = media.tracks[0]!.samples.map((s) => s.timestamp).filter((t) => t >= clip.inUs - 1 && t < clip.outUs).sort((a, b) => a - b);
      const decoders = media.tracks.map((t) => new TrackDecoder(media.reader, t));
      decoders.forEach((d) => { d.maxAhead = 6; d.seek(times[0] ?? clip.inUs); });
      slot = { clipId: clip.id, decoders, times, next: 0, pushedAny: false };
      slots.set(clip.id, slot);
    }
    const r = comp.rendererFor(index);
    r.setLayout(media.layout);
    let look = null;
    // Always push at least one frame; then every source frame that has started by `upTo`.
    while (slot.next < slot.times.length && (!slot.pushedAny || slot.times[slot.next]! <= upTo)) {
      const mt = slot.times[slot.next]!;
      let frames: (VideoFrame | null)[] = [];
      for (let tries = 0; ; tries++) {
        if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
        for (const d of slot.decoders) void d.pump();
        frames = slot.decoders.map((d) => d.frameAt(mt));
        if (frames.every(Boolean)) break;
        if (tries > 2000) throw new Error(`Decoding stalled in ${media.name} at ${(mt / 1e6).toFixed(2)}s`);
        await sleep(2);
      }
      if (!slot.pushedAny) r.resetHistory();
      look = pushClipFrame(r, clip, media, mt, frames as VideoFrame[]);
      slot.pushedAny = true;
      slot.next++;
    }
    return look ?? clipLookAt(clip, slot.times[Math.max(0, slot.next - 1)] ?? clip.inUs);
  };

  try {
    for (let T = 0; T < total; T += step) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const L = layersAt(tl, T)!;
      const visible = L.b ? [L.a, L.b] : [L.a];
      for (const v of visible) {
        const look = await feed(v.index, v.mediaUs);
        presentLook(comp.rendererFor(v.index), look, { time: v.mediaUs });
      }
      // Clips that are finished free their decoders.
      for (const [id, s] of slots) {
        if (!visible.some((v) => v.clip.id === id)) {
          s.decoders.forEach((d) => d.close());
          slots.delete(id);
        }
      }
      comp.compose(tl, T, L.a.index, L.b ? L.b.index : null, L.b && L.transition ? transitionLook(L.transition.kind, L.progress) : null);
      await video.add(T / 1e6, step / 1e6);
      written++;
      onProgress({ fraction: Math.min(0.99, T / total), stage: `Rendering clip ${L.a.index + 1} of ${tl.clips.length}`, fps: written / ((performance.now() - t0) / 1000) });
    }
    if (mix && audio) {
      onProgress({ fraction: 0.99, stage: 'Encoding audio' });
      await audio.add(mix);
    }
    onProgress({ fraction: 0.995, stage: 'Finishing file' });
    await output.finalize();
    await ace.closeFile(opts.path);
    onProgress({ fraction: 1, stage: 'Done' });
  } catch (e) {
    await output.cancel().catch(() => {});
    await ace.closeFile(opts.path).catch(() => {});
    throw e;
  } finally {
    for (const s of slots.values()) s.decoders.forEach((d) => d.close());
    comp.destroy();
  }
}

/** Renders what is on screen at timeline time T at full output resolution and saves it as JPEG or PNG. */
export async function grabFrame(tl: Timeline, T: number, layers: LayerFrame[], path: string, res: Resolution = 2160): Promise<void> {
  const { width, height } = outputSize(tl.framing, res);
  // Keep our own hold on the frames right away: the preview may recycle them while we set up.
  const held = layers.map((l) => {
    if (l.level !== 1) return null;
    try { return l.frames.map((f) => f.clone()); } catch { return null; }
  });
  const times = layers.map((l) => l.frames[0]!.timestamp);
  const comp = await Compositor.create(width, height, tl.lutPath);
  try {
    for (const [i, l] of layers.entries()) {
      const r = comp.rendererFor(l.index);
      const ts = times[i]!;
      // The preview may be showing a low-res proxy: grab from the original file.
      const own = held[i];
      const orig = own ? { frames: own, close: () => {} } : await framesAt(l.media, ts);
      try {
        r.setLayout(l.media.layout);
        const look = pushClipFrame(r, l.clip, l.media, ts, orig.frames);
        presentLook(r, { ...look, motionBlur: 0 }, { time: ts });
        await r.idle();
      } finally {
        orig.close();
      }
    }
    const L = layersAt(tl, T);
    const b = layers[1];
    comp.compose(tl, T, layers[0]!.index, b ? b.index : null, b && L?.transition ? transitionLook(L.transition.kind, L.progress) : null);
    const png = path.toLowerCase().endsWith('.png');
    const blob = await comp.out.convertToBlob({ type: png ? 'image/png' : 'image/jpeg', quality: 0.95 });
    await ace.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  } finally {
    held.forEach((h) => h?.forEach((f) => f.close()));
    comp.destroy();
  }
}

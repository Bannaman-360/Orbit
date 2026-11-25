// Exports the edit to an MP4: every output frame composited from the clips on screen
// (the main row, two during a transition, and the tracks above it) plus overlays; every source frame is reframed so motion blur
// matches the preview; encoded in hardware, with the mixed audio.

import { AudioBufferSource, canEncodeAudio, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH, StreamTarget, VideoSample, VideoSampleSource, type StreamTargetChunk } from 'mediabunny';
import { TrackDecoder } from '@ace/engine';
import { parseCube, ReframeRenderer, sharedDevice } from '@ace/media360';
import { framingAspect, overlayState, stackAt, timelineDuration, type Look, type Timeline, type TimelineClip, type TransitionLook } from '@ace/project';
import { ace } from './api';
import { mixTimeline } from './audioEngine';
import { ordinaryGamma } from './color';
import { framesAt } from './calib';
import { getMedia } from './media';
import { clipLookAt, cropReady, presentLook, pushClipFrame } from './frameRender';
import { compositeLayers, drawOverlays, transitionLook, type CompLayer } from './overlayRender';
import type { LayerFrame } from './timelinePlayer';
import { YuvReader, type YuvLayout } from './deepExport';
import { applyMasks } from './masksRender';

/** Mask coverage pixels across in exports (the preview uses fewer). */
const MASK_WIDTH = 1024;

export type Resolution = 720 | 1080 | 1440 | 2160;
export type Quality = 'standard' | 'high' | 'max';

export interface ExportOptions {
  path: string;
  resolution: Resolution;
  fps: number;
  /** hevc10: 10-bit HEVC (Main10); prores: ProRes 422 HQ in a .mov (both through the bundled ffmpeg). */
  codec: 'avc' | 'hevc' | 'hevc10' | 'prores';
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

/** Most pictures on screen at once: the main row in a transition (2) plus tracks V2–V6. */
export const MAX_LAYERS = 7;

/** Time spent handing finished pictures to the encoder (ms), for measuring. */
export const exportCost = { readMs: 0, encodeMs: 0, frames: 0 };

/** One clip being decoded for export: its decoders and which source frames were pushed. */
interface ExportSlot {
  clipId: string;
  decoders: TrackDecoder[];
  times: number[];
  /** Index into `times` of the next source frame to push. */
  next: number;
  pushedAny: boolean;
}

/** One picture of a composite: the clip, its look at that moment, and its place in the stack. */
export interface ComposeLayer {
  clip: TimelineClip;
  look: Look;
  track: number;
  role?: 'out' | 'in';
}

/**
 * Reframe renderers, one per clip on screen (a clip keeps its renderer, and so its motion-blur
 * history, for its whole time on screen), plus a 2D canvas that composites them and draws
 * overlays. Renderers are made as needed and reused once their clip has left. Used for export
 * and frame grabs.
 */
class Compositor {
  readonly out: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  /** 10-bit export: pictures kept in half floats from start to finish, read back as this. */
  private deep: YuvLayout | null = null;
  private pool: { r: ReframeRenderer; clipId: string | null }[] = [];
  private constructor(readonly width: number, readonly height: number, deep: YuvLayout | null, private lutText: string | null) {
    this.out = new OffscreenCanvas(width, height);
    this.deep = deep;
    this.ctx = (deep ? this.out.getContext('2d', { colorType: 'float16' } as CanvasRenderingContext2DSettings) : this.out.getContext('2d'))!;
  }
  /** Exporting a video: the pictures hold the values a video file is read as (not as shown on screen). */
  private toFile: FileValues | null = null;
  static async create(width: number, height: number, lutPath: string | null, forVideo = false, deep: YuvLayout | null = null) {
    const lutText = lutPath ? new TextDecoder().decode(await ace.readAll(lutPath)) : null;
    const c = new Compositor(width, height, deep, lutText);
    if (forVideo && ordinaryGamma()) c.toFile = await FileValues.create(width, height, ordinaryGamma());
    // One is always needed.
    await c.rendererFor('');
    c.pool[0]!.clipId = null;
    return c;
  }
  /** The renderer that draws this clip (a free one, or a new one). */
  async rendererFor(clipId: string): Promise<ReframeRenderer> {
    const own = this.pool.find((p) => p.clipId === clipId);
    if (own) return own.r;
    const free = this.pool.find((p) => p.clipId === null);
    if (free) { free.clipId = clipId; free.r.resetHistory(); return free.r; }
    if (this.pool.length >= MAX_LAYERS) throw new Error('Too many pictures on screen at once');
    const r = await ReframeRenderer.create(new OffscreenCanvas(this.width, this.height), { deep: !!this.deep });
    r.setLut(this.lutText ? parseCube(this.lutText) : null);
    if (this.toFile) r.fileGamma = ordinaryGamma();
    this.pool.push({ r, clipId });
    return r;
  }
  /** Lets the renderers of clips that are no longer on screen draw others. */
  release(keep: Set<string>) {
    for (const p of this.pool) if (p.clipId !== null && !keep.has(p.clipId)) p.clipId = null;
  }
  /** How many renderers were made (for checking). */
  get renderers() { return this.pool.length; }
  async compose(tl: Timeline, T: number, layers: ComposeLayer[], look: TransitionLook | null) {
    const comp: CompLayer[] = [];
    for (const l of layers) comp.push({ src: (await this.rendererFor(l.clip.id)).canvas as OffscreenCanvas, xf: l.look.xf, role: l.role, track: l.track });
    compositeLayers(this.ctx, this.width, this.height, comp, look);
    if (!this.toFile) { drawOverlays(this.ctx, this.width, this.height, tl, T); return; }
    // Text and gauges are drawn as they should look on screen, then turned into file values too.
    if (!tl.overlays.some((o) => overlayState(o, T))) return;
    this.toFile.ctx.clearRect(0, 0, this.width, this.height);
    drawOverlays(this.toFile.ctx, this.width, this.height, tl, T);
    this.ctx.drawImage(this.toFile.convert(), 0, 0);
  }
  private deepReaders: YuvReader[] = [];
  /** As `sample`, for 10-bit export: the picture as 10-bit Y′CbCr bytes. */
  async sampleDeep(): Promise<() => Promise<Uint8Array>> {
    if (this.deepReaders.length < 3) this.deepReaders.push(await YuvReader.create(this.width, this.height, this.deep!));
    const reader = this.deepReaders[this.turn++ % this.deepReaders.length]!;
    const pending = reader.read(this.out);
    return () => pending;
  }
  private readers: PixelReader[] = [];
  private turn = 0;
  /**
   * Starts reading the finished picture back; the result is the picture, ready for the encoder
   * (values and label of an ordinary video). Up to three are under way at once, so the GPU
   * carries on drawing the next ones meanwhile.
   */
  async sample(t: number, d: number): Promise<() => Promise<VideoSample>> {
    if (this.readers.length < 3) this.readers.push(await PixelReader.create(this.width, this.height));
    const reader = this.readers[this.turn++ % this.readers.length]!;
    const pending = reader.read(this.out);
    return async () => new VideoSample(await pending, { format: 'RGBX', codedWidth: this.width, codedHeight: this.height, timestamp: t, duration: d, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } });
  }
  destroy() {
    for (const p of this.pool) p.r.destroy();
    this.toFile?.destroy();
    this.readers.forEach((x) => x.destroy());
    this.deepReaders.forEach((x) => x.destroy());
  }
}

/** Reads a canvas's pixels through the GPU (much faster than getImageData for big pictures). */
class PixelReader {
  private constructor(private device: GPUDevice, private tex: GPUTexture, private buf: GPUBuffer, private w: number, private h: number, private bpr: number) {}
  static async create(w: number, h: number) {
    const device = await sharedDevice();
    const tex = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT });
    const bpr = Math.ceil((w * 4) / 256) * 256;
    return new PixelReader(device, tex, device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), w, h, bpr);
  }
  private busy: Promise<unknown> = Promise.resolve();
  async read(src: OffscreenCanvas): Promise<Uint8Array> {
    // (This one's last read must have been handed over first.)
    await this.busy;
    this.device.queue.copyExternalImageToTexture({ source: src }, { texture: this.tex }, [this.w, this.h]);
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.tex }, { buffer: this.buf, bytesPerRow: this.bpr }, [this.w, this.h]);
    this.device.queue.submit([enc.finish()]);
    const mapped = this.buf.mapAsync(GPUMapMode.READ);
    this.busy = mapped.catch(() => {});
    await mapped;
    const m = new Uint8Array(this.buf.getMappedRange());
    let px: Uint8Array;
    if (this.bpr === this.w * 4) px = m.slice();
    else { px = new Uint8Array(this.w * this.h * 4); for (let y = 0; y < this.h; y++) px.set(m.subarray(y * this.bpr, y * this.bpr + this.w * 4), y * this.w * 4); }
    this.buf.unmap();
    return px;
  }
  destroy() {
    this.tex.destroy();
    this.buf.destroy();
  }
}

/** Turns a picture drawn for the screen (sRGB, with transparency) into the values a video file holds. */
class FileValues {
  readonly ctx: OffscreenCanvasRenderingContext2D;
  private constructor(private device: GPUDevice, private src: OffscreenCanvas, private out: OffscreenCanvas, private gpu: GPUCanvasContext, private pipe: GPURenderPipeline, private tex: GPUTexture, private bind: GPUBindGroup) {
    this.ctx = src.getContext('2d')!;
  }
  static async create(w: number, h: number, gamma: number) {
    const device = await sharedDevice();
    const src = new OffscreenCanvas(w, h), out = new OffscreenCanvas(w, h);
    const gpu = out.getContext('webgpu') as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    gpu.configure({ device, format, alphaMode: 'premultiplied' });
    const m = device.createShaderModule({ code: `
      @group(0) @binding(0) var t : texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f { var p = array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.); }
      @fragment fn fs(@builtin(position) p : vec4f) -> @location(0) vec4f {
        let c = textureLoad(t, vec2u(p.xy), 0);
        let a = abs(c.rgb);
        let lin = select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));
        return vec4f(pow(lin, vec3f(1.0 / ${gamma.toFixed(5)})) * c.a, c.a);
      }` });
    const pipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format }] } });
    const tex = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }] });
    return new FileValues(device, src, out, gpu, pipe, tex, bind);
  }
  convert(): OffscreenCanvas {
    this.device.queue.copyExternalImageToTexture({ source: this.src }, { texture: this.tex, premultipliedAlpha: false }, [this.src.width, this.src.height]);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.gpu.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return this.out;
  }
  destroy() {
    this.tex.destroy();
    this.gpu.unconfigure();
  }
}

export async function exportTimeline(tl: Timeline, opts: ExportOptions, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<void> {
  const { width, height } = outputSize(tl.framing, opts.resolution);
  const total = timelineDuration(tl);
  if (!tl.clips.length || total <= 0) throw new Error('The timeline is empty');

  const deepKind = opts.codec === 'hevc10' || opts.codec === 'prores' ? opts.codec : null;
  let codec: 'avc' | 'hevc' = opts.codec === 'hevc' ? 'hevc' : 'avc';
  if (deepKind) {
    const can = await ace.encoderAvailable();
    if (!can[deepKind]) throw new Error(deepKind === 'prores' ? 'ProRes export isn’t available on this computer.' : '10-bit HEVC export isn’t available on this computer.');
  } else {
    if (!(await canEncodeVideo(codec, { width, height }))) codec = 'avc';
    if (!(await canEncodeVideo(codec, { width, height }))) throw new Error(`This computer cannot encode ${width}×${height} video`);
  }
  const layout: YuvLayout | null = deepKind === 'prores' ? 'p210le' : deepKind ? 'p010le' : null;

  const comp = await Compositor.create(width, height, tl.lutPath, true, layout);

  onProgress({ fraction: 0, stage: 'Analysing stabilization' });
  for (const c of [...tl.clips, ...tl.connected]) await cropReady(c, await getMedia(c.mediaPath), width / height);

  onProgress({ fraction: 0, stage: 'Mixing audio' });
  const mix = await mixTimeline(tl, total);

  if (deepKind) return exportDeep(tl, opts, deepKind, layout!, comp, mix, width, height, total, onProgress, signal);

  await ace.createFile(opts.path);
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => ace.writeAt(opts.path, chunk.position, chunk.data),
  });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable) });
  const bitrate = opts.quality === 'max' ? QUALITY_VERY_HIGH : opts.quality === 'high' ? QUALITY_HIGH : QUALITY_MEDIUM;
  // (Fed with the pictures' values and their label, so players that ignore colour labels show them right too.)
  const video = new VideoSampleSource({ codec, bitrate, keyFrameInterval: 2 });
  const inFlight: (() => Promise<VideoSample>)[] = [];
  const handOver = async () => { const s0 = await inFlight.shift()!(); await video.add(s0); s0.close(); };
  output.addVideoTrack(video, { frameRate: opts.fps });
  let audio: AudioBufferSource | null = null;
  if (mix) {
    const ac = (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 })) ? 'aac' : 'opus';
    audio = new AudioBufferSource({ codec: ac, bitrate: QUALITY_HIGH });
    output.addAudioTrack(audio);
  }
  await output.start();

  try {
    await renderFrames(tl, opts, comp, total, onProgress, signal, async (T, step) => {
      inFlight.push(await comp.sample(T / 1e6, step / 1e6));
      if (inFlight.length > 2) await handOver();
    });
    while (inFlight.length) await handOver();
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
    comp.destroy();
  }
}

/** 10-bit HEVC or ProRes: pictures go to the bundled ffmpeg, which uses the hardware encoder. */
async function exportDeep(tl: Timeline, opts: ExportOptions, kind: 'hevc10' | 'prores', layout: YuvLayout, comp: Compositor, mix: AudioBuffer | null, width: number, height: number, total: number, onProgress: (p: ExportProgress) => void, signal: AbortSignal) {
  // About as many bits per picture element as the 8-bit HEVC export, a little more for 10 bits.
  const bpp = opts.quality === 'max' ? 0.2 : opts.quality === 'high' ? 0.13 : 0.08;
  const id = await ace.encoderStart({ path: opts.path, width, height, fps: opts.fps, kind, layout, bitrate: width * height * opts.fps * bpp, audio: mix ? wavOf(mix) : undefined });
  const inFlight: Promise<Uint8Array>[] = [];
  const handOver = async () => { const px = await inFlight.shift()!; await ace.encoderFrame(id, px); };
  try {
    await renderFrames(tl, opts, comp, total, onProgress, signal, async () => {
      inFlight.push((await comp.sampleDeep())());
      if (inFlight.length > 2) await handOver();
    });
    while (inFlight.length) await handOver();
    onProgress({ fraction: 0.995, stage: 'Finishing file' });
    await ace.encoderFinish(id);
    onProgress({ fraction: 1, stage: 'Done' });
  } catch (e) {
    await ace.encoderCancel(id).catch(() => {});
    throw e;
  } finally {
    comp.destroy();
  }
}

/** A mixed sound as a WAV file (32-bit float, the mix's own rate). */
function wavOf(b: AudioBuffer): Uint8Array {
  const ch = b.numberOfChannels, n = b.length, bytes = n * ch * 4;
  const out = new ArrayBuffer(44 + bytes), v = new DataView(out);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, ch, true); v.setUint32(24, b.sampleRate, true);
  v.setUint32(28, b.sampleRate * ch * 4, true); v.setUint16(32, ch * 4, true); v.setUint16(34, 32, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  const f = new Float32Array(out, 44), chans = Array.from({ length: ch }, (_, c) => b.getChannelData(c));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) f[i * ch + c] = chans[c]![i]!;
  return new Uint8Array(out);
}

/** Renders every output picture of the edit into the compositor, calling `take` after each. */
async function renderFrames(tl: Timeline, opts: ExportOptions, comp: Compositor, total: number, onProgress: (p: ExportProgress) => void, signal: AbortSignal, take: (T: number, step: number) => Promise<void>) {
  const step = 1e6 / opts.fps;
  const slots = new Map<string, ExportSlot>();
  const t0 = performance.now();
  let written = 0;

  /** Pushes every source frame of a clip up to media time `upTo` (so motion blur sees them all). */
  const feed = async (clip: TimelineClip, upTo: number) => {
    const media = await getMedia(clip.mediaPath);
    let slot = slots.get(clip.id);
    if (!slot) {
      const times = media.tracks[0]!.samples.map((s) => s.timestamp).filter((t) => t >= clip.inUs - 1 && t < clip.outUs).sort((a, b) => a - b);
      const decoders = media.tracks.map((t) => new TrackDecoder(media.reader, t));
      decoders.forEach((d) => { d.maxAhead = 6; d.seek(times[0] ?? clip.inUs); });
      slot = { clipId: clip.id, decoders, times, next: 0, pushedAny: false };
      slots.set(clip.id, slot);
    }
    const r = await comp.rendererFor(clip.id);
    r.setLayout(media.layout);
    let look = null;
    // Times are whole microseconds: a picture due right now may be stamped a hair later.
    upTo += Math.min(1000, 250_000 / media.fps);
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
    for (let n = 0; n * step < total - step * 0.01; n++) {
      const T = n * step;
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const L = stackAt(tl, T)!;
      const visible = L.layers;
      // Clips that are finished free their decoders and renderers.
      for (const [id, s] of slots) {
        if (!visible.some((v) => v.clip.id === id)) {
          s.decoders.forEach((d) => d.close());
          slots.delete(id);
        }
      }
      comp.release(new Set(visible.map((v) => v.clip.id)));
      const looks: ComposeLayer[] = [];
      for (const v of visible) {
        const look = await feed(v.clip, v.mediaUs);
        const r = await comp.rendererFor(v.clip.id);
        applyMasks(r, v.clip, await getMedia(v.clip.mediaPath), look, v.mediaUs, MASK_WIDTH);
        presentLook(r, look, { time: v.mediaUs });
        looks.push({ clip: v.clip, look, track: v.track, role: v.role });
      }
      const inTransition = visible.some((v) => v.role === 'in');
      await comp.compose(tl, T, looks, inTransition && L.transition ? transitionLook(L.transition.kind, L.progress) : null);
      const r0 = performance.now();
      await take(T, step);
      exportCost.readMs += performance.now() - r0;
      exportCost.frames++;
      written++;
      onProgress({ fraction: Math.min(0.99, T / total), stage: `Rendering clip ${visible[0]!.index + 1} of ${tl.clips.length}`, fps: written / ((performance.now() - t0) / 1000) });
    }
  } finally {
    for (const s of slots.values()) s.decoders.forEach((d) => d.close());
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
    const looks: ComposeLayer[] = [];
    for (const [i, l] of layers.entries()) {
      const r = await comp.rendererFor(l.clip.id);
      const ts = times[i]!;
      await cropReady(l.clip, l.media, width / height);
      // The preview may be showing a low-res proxy: grab from the original file.
      const own = held[i];
      const orig = own ? { frames: own, close: () => {} } : await framesAt(l.media, ts);
      try {
        r.setLayout(l.media.layout);
        const look = pushClipFrame(r, l.clip, l.media, ts, orig.frames);
        applyMasks(r, l.clip, l.media, look, ts, MASK_WIDTH);
        presentLook(r, { ...look, motionBlur: 0 }, { time: ts });
        looks.push({ clip: l.clip, look, track: l.track, role: l.role });
        await r.idle();
      } finally {
        orig.close();
      }
    }
    const L = stackAt(tl, T);
    const inTransition = layers.some((l) => l.role === 'in');
    await comp.compose(tl, T, looks, inTransition && L?.transition ? transitionLook(L.transition.kind, L.progress) : null);
    const png = path.toLowerCase().endsWith('.png');
    const blob = await comp.out.convertToBlob({ type: png ? 'image/png' : 'image/jpeg', quality: 0.95 });
    await ace.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  } finally {
    held.forEach((h) => h?.forEach((f) => f.close()));
    comp.destroy();
  }
}

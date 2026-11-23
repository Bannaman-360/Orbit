// WebGPU renderer.
//
//   pushFrame()  reframes one decoded source frame (pair) into the next history layer.
//   present()    blends the latest N layers (motion blur), sharpens, grades, applies
//                the LUT and vignette, and draws to the canvas.
//
// Keeping these separate is what makes motion blur work: each source frame is
// reframed once, and the final image averages consecutive frames like a long shutter.

import type { EacLayout } from './eac';
import { lensUniforms, type LensPair } from './lensMatch';
import { highRange, inputUniforms, type InputColor } from './inputColor';
import { type Mat3, IDENTITY } from './math';
import { type ViewParams, effectiveLens, sampleMatrix } from './projection';
import { REFRAME_WGSL } from './shader';
import { FINISH_WGSL } from './finish';
import { gpRadiusMax, planeScale, reachX, srcRadius, srcThetaMax, type SourceLens } from './sourceLens';

export type RenderMode = '360' | 'flat' | 'raw' | 'lens';

export const HISTORY_LAYERS = 8;

export interface PushInput {
  /** Stream 0 and (for 360 footage) stream 1. Frames are not closed by the renderer. */
  frames: [VideoFrame] | [VideoFrame, VideoFrame];
  mode: RenderMode;
  view: Omit<ViewParams, 'autoLens'> & { autoLens?: boolean };
  /** Camera body orientation from telemetry (identity = no correction). */
  correction?: Mat3;
  showTiles?: boolean;
  /** Flat footage: crop to fill the frame instead of fitting with bars. */
  fill?: boolean;
  /** Flat footage through its own lens (mode 'lens'), or 360 footage drawn as that lens would see it. */
  lens?: SourceLens;
  /** 'source' keeps that lens in the output; 'custom' uses the view's fisheye. */
  outputLens?: 'source' | 'custom';
  /** The field of view spans the output's width (as for 360), instead of the picture's. */
  camera?: boolean;
  /** Rolling shutter: correction for SHUTTER_ROWS rows, top to bottom (replaces `correction`). */
  rowCorrections?: Mat3[];
  /** Keep bars black outside the fitted picture (fit, while stabilised). */
  maskBars?: boolean;
  /** Quarter turns clockwise needed to show the stored picture upright. */
  turns?: number;
  /** What the recorded values mean (missing = as the browser shows them). */
  input?: InputColor;
  /** Corrections for each lens of a 360 camera. */
  lenses?: LensPair;
}

/** Grade values in the order the finishing shader expects (see project/look.ts). */
export interface FinishGrade {
  exposure: number; contrast: number; highlights: number; shadows: number;
  fade: number; saturation: number; vibrance: number; temperature: number;
  tint: number; vignette: number; sharpen: number; lutMix: number;
}

export interface PresentInput {
  /** Number of recent frames to blend (1 = no motion blur). */
  blendFrames: number;
  grade?: FinishGrade;
  /** Skip grading (raw debug view). */
  bypass?: boolean;
  /** Creative effects, 0..1 each (see project/look.ts Effects). */
  fx?: { grain: number; glow: number; chroma: number; zoomBlur: number; leak: number; bars: number };
  /** Seconds, for animated effects (grain, light leaks). */
  time?: number;
}

export interface Lut3D {
  size: number;
  /** size³ RGB triples, 0..1, red fastest. */
  data: Float32Array;
}

/**
 * One GPU device for the whole app (preview, export, frame grabs). Creating and
 * destroying devices repeatedly is slow and can crash the GPU process.
 */
let devicePromise: Promise<GPUDevice> | null = null;
export function sharedDevice(): Promise<GPUDevice> {
  if (!devicePromise) {
    devicePromise = (async () => {
      if (!('gpu' in navigator)) throw new Error('WebGPU is not available');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter');
      const device = await adapter.requestDevice();
      void device.lost.then((info) => {
        devicePromise = null;
        if (info.reason !== 'destroyed') console.error(`GPU device lost: ${info.message || info.reason}`);
      });
      // Shader and validation mistakes would otherwise only be a warning nobody sees.
      device.addEventListener('uncapturederror', (e) => console.error(`GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`));
      return device;
    })();
    devicePromise.catch(() => (devicePromise = null));
  }
  return devicePromise;
}

const REFRAME_UNIFORM_BYTES = 16 * 14 + 64 * 6 + 16 * 27 + 16 * 3 + 16 * 4;
/** Rolling-shutter matrices per frame, top row to bottom. */
export const SHUTTER_ROWS = 9;
const FINISH_UNIFORM_BYTES = 16 * 11;

const mode0 = (i: PushInput) => i.mode === '360';

/** A number 0–1 as a 16-bit float. */
export function toHalf(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 0x3c00;
  let e = Math.floor(Math.log2(v));
  if (e < -14) return Math.round(v * 2 ** 24);
  let m = Math.round((v / 2 ** e - 1) * 1024);
  if (m === 1024) { m = 0; e++; }
  return ((e + 15) << 10) | m;
}

export class ReframeRenderer {
  private layout: EacLayout | null = null;
  private history: GPUTexture | null = null;
  private historyViews: GPUTextureView[] = [];
  private historyArrayView: GPUTextureView | null = null;
  /** Log and HLG clips need more than 8 bits, and keep what is brighter than white. */
  private high = false;
  /** Pictures kept; with more bits only as many as are blended (they take twice the memory). */
  private layers = HISTORY_LAYERS;
  private wantLayers = 1;
  private pushes = 0;
  private lenses: LensPair | undefined;
  /** Preview only: shows which part of a 360 picture is one lens's. */
  highlight: 'front' | 'back' | null = null;
  /** Exporting: writes the values a video file holds, undoing this display curve (see color.ts). 0 = as shown. */
  fileGamma = 0;
  private next = 0; // layer the next push writes
  private filled = 0; // how many layers hold valid frames
  private lutTex: GPUTexture;
  private lutSize = 2;
  private hasLut = false;
  private width = 0;
  private height = 0;

  private constructor(
    readonly device: GPUDevice,
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly ctx: GPUCanvasContext,
    private readonly reframePipelines: { low: GPURenderPipeline; high: GPURenderPipeline },
    private readonly finishPipeline: GPURenderPipeline,
    private readonly sampler: GPUSampler,
    private readonly reframeUniforms: GPUBuffer,
    private readonly finishUniforms: GPUBuffer,
  ) {
    this.lutTex = this.makeLutTexture({ size: 2, data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]) });
  }

  /** Draws at more than 8 bits (half floats), for 10-bit export. */
  deep = false;

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas, opts: { deep?: boolean } = {}): Promise<ReframeRenderer> {
    const device = await sharedDevice();
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('Could not get a WebGPU canvas context');
    const format: GPUTextureFormat = opts.deep ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });

    const rm = device.createShaderModule({ code: REFRAME_WGSL });
    const reframe = (f: GPUTextureFormat) => device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: rm, entryPoint: 'vs' },
      fragment: { module: rm, entryPoint: 'fs', targets: [{ format: f }] },
      primitive: { topology: 'triangle-list' },
    });
    const reframePipeline = { low: reframe('rgba8unorm'), high: reframe('rgba16float') };
    const fm = device.createShaderModule({ code: FINISH_WGSL });
    const finishPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: fm, entryPoint: 'vs' },
      fragment: { module: fm, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    const ru = device.createBuffer({ size: REFRAME_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const fu = device.createBuffer({ size: FINISH_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const r = new ReframeRenderer(device, canvas, ctx, reframePipeline, finishPipeline, sampler, ru, fu);
    r.deep = !!opts.deep;
    return r;
  }

  setLayout(layout: EacLayout | null) {
    this.layout = layout;
    this.resetHistory();
  }

  /** Forget blended frames (after a seek, or when the view jumps while paused). */
  resetHistory() {
    this.filled = 0;
  }

  get historyFilled() {
    return this.filled;
  }

  setLut(lut: Lut3D | null) {
    if (!lut) {
      this.hasLut = false;
      return;
    }
    this.lutTex.destroy();
    this.lutTex = this.makeLutTexture(lut);
    this.lutSize = lut.size;
    this.hasLut = true;
  }

  private makeLutTexture(lut: Lut3D): GPUTexture {
    const n = lut.size;
    const tex = this.device.createTexture({ size: [n, n, n], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const px = new Uint16Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) {
      for (let k = 0; k < 3; k++) px[i * 4 + k] = toHalf(Math.max(0, Math.min(1, lut.data[i * 3 + k]!)));
      px[i * 4 + 3] = 0x3c00;
    }
    this.device.queue.writeTexture({ texture: tex }, px, { bytesPerRow: n * 8, rowsPerImage: n }, [n, n, n]);
    return tex;
  }

  /** Resizes the drawing surface (and history) to the canvas's current pixel size. */
  private ensureSize() {
    const w = this.canvas.width, h = this.canvas.height;
    const layers = this.high ? Math.max(2, this.wantLayers) : HISTORY_LAYERS, format: GPUTextureFormat = this.high ? 'rgba16float' : 'rgba8unorm';
    if (this.history && w === this.width && h === this.height && this.history.format === format && this.layers >= layers) return;
    this.history?.destroy();
    this.width = w;
    this.height = h;
    this.layers = layers;
    this.history = this.device.createTexture({
      size: [w, h, layers],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.historyViews = Array.from({ length: layers }, (_, i) =>
      this.history!.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }),
    );
    this.historyArrayView = this.history.createView({ dimension: '2d-array' });
    this.filled = 0;
    this.next = 0;
  }

  pushFrame(input: PushInput) {
    this.high = highRange(input.input);
    this.lenses = mode0(input) ? input.lenses : undefined;
    this.ensureSize();
    const { device } = this;
    const f0 = input.frames[0];
    const f1 = input.frames[1] ?? f0;
    const w = this.width, h = this.height;
    const layout = this.layout;
    const turns = (((input.turns ?? 0) % 4) + 4) % 4;
    const upright = turns % 2 ? f0.displayHeight / f0.displayWidth : f0.displayWidth / f0.displayHeight;
    const mode = (input.mode === '360' && !layout) || (input.mode === 'raw' && layout?.equirect) ? 'flat' : input.mode === 'lens' && !input.lens ? 'flat' : input.mode;

    const data = new Float32Array(REFRAME_UNIFORM_BYTES / 4);
    const m = sampleMatrix(input.view, input.correction ?? IDENTITY);
    const rows = input.rowCorrections?.length === SHUTTER_ROWS ? input.rowCorrections : null;
    data.set([m[0], m[1], m[2], input.maskBars ? 1 : 0, m[3], m[4], m[5], rows ? 1 : 0, m[6], m[7], m[8], layout?.equirect ? 1 : 0], 0);
    rows?.forEach((c, i) => {
      const q = sampleMatrix(input.view, c);
      data.set([q[0], q[1], q[2], 0, q[3], q[4], q[5], 0, q[6], q[7], q[8], 0], 56 + 96 + i * 12);
    });
    const lens = effectiveLens({ fov: input.view.fov, fisheye: input.view.fisheye, autoLens: input.view.autoLens ?? true });
    data.set([w / h, lens.fov * (Math.PI / 180), lens.k, mode === '360' ? 0 : mode === 'flat' ? 1 : mode === 'lens' ? 3 : 2], 12);
    const sw = layout?.streamWidth ?? f0.displayWidth;
    const sh = layout?.streamHeight ?? f0.displayHeight;
    data.set([sw, sh, upright, (mode === 'raw' ? input.showTiles : input.mode !== 'raw' && input.fill) ? 1 : 0], 16);
    const l = input.lens;
    if (l) {
      const pic = mode === '360' ? (l.gopro ? l.aspect : l.aspect / l.stretch) : upright;
      const [sx, sy] = planeScale(w / h, pic, input.camera ? 'camera' : input.fill === false ? 'fit' : 'fill');
      data.set([l.coeffs[0], l.coeffs[1], l.coeffs[2], l.coeffs[3]], 20);
      data.set([l.coeffs[4], l.gopro ? 2 : l.kind === 'linear' ? 1 : 0, 1 / srcRadius(l, (l.hfov * Math.PI) / 360), srcThetaMax(l)], 24);
      if (l.gopro) {
        const g = l.gopro;
        data.set([...g.poly.slice(1, 5), g.poly[5]!, g.poly[6]!, 1 / g.zoom, gpRadiusMax(g), ...g.mapX, ...g.mapY], 36);
      }
      data.set([l.gopro ? l.gopro.aspect : l.aspect, l.stretch, sx, sy], 28);
      data.set([input.outputLens === 'source' ? (mode === '360' ? 2 : 1) : 0, reachX(l, input.view.fov / 2), turns, pic], 32);
    } else data.set([0, 1, turns, upright], 32);
    layout?.tiles.forEach((t, i) => {
      data.set([...t.center, t.stream, ...t.right, 0, ...t.down, 0, t.x, t.y, t.size, t.gap ?? 0], 56 + i * 16);
    });
    data.set(inputUniforms(input.input, this.pushes++ % 997), 56 + 96 + 108);
    data.set(lensUniforms(this.lenses), 56 + 96 + 108 + 12);
    device.queue.writeBuffer(this.reframeUniforms, 0, data);
    const pipeline = this.high ? this.reframePipelines.high : this.reframePipelines.low;

    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: device.importExternalTexture({ source: f0 }) },
        { binding: 2, resource: device.importExternalTexture({ source: f1 }) },
        { binding: 3, resource: { buffer: this.reframeUniforms } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.historyViews[this.next]!, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
    this.next = (this.next + 1) % this.layers;
    this.filled = Math.min(this.filled + 1, this.layers);
  }

  present(input: PresentInput) {
    if (!this.history || this.filled === 0) return;
    const { device } = this;
    this.wantLayers = Math.max(1, Math.min(HISTORY_LAYERS, Math.round(input.blendFrames)));
    const n = Math.max(1, Math.min(this.wantLayers, this.filled, this.layers));
    const u32 = new Uint32Array(8);
    for (let s = 0; s < 8; s++) u32[s] = (this.next - 1 - s + this.layers * HISTORY_LAYERS) % this.layers;
    const g = input.grade;
    const f32 = new Float32Array([
      n, input.bypass ? 1 : 0, this.hasLut ? 1 : 0, this.lutSize,
      g?.exposure ?? 0, g?.contrast ?? 0, g?.highlights ?? 0, g?.shadows ?? 0,
      g?.fade ?? 0, g?.saturation ?? 0, g?.vibrance ?? 0, g?.temperature ?? 0,
      g?.tint ?? 0, g?.vignette ?? 0, g?.sharpen ?? 0, g?.lutMix ?? 1,
      this.width, this.height, 1 / this.width, 1 / this.height,
      input.fx?.grain ?? 0, input.fx?.glow ?? 0, input.fx?.chroma ?? 0, input.fx?.zoomBlur ?? 0,
      input.fx?.leak ?? 0, input.fx?.bars ?? 0, input.time ?? 0, this.high ? 1 : 0,
      this.lenses?.front?.sharpness ?? 0, this.lenses?.back?.sharpness ?? 0, this.lenses?.front?.clarity ?? 0, this.lenses?.back?.clarity ?? 0,
      this.highlight === 'front' ? 1 : this.highlight === 'back' ? 2 : 0, this.fileGamma, this.deep ? 1 / 1023 : 1 / 255, 0,
    ]);
    const buf = new ArrayBuffer(FINISH_UNIFORM_BYTES);
    new Uint32Array(buf, 0, 8).set(u32);
    new Float32Array(buf, 32).set(f32);
    device.queue.writeBuffer(this.finishUniforms, 0, buf);

    const bind = device.createBindGroup({
      layout: this.finishPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.historyArrayView! },
        { binding: 2, resource: this.lutTex.createView({ dimension: '3d' }) },
        { binding: 3, resource: { buffer: this.finishUniforms } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.finishPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  /** Waits until the GPU has finished all submitted work (used by export). */
  async idle() {
    await this.device.queue.onSubmittedWorkDone();
  }

  /** Frees this renderer's textures (the shared device stays). */
  destroy() {
    this.history?.destroy();
    this.history = null;
    this.lutTex.destroy();
    this.ctx.unconfigure();
  }
}

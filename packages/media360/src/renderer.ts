// WebGPU renderer.
//
//   pushFrame()  reframes one decoded source frame (pair) into the next history layer.
//   present()    blends the latest N layers (motion blur), sharpens, grades, applies
//                the LUT and vignette, and draws to the canvas.
//
// Keeping these separate is what makes motion blur work: each source frame is
// reframed once, and the final image averages consecutive frames like a long shutter.

import type { EacLayout } from './eac';
import { type Mat3, IDENTITY } from './math';
import { type ViewParams, effectiveLens, sampleMatrix } from './projection';
import { REFRAME_WGSL } from './shader';
import { FINISH_WGSL } from './finish';

export type RenderMode = '360' | 'flat' | 'raw';

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
      void device.lost.then(() => (devicePromise = null));
      return device;
    })();
    devicePromise.catch(() => (devicePromise = null));
  }
  return devicePromise;
}

const REFRAME_UNIFORM_BYTES = 16 * 5 + 64 * 6;
const FINISH_UNIFORM_BYTES = 16 * 9;

export class ReframeRenderer {
  private layout: EacLayout | null = null;
  private history: GPUTexture | null = null;
  private historyViews: GPUTextureView[] = [];
  private historyArrayView: GPUTextureView | null = null;
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
    private readonly reframePipeline: GPURenderPipeline,
    private readonly finishPipeline: GPURenderPipeline,
    private readonly sampler: GPUSampler,
    private readonly reframeUniforms: GPUBuffer,
    private readonly finishUniforms: GPUBuffer,
  ) {
    this.lutTex = this.makeLutTexture({ size: 2, data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]) });
  }

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ReframeRenderer> {
    const device = await sharedDevice();
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('Could not get a WebGPU canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });

    const rm = device.createShaderModule({ code: REFRAME_WGSL });
    const reframePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: rm, entryPoint: 'vs' },
      fragment: { module: rm, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
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
    return new ReframeRenderer(device, canvas, ctx, reframePipeline, finishPipeline, sampler, ru, fu);
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
    const tex = this.device.createTexture({ size: [n, n, n], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const px = new Uint8Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) {
      px[i * 4] = Math.round(Math.max(0, Math.min(1, lut.data[i * 3]!)) * 255);
      px[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, lut.data[i * 3 + 1]!)) * 255);
      px[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, lut.data[i * 3 + 2]!)) * 255);
      px[i * 4 + 3] = 255;
    }
    this.device.queue.writeTexture({ texture: tex }, px, { bytesPerRow: n * 4, rowsPerImage: n }, [n, n, n]);
    return tex;
  }

  /** Resizes the drawing surface (and history) to the canvas's current pixel size. */
  private ensureSize() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this.history && w === this.width && h === this.height) return;
    this.history?.destroy();
    this.width = w;
    this.height = h;
    this.history = this.device.createTexture({
      size: [w, h, HISTORY_LAYERS],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.historyViews = Array.from({ length: HISTORY_LAYERS }, (_, i) =>
      this.history!.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }),
    );
    this.historyArrayView = this.history.createView({ dimension: '2d-array' });
    this.filled = 0;
    this.next = 0;
  }

  pushFrame(input: PushInput) {
    this.ensureSize();
    const { device } = this;
    const f0 = input.frames[0];
    const f1 = input.frames[1] ?? f0;
    const w = this.width, h = this.height;
    const layout = this.layout;
    const mode = input.mode === '360' && !layout ? 'flat' : input.mode;

    const data = new Float32Array(REFRAME_UNIFORM_BYTES / 4);
    const m = sampleMatrix(input.view, input.correction ?? IDENTITY);
    data.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0], 0);
    const lens = effectiveLens({ fov: input.view.fov, fisheye: input.view.fisheye, autoLens: input.view.autoLens ?? true });
    data.set([w / h, lens.fov * (Math.PI / 180), lens.k, mode === '360' ? 0 : mode === 'flat' ? 1 : 2], 12);
    const sw = layout?.streamWidth ?? f0.displayWidth;
    const sh = layout?.streamHeight ?? f0.displayHeight;
    data.set([sw, sh, f0.displayWidth / f0.displayHeight, (mode === 'raw' ? input.showTiles : input.fill) ? 1 : 0], 16);
    layout?.tiles.forEach((t, i) => {
      data.set([...t.center, t.stream, ...t.right, 0, ...t.down, 0, t.x, t.y, t.size, t.gap ?? 0], 20 + i * 16);
    });
    device.queue.writeBuffer(this.reframeUniforms, 0, data);

    const bind = device.createBindGroup({
      layout: this.reframePipeline.getBindGroupLayout(0),
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
    pass.setPipeline(this.reframePipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
    this.next = (this.next + 1) % HISTORY_LAYERS;
    this.filled = Math.min(this.filled + 1, HISTORY_LAYERS);
  }

  present(input: PresentInput) {
    if (!this.history || this.filled === 0) return;
    const { device } = this;
    const n = Math.max(1, Math.min(Math.round(input.blendFrames), this.filled, HISTORY_LAYERS));
    const u32 = new Uint32Array(8);
    for (let s = 0; s < 8; s++) u32[s] = (this.next - 1 - s + HISTORY_LAYERS * 2) % HISTORY_LAYERS;
    const g = input.grade;
    const f32 = new Float32Array([
      n, input.bypass ? 1 : 0, this.hasLut ? 1 : 0, this.lutSize,
      g?.exposure ?? 0, g?.contrast ?? 0, g?.highlights ?? 0, g?.shadows ?? 0,
      g?.fade ?? 0, g?.saturation ?? 0, g?.vibrance ?? 0, g?.temperature ?? 0,
      g?.tint ?? 0, g?.vignette ?? 0, g?.sharpen ?? 0, g?.lutMix ?? 1,
      this.width, this.height, 1 / this.width, 1 / this.height,
      input.fx?.grain ?? 0, input.fx?.glow ?? 0, input.fx?.chroma ?? 0, input.fx?.zoomBlur ?? 0,
      input.fx?.leak ?? 0, input.fx?.bars ?? 0, input.time ?? 0, 0,
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

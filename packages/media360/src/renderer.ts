// WebGPU renderer: two decoded GoPro streams in, a reframed view out.

import type { EacLayout } from './eac';
import { type Mat3, IDENTITY } from './math';
import { type ViewParams, MAX_FOV, sampleMatrix } from './projection';
import { REFRAME_WGSL } from './shader';

export type RenderMode = '360' | 'flat' | 'raw';

export interface RenderInput {
  /** Stream 0 and (for 360 footage) stream 1. Frames are not closed by the renderer. */
  frames: [VideoFrame] | [VideoFrame, VideoFrame];
  mode: RenderMode;
  view: ViewParams;
  /** Camera body orientation from telemetry (identity = no correction). */
  correction?: Mat3;
  showTiles?: boolean;
}

const UNIFORM_BYTES = 16 * 5 + 64 * 6;

export class ReframeRenderer {
  private layout: EacLayout | null = null;

  private constructor(
    readonly device: GPUDevice,
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly ctx: GPUCanvasContext,
    private readonly pipeline: GPURenderPipeline,
    private readonly sampler: GPUSampler,
    private readonly uniforms: GPUBuffer,
  ) {}

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ReframeRenderer> {
    if (!('gpu' in navigator)) throw new Error('WebGPU is not available');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('Could not get a WebGPU canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: REFRAME_WGSL });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const uniforms = device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return new ReframeRenderer(device, canvas, ctx, pipeline, sampler, uniforms);
  }

  setLayout(layout: EacLayout) {
    this.layout = layout;
  }

  render(input: RenderInput) {
    const { device } = this;
    const f0 = input.frames[0];
    const f1 = input.frames[1] ?? f0;
    const w = this.canvas.width, h = this.canvas.height;
    const layout = this.layout;
    const mode = input.mode === '360' && !layout ? 'flat' : input.mode;

    const data = new Float32Array(UNIFORM_BYTES / 4);
    const m = sampleMatrix(input.view, input.correction ?? IDENTITY);
    data.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0], 0);
    const fov = Math.min(input.view.fov, MAX_FOV[input.view.projection]) * (Math.PI / 180);
    data.set([w / h, fov, input.view.projection === 'stereographic' ? 1 : 0, mode === '360' ? 0 : mode === 'flat' ? 1 : 2], 12);
    const sw = layout?.streamWidth ?? f0.displayWidth;
    const sh = layout?.streamHeight ?? f0.displayHeight;
    data.set([sw, sh, f0.displayWidth / f0.displayHeight, input.showTiles ? 1 : 0], 16);
    layout?.tiles.forEach((t, i) => {
      const o = 20 + i * 16;
      data.set([...t.center, t.stream, ...t.right, 0, ...t.down, 0, t.x, t.y, t.size, t.gap ?? 0], o);
    });
    device.queue.writeBuffer(this.uniforms, 0, data);

    const bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: device.importExternalTexture({ source: f0 }) },
        { binding: 2, resource: device.importExternalTexture({ source: f1 }) },
        { binding: 3, resource: { buffer: this.uniforms } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}

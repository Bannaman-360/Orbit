// Scopes: waveform, RGB parade, vectorscope and histogram, worked out on the GPU from the finished
// picture (ReframeRenderer.tap) and drawn into their own canvas.
//
//   analyse()  a compute pass counts a grid of the picture's pixels into bins (atomics);
//              a second one finds the fullest histogram bin, to scale it.
//   draw()     turns the counts into the scope picture.

import { sharedDevice } from './renderer';

export type ScopeKind = 'waveform' | 'parade' | 'vector' | 'histogram';
export const SCOPE_KINDS: [ScopeKind, string][] = [['waveform', 'Waveform'], ['parade', 'Parade'], ['vector', 'Vectorscope'], ['histogram', 'Histogram']];

/** Grid of pixels sampled from the picture (enough for every column of the waveform). */
const GRID_W = 512, GRID_H = 288;
/** Bins: waveform (4 channels × 256 levels × 256 columns), vectorscope 256², histogram 4 × 256, then the fullest histogram bin. */
const WAVE = 0, VEC = 4 * 256 * 256, HIST = VEC + 256 * 256, MAXI = HIST + 4 * 256;
const BINS = MAXI + 4;

const COUNT_WGSL = /* wgsl */ `
@group(0) @binding(0) var img : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bins : array<atomic<u32>>;

fn luma(c : vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn level(v : f32) -> u32 { return u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5); }

@compute @workgroup_size(16, 16) fn count(@builtin(global_invocation_id) id : vec3u) {
  if (id.x >= ${GRID_W}u || id.y >= ${GRID_H}u) { return; }
  let size = textureDimensions(img);
  let p = vec2u((vec2f(id.xy) + 0.5) / vec2f(${GRID_W}.0, ${GRID_H}.0) * vec2f(size));
  let c = clamp(textureLoad(img, min(p, size - 1u), 0).rgb, vec3f(0.0), vec3f(1.0));
  let col = id.x * 256u / ${GRID_W}u;
  let y = luma(c);
  atomicAdd(&bins[${WAVE}u + level(y) * 256u + col], 1u);
  atomicAdd(&bins[${WAVE}u + 65536u + level(c.r) * 256u + col], 1u);
  atomicAdd(&bins[${WAVE}u + 131072u + level(c.g) * 256u + col], 1u);
  atomicAdd(&bins[${WAVE}u + 196608u + level(c.b) * 256u + col], 1u);
  // Colour difference (Rec.709): blue to the right, red up.
  let u = (c.b - y) / 1.8556;
  let v = (c.r - y) / 1.5748;
  let vx = u32(clamp(u + 0.5, 0.0, 1.0) * 255.0);
  let vy = u32(clamp(0.5 - v, 0.0, 1.0) * 255.0);
  atomicAdd(&bins[${VEC}u + vy * 256u + vx], 1u);
  atomicAdd(&bins[${HIST}u + level(y)], 1u);
  atomicAdd(&bins[${HIST}u + 256u + level(c.r)], 1u);
  atomicAdd(&bins[${HIST}u + 512u + level(c.g)], 1u);
  atomicAdd(&bins[${HIST}u + 768u + level(c.b)], 1u);
}

// The fullest histogram bin, leaving out pure black and pure white (they'd flatten the rest).
@compute @workgroup_size(256) fn peak(@builtin(local_invocation_id) id : vec3u) {
  if (id.x == 0u || id.x == 255u) { return; }
  for (var k = 0u; k < 4u; k++) { atomicMax(&bins[${MAXI}u], atomicLoad(&bins[${HIST}u + k * 256u + id.x])); }
}
`;

const DRAW_WGSL = /* wgsl */ `
struct Scope { kind : vec4f };  // x: 0 waveform, 1 parade, 2 vectorscope, 3 histogram; y: brightness
@group(0) @binding(0) var<storage, read> bins : array<u32>;
@group(0) @binding(1) var<uniform> s : Scope;

struct VsOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : VsOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

// Counts → brightness: a log scale, so a few pixels still show and many don't burn out.
fn glow(n : u32, full : f32) -> f32 { return clamp(log2(1.0 + f32(n)) / log2(1.0 + full) * s.kind.y, 0.0, 1.0); }

fn wave(ch : u32, uv : vec2f) -> f32 {
  let col = min(u32(uv.x * 256.0), 255u);
  let lv = min(u32((1.0 - uv.y) * 255.0 + 0.5), 255u);
  return glow(bins[ch * 65536u + lv * 256u + col], ${GRID_H}.0 * 0.5);
}

@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  let k = u32(s.kind.x + 0.5);
  let bg = vec3f(0.035, 0.037, 0.042);
  var c = bg;
  if (k == 0u) {
    c += vec3f(0.75, 0.95, 0.8) * wave(0u, in.uv);
  } else if (k == 1u) {
    let third = min(u32(in.uv.x * 3.0), 2u);
    let x = vec2f(fract(in.uv.x * 3.0), in.uv.y);
    let tint = select(select(vec3f(0.35, 0.55, 1.0), vec3f(0.35, 1.0, 0.45), third == 1u), vec3f(1.0, 0.35, 0.3), third == 0u);
    c += tint * wave(1u + third, x);
    if (fract(in.uv.x * 3.0) < 0.004 && third > 0u) { c = vec3f(0.25); }
  } else if (k == 2u) {
    let x = min(u32(in.uv.x * 256.0), 255u);
    let y = min(u32(in.uv.y * 256.0), 255u);
    let n = bins[${VEC}u + y * 256u + x];
    // Coloured by where it sits: the hue that position stands for.
    let u = in.uv.x - 0.5;
    let v = 0.5 - in.uv.y;
    let hue = clamp(vec3f(0.5) + vec3f(1.5748 * v, -0.1873 * u - 0.4681 * v, 1.8556 * u) * 1.6, vec3f(0.0), vec3f(1.0));
    c += mix(vec3f(0.85), hue, 0.6) * glow(n, ${GRID_W * GRID_H}.0 / 2000.0);
  } else {
    let b = min(u32(in.uv.x * 256.0), 255u);
    let top = max(1.0, f32(bins[${MAXI}u]));
    let h = 1.0 - in.uv.y;
    let r = f32(bins[${HIST}u + 256u + b]) / top;
    let g = f32(bins[${HIST}u + 512u + b]) / top;
    let bl = f32(bins[${HIST}u + 768u + b]) / top;
    let y = f32(bins[${HIST}u + b]) / top;
    let on = vec3f(select(0.0, 1.0, h < r), select(0.0, 1.0, h < g), select(0.0, 1.0, h < bl));
    c += on * vec3f(0.75, 0.7, 0.85) * 0.75 + select(0.0, 0.12, h < y);
  }
  return vec4f(min(c, vec3f(1.0)), 1.0);
}
`;

export class ScopeRenderer {
  private bins: GPUBuffer;
  private uniforms: GPUBuffer;
  private countPipe: GPUComputePipeline;
  private peakPipe: GPUComputePipeline;
  private drawPipe: GPURenderPipeline;
  private ctx: GPUCanvasContext;
  /** Pictures counted so far (0 = nothing to draw yet). */
  analysed = 0;
  /** Brightness of the traces (1 = normal). */
  gain = 1;

  private constructor(readonly device: GPUDevice, readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('Could not get a WebGPU canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });
    this.ctx = ctx;
    this.bins = device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cm = device.createShaderModule({ code: COUNT_WGSL });
    this.countPipe = device.createComputePipeline({ layout: 'auto', compute: { module: cm, entryPoint: 'count' } });
    this.peakPipe = device.createComputePipeline({ layout: 'auto', compute: { module: cm, entryPoint: 'peak' } });
    const dm = device.createShaderModule({ code: DRAW_WGSL });
    this.drawPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: dm, entryPoint: 'vs' },
      fragment: { module: dm, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ScopeRenderer> {
    return new ScopeRenderer(await sharedDevice(), canvas);
  }

  /** Counts a finished picture (encoded into the caller's commands; see ReframeRenderer.tap). */
  analyse(tex: GPUTexture, enc: GPUCommandEncoder) {
    enc.clearBuffer(this.bins);
    const bind = this.device.createBindGroup({ layout: this.countPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: this.bins } }] });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.countPipe);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(GRID_W / 16, GRID_H / 16);
    const pb = this.device.createBindGroup({ layout: this.peakPipe.getBindGroupLayout(0), entries: [{ binding: 1, resource: { buffer: this.bins } }] });
    pass.setPipeline(this.peakPipe);
    pass.setBindGroup(0, pb);
    pass.dispatchWorkgroups(1);
    pass.end();
    this.analysed++;
  }

  /** Draws the last counted picture as one kind of scope. */
  draw(kind: ScopeKind) {
    const k = SCOPE_KINDS.findIndex(([x]) => x === kind);
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([k, this.gain, 0, 0]));
    const bind = this.device.createBindGroup({ layout: this.drawPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.bins } }, { binding: 1, resource: { buffer: this.uniforms } }] });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.drawPipe);
    pass.setBindGroup(0, bind);
    // The vectorscope is round: a square in the middle.
    const { width: w, height: h } = this.canvas;
    if (kind === 'vector') { const side = Math.min(w, h); pass.setViewport((w - side) / 2, (h - side) / 2, side, side, 0, 1); }
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** The counts (for tests): waveform, vectorscope and histogram bins. */
  async read(): Promise<{ wave: Uint32Array; vector: Uint32Array; hist: Uint32Array; peak: number }> {
    const buf = this.device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.bins, 0, buf, 0, BINS * 4);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const all = new Uint32Array(buf.getMappedRange().slice(0));
    buf.destroy();
    return { wave: all.slice(WAVE, VEC), vector: all.slice(VEC, HIST), hist: all.slice(HIST, MAXI), peak: all[MAXI]! };
  }

  destroy() {
    this.bins.destroy();
    this.uniforms.destroy();
    this.ctx.unconfigure();
  }
}

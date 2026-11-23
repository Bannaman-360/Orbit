// 10-bit export: the finished picture (half floats, already in the values a video file holds)
// turned into 10-bit Y′CbCr on the GPU and read back, ready to hand to the encoder (ffmpeg).

import { sharedDevice } from '@ace/media360';

/** How the 10-bit pictures are laid out for the encoder (ffmpeg pixel formats). */
export type YuvLayout = 'p010le' | 'p210le';

/** Bytes in one picture. */
export const yuvBytes = (w: number, h: number, layout: YuvLayout) => (layout === 'p010le' ? w * h * 3 : w * h * 4);

const WGSL = /* wgsl */ `
struct U { w : u32, h : u32, mode : u32, words : u32 }
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<u32>;
@group(0) @binding(2) var<uniform> u : U;

fn rgb(x : u32, y : u32) -> vec3f { return clamp(textureLoad(src, vec2u(min(x, u.w - 1u), min(y, u.h - 1u)), 0).rgb, vec3f(0.0), vec3f(1.0)); }
// BT.709, limited range, 10 bits.
fn lumaOf(c : vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn q(v : f32) -> u32 { return u32(clamp(round(v), 0.0, 1023.0)); }
fn chroma(cx : u32, cy : u32, tall : bool) -> vec2u {
  var c = rgb(2u * cx, cy) + rgb(2u * cx + 1u, cy);
  var n = 2.0;
  if (tall) { c += rgb(2u * cx, cy + 1u) + rgb(2u * cx + 1u, cy + 1u); n = 4.0; }
  c /= n;
  let l = lumaOf(c);
  return vec2u(q(512.0 + 896.0 * (c.b - l) / 1.8556), q(512.0 + 896.0 * (c.r - l) / 1.5748));
}
fn sample(i : u32) -> u32 {
  let n = u.w * u.h;
  let cw = u.w / 2u;
  if (i < n) {
    let y = q(64.0 + 876.0 * lumaOf(rgb(i % u.w, i / u.w)));
    return y << 6u;
  }
  // One plane of Cb,Cr pairs at half width: half height (P010, 4:2:0) or full height (P210, 4:2:2).
  // Values sit in the top 10 bits of each 16.
  let k = i - n;
  let p = k / 2u;
  let tall = u.mode == 0u;
  let c = chroma(p % cw, select(p / cw, (p / cw) * 2u, tall), tall);
  return select(c.y, c.x, k % 2u == 0u) << 6u;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g : vec3u, @builtin(num_workgroups) nw : vec3u) {
  let wi = g.x + g.y * nw.x * 256u;
  if (wi >= u.words) { return; }
  dst[wi] = sample(wi * 2u) | (sample(wi * 2u + 1u) << 16u);
}
`;

let pipe: GPUComputePipeline | null = null;

/** Reads one picture at a time; keep a few of these to overlap reading with drawing. */
export class YuvReader {
  private busy: Promise<unknown> = Promise.resolve();
  private constructor(private device: GPUDevice, private tex: GPUTexture, private out: GPUBuffer, private map: GPUBuffer, private bind: GPUBindGroup, private w: number, private h: number, private bytes: number) {}
  static async create(w: number, h: number, layout: YuvLayout) {
    if (w % 2) throw new Error('10-bit export needs an even width');
    const device = await sharedDevice();
    if (!pipe) {
      // A mistake here must stop the export, not quietly write black pictures.
      device.pushErrorScope('validation');
      const p = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: 'main' } });
      const err = await device.popErrorScope();
      if (err) throw new Error(`10-bit conversion: ${err.message}`);
      pipe = p;
    }
    const bytes = yuvBytes(w, h, layout);
    const tex = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    const out = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const map = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const uni = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uni, 0, new Uint32Array([w, h, layout === 'p010le' ? 0 : 1, bytes / 4]));
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: out } }, { binding: 2, resource: { buffer: uni } }] });
    return new YuvReader(device, tex, out, map, bind, w, h, bytes);
  }
  async read(src: OffscreenCanvas): Promise<Uint8Array> {
    await this.busy;
    const { device } = this;
    device.queue.copyExternalImageToTexture({ source: src }, { texture: this.tex }, [this.w, this.h]);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe!);
    pass.setBindGroup(0, this.bind);
    const groups = Math.ceil(this.bytes / 4 / 256);
    const gx = Math.min(groups, 65535);
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    pass.end();
    enc.copyBufferToBuffer(this.out, 0, this.map, 0, this.bytes);
    device.queue.submit([enc.finish()]);
    const mapped = this.map.mapAsync(GPUMapMode.READ);
    this.busy = mapped.catch(() => {});
    await mapped;
    const px = new Uint8Array(this.map.getMappedRange()).slice();
    this.map.unmap();
    return px;
  }
  destroy() {
    this.tex.destroy();
    this.out.destroy();
    this.map.destroy();
  }
}

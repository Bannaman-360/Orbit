// Log, HLG and 10-bit color, against clips with exactly known values (fixtures/synthetic/color).

import { decoderConfig, openMedia, type VideoTrackInfo } from '@ace/engine';
import { addClip, DEFAULT_LOOK, emptyTimeline, newClip, type Look, type TimelineClip } from '@ace/project';
import { browserSees, convertInput, LOG_EV, logEncode, needsConversion, PLAIN_INPUT, rec709Encode, ReframeRenderer, sharedDevice, shoulder, type Rgb } from '@ace/media360';
import { ace, ipcReader } from './api';
import { framesAt } from './calib';
import { inputFor, ordinaryGamma, resolvedInput } from './color';
import { exportTimeline } from './exporter';
import { presentLook, pushClipFrame } from './frameRender';
import { getMedia, type Media } from './media';
import { defaultPrefs, setPrefs } from './ui/prefs';
import type { EditorApi } from './selftest';
import { previewSource, proxiesIdle, setPreviewLevel } from './proxy';

/** One frame of a file, decoded with (optionally) another colour description than the file's own. */
export async function decodeOne(path: string, colorSpace?: VideoColorSpaceInit, index = 5): Promise<{ frame: VideoFrame; track: VideoTrackInfo }> {
  const reader = ipcReader(path, (await ace.stat(path)).size);
  const track = (await openMedia(reader)).videoTracks[0]!;
  const want = track.samples[index]!.timestamp;
  const chunks = await Promise.all(track.samples.slice(0, index + 8).map(async (s) => new EncodedVideoChunk({ type: s.isSync ? 'key' : 'delta', timestamp: s.timestamp, duration: s.duration, data: await reader.read(s.offset, s.size) })));
  const frame = await new Promise<VideoFrame>((resolve, reject) => {
    const d = new VideoDecoder({ output: (f) => { if (f.timestamp === want) resolve(f); else f.close(); }, error: reject });
    d.configure({ ...decoderConfig(track), ...(colorSpace ? { colorSpace } : {}) });
    chunks.forEach((c) => d.decode(c));
    void d.flush().then(() => d.close());
  });
  return { frame, track };
}

/** What the GPU sees of a frame, unrounded (rgb triples, row by row). */
export async function gpuPixels(frame: VideoFrame, w: number, h: number): Promise<Float32Array> {
  const device = await sharedDevice();
  const code = `
    @group(0) @binding(0) var s : sampler; @group(0) @binding(1) var t : texture_external;
    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f { var p = array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.); }
    @fragment fn fs(@builtin(position) p : vec4f) -> @location(0) vec4f { return textureSampleBaseClampToEdge(t, s, p.xy / vec2f(${w}., ${h}.)); }`;
  const m = device.createShaderModule({ code });
  const pipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] } });
  const tex = device.createTexture({ size: [w, h], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) }, { binding: 1, resource: device.importExternalTexture({ source: frame }) }] });
  const bpr = Math.ceil((w * 16) / 256) * 256, buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Float32Array(buf.getMappedRange()), out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = src[(y * bpr) / 4 + x * 4 + k]!;
  buf.unmap();
  tex.destroy();
  return out;
}

const r3 = (v: number) => +v.toFixed(4);

/** What the browser does to each kind of file before we see it. */
export async function colorProbe() {
  const out: Record<string, unknown> = {};
  const plain: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
  for (const path of (await ace.listFixtures()).filter((f) => /synthetic[\\/]color[\\/]/.test(f))) {
    const name = path.split(/[\\/]/).pop()!;
    const res: Record<string, unknown> = {};
    for (const [how, cs] of [['as tagged', undefined], ['709 tag, own matrix', /2020tag|hlg/.test(name) ? { ...plain, matrix: 'bt2020-ncl' as const } : { ...plain, fullRange: /full/.test(name) }], ['srgb tag', { ...plain, transfer: 'iec61966-2-1' as const, ...(/2020tag|hlg/.test(name) ? { matrix: 'bt2020-ncl' as const } : {}), fullRange: /full/.test(name) }]] as [string, VideoColorSpaceInit | undefined][]) {
      const { frame } = await decodeOne(path, cs);
      const W = 2048, H = 1152, px = await gpuPixels(frame, W, H);
      const at = (x: number, y: number) => [...px.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)].map(r3);
      const ten = /c10/.test(name), full = /full/.test(name), max = ten ? 1024 : 256;
      const code = (x: number) => Math.floor((x * max) / W), k = ten ? 4 : 1;
      const want = (x: number) => (full ? code(x) / (max - 1) : (code(x) - 16 * k) / (219 * k));
      const ramp = [128, 256, 512, 1024, 1536, 1800].map((x) => [r3(want(x)), at(x, 190)[1]]);
      let worst = 0;
      for (let x = 160; x < 1860; x++) worst = Math.max(worst, Math.abs(px[(190 * W + x) * 3 + 1]! - want(x)));
      const levels = new Set<number>();
      for (let x = 0; x < W; x++) levels.add(Math.round(px[(576 * W + x) * 3 + 1]! * 65535));
      const patches = Array.from({ length: 16 }, (_, i) => at(Math.round(((i + 0.5) * W) / 16), 960));
      res[how] = { format: frame.format, space: `${frame.colorSpace.primaries}/${frame.colorSpace.transfer}/${frame.colorSpace.matrix}/${frame.colorSpace.fullRange ? 'full' : 'limited'}`, ramp, rampWorst: r3(worst), gradientLevels: levels.size, patches };
      frame.close();
    }
    out[name] = res;
  }
  return out;
}

const readTex = async (device: GPUDevice, tex: GPUTexture, w: number, h: number, row: number): Promise<number[]> => {
  // (rgba16float, one row → green)
  const bpr = Math.ceil((w * 8) / 256) * 256, buf = device.createBuffer({ size: bpr, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, origin: [0, row] }, { buffer: buf, bytesPerRow: bpr }, [w, 1]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const u = new Uint16Array(buf.getMappedRange().slice(0));
  buf.unmap();
  void h;
  const f16 = (v: number) => { const e = (v >> 10) & 31, m = v & 1023, sg = v & 32768 ? -1 : 1; return sg * (e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15)); };
  return Array.from({ length: w }, (_, x) => f16(u[x * 4 + 1]!));
};

/** Other ways of getting a 10-bit frame onto the GPU. */
export async function colorRoutes() {
  const out: Record<string, unknown> = {};
  const adapter = (await navigator.gpu.requestAdapter())!;
  out.features = [...adapter.features].join(' ');
  const device = await sharedDevice();
  const W = 2048, H = 1152;
  const sum = (px: number[], name: string, p2: number[]) => {
    const levels = new Set(p2.map((v) => Math.round(v * 65535))).size;
    out[name] = { ramp: [128, 256, 512, 1024, 1536, 1800].map((x) => r3(px[x]!)), gradientLevels: levels };
  };
  for (const f of ['c10-709.mp4', 'c10-hlg.mp4', 'c10-gplog-2020tag.mp4']) {
    const path = (await ace.listFixtures()).find((x) => x.endsWith(f))!;
    const { frame } = await decodeOne(path);
    const note = (n: string, e: unknown) => { out[`${f} ${n}`] = `no: ${String(e).slice(0, 160)}`; };
    for (const cs of ['srgb', 'display-p3'] as const) try {
      const tex = device.createTexture({ size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
      device.queue.copyExternalImageToTexture({ source: frame }, { texture: tex, colorSpace: cs }, [W, H]);
      sum(await readTex(device, tex, W, H, 190), `${f} copyExternalImage ${cs}`, await readTex(device, tex, W, H, 576));
      tex.destroy();
    } catch (e) { note(`copyExternalImage ${cs}`, e); }
    for (const cs of ['srgb', 'display-p3', 'rec2020'] as const) try {
      const c = new OffscreenCanvas(W, H), x = c.getContext('2d', { colorSpace: cs, colorType: 'float16' } as unknown as CanvasRenderingContext2DSettings) as OffscreenCanvasRenderingContext2D;
      const a = (x as unknown as { getContextAttributes(): unknown }).getContextAttributes() as unknown as Record<string, unknown>;
      x.drawImage(frame, 0, 0);
      const d = x.getImageData(0, 190, W, 1, { pixelFormat: 'rgba-float16' } as unknown as ImageDataSettings).data as unknown as ArrayLike<number>;
      const g = x.getImageData(0, 576, W, 1, { pixelFormat: 'rgba-float16' } as unknown as ImageDataSettings).data as unknown as ArrayLike<number>;
      const k = d instanceof Uint8ClampedArray ? 255 : 1;
      sum(Array.from({ length: W }, (_, i) => d[i * 4 + 1]! / k), `${f} canvas float16 ${cs} (${a.colorSpace}/${a.colorType}/${(d as object).constructor.name})`, Array.from({ length: W }, (_, i) => g[i * 4 + 1]! / k));
      const tex = device.createTexture({ size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
      device.queue.copyExternalImageToTexture({ source: c }, { texture: tex }, [W, H]);
      sum(await readTex(device, tex, W, H, 190), `${f} canvas float16 ${cs} → webgpu`, await readTex(device, tex, W, H, 576));
      tex.destroy();
    } catch (e) { note(`canvas float16 ${cs}`, e); }
    for (const fmt of ['RGB10_A2', 'RGBA16F'] as const) try {
      const gl = new OffscreenCanvas(4, 4).getContext('webgl2')!;
      gl.getExtension('EXT_color_buffer_float');
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (fmt === 'RGB10_A2') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, frame as unknown as TexImageSource);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, frame as unknown as TexImageSource);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const a = new Float32Array(W * 4), b = new Float32Array(W * 4);
      if (fmt === 'RGBA16F') { gl.readPixels(0, 190, W, 1, gl.RGBA, gl.FLOAT, a); gl.readPixels(0, 576, W, 1, gl.RGBA, gl.FLOAT, b); } else {
        const u = new Uint32Array(W), v = new Uint32Array(W);
        gl.readPixels(0, 190, W, 1, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, u);
        gl.readPixels(0, 576, W, 1, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, v);
        for (let i = 0; i < W; i++) { a[i * 4 + 1] = ((u[i]! >> 10) & 1023) / 1023; b[i * 4 + 1] = ((v[i]! >> 10) & 1023) / 1023; }
      }
      sum(Array.from({ length: W }, (_, i) => a[i * 4 + 1]!), `${f} webgl ${fmt} err ${gl.getError()}`, Array.from({ length: W }, (_, i) => b[i * 4 + 1]!));
    } catch (e) { note(`webgl ${fmt}`, e); }
    for (const format of ['P010', 'I420P10', 'NV12P10', 'RGBA']) try {
      const o = { format } as unknown as VideoFrameCopyToOptions;
      const buf = new Uint8Array(frame.allocationSize(o));
      const lay = await frame.copyTo(buf, o);
      out[`${f} copyTo ${format}`] = `yes ${buf.length} ${JSON.stringify(lay)}`;
    } catch (e) { note(`copyTo ${format}`, e); }
    frame.close();
  }
  return out;
}

/** A grey ramp made in memory, described with a colour space, as the GPU sees it. */
export async function memoryRamp(colorSpace: VideoColorSpaceInit): Promise<Float32Array> {
  const W = 256, H = 16, buf = new Uint8Array(W * H * 1.5).fill(128);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = x;
  const f = new VideoFrame(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: 0, colorSpace });
  const px = await gpuPixels(f, W, H);
  f.close();
  return px;
}

export async function colorFacts() {
  const out: Record<string, unknown> = {};
  for (const [n, cs] of [['709', { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }], ['709 full', { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true }], ['2020/709', { primaries: 'bt2020', transfer: 'bt709', matrix: 'bt2020-ncl', fullRange: false }], ['hlg', { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false }], ['srgb', { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false }]] as [string, VideoColorSpaceInit][]) {
    const px = await memoryRamp(cs);
    out[`memory ${n}`] = [32, 64, 128, 192, 225].map((c) => [r3(cs.fullRange ? c / 255 : (c - 16) / 219), r3(px[(8 * 256 + c) * 3 + 1]!)]);
  }
  for (const n of ['GX010133.MP4', 'GS010120.360', 'GS010004.360', 'GS010004.mp4']) {
    const path = (await ace.listFixtures()).find((x) => x.endsWith(n))!;
    const { frame } = await decodeOne(path);
    out[n] = [frame.format, `${frame.colorSpace.primaries}/${frame.colorSpace.transfer}/${frame.colorSpace.matrix}/${frame.colorSpace.fullRange ? 'full' : 'limited'}`];
    frame.close();
  }
  {
    const path = (await ace.listFixtures()).find((x) => x.endsWith('GS010004.mp4'))!;
    for (const [n, cs] of [['plain', undefined], ['full', { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true }], ['full, srgb', { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true }]] as [string, VideoColorSpaceInit | undefined][]) {
      const { frame } = await decodeOne(path, cs, 300);
      const px = await gpuPixels(frame, 512, 256);
      const v = [...px].sort((a, b) => a - b);
      out[`range ${n}`] = [`${frame.format} ${frame.colorSpace.transfer} ${frame.colorSpace.fullRange}`, [0.01, 0.05, 0.1, 0.3, 0.5, 0.9, 0.99].map((f) => r3(v[Math.floor(f * v.length)]!)), v.filter((x) => x <= 0.0001).length / v.length];
      frame.close();
    }
  }
  // Is a preview copy the same colour as the original?
  {
    const path = (await ace.listFixtures()).find((x) => x.endsWith('c8-709.mp4'))!, m = await getMedia(path);
    setPreviewLevel(2, [m]);
    await proxiesIdle();
    const src = previewSource(m), t = src.tracks[0]!;
    const key = t.samples[0]!;
    const data = await src.reader.read(key.offset, key.size);
    const f = await new Promise<VideoFrame>((res, rej) => { const d = new VideoDecoder({ output: res, error: rej }); d.configure(decoderConfig(t)); d.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data })); void d.flush(); });
    const a = await gpuPixels(f, 1024, 576), o = await decodeOne(path), b = await gpuPixels(o.frame, 1024, 576);
    out.proxy = { space: `${f.colorSpace.primaries}/${f.colorSpace.transfer}/${f.colorSpace.matrix}/${f.colorSpace.fullRange}`, pairs: [64, 128, 256, 512, 768, 900].map((x) => [r3(b[(95 * 1024 + x) * 3 + 1]!), r3(a[(95 * 1024 + x) * 3 + 1]!)]) };
    f.close();
    o.frame.close();
    setPreviewLevel(1, [m]);
  }
  // GoPro's own rendering of a Flat 360 recording against the recording itself: the whole sphere's
  // brightness distribution doesn't depend on how either is turned.
  {
    const all = await ace.listFixtures();
    const A = await getMedia(all.find((x) => x.endsWith('GS010004.360'))!), B = await getMedia(all.find((x) => x.endsWith('GS010004.mp4'))!);
    const N = 160, cv = new OffscreenCanvas(N, N), r = await ReframeRenderer.create(cv);
    const read = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true })!;
    const hist = async (m: typeof A, t: number) => {
      const { frames, close } = await framesAt(m, t);
      r.setLayout(m.layout);
      const h = [0, 1, 2].map(() => new Float64Array(256));
      for (const [yaw, pitch] of [[0, 0], [90, 0], [180, 0], [270, 0], [0, 90], [0, -90]] as const) {
        r.resetHistory();
        r.pushFrame({ frames: frames as [VideoFrame, VideoFrame], mode: '360', view: { yaw, pitch, roll: 0, fov: 90, fisheye: 0 } });
        presentLook(r, { ...DEFAULT_LOOK } as Look);
        read.drawImage(await createImageBitmap(cv), 0, 0);
        const d = read.getImageData(0, 0, N, N).data;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          const a = (x / N) * 2 - 1, b = (y / N) * 2 - 1, w = (1 + a * a + b * b) ** -1.5, i = (y * N + x) * 4;
          for (let k = 0; k < 3; k++) h[k]![d[i + k]!]! += w;
        }
      }
      close();
      return h;
    };
    const sumH = [0, 1, 2].map(() => [new Float64Array(256), new Float64Array(256)]);
    for (const s of [5, 60, 130, 220, 300, 400]) {
      const [a, b] = [await hist(A, s * 1e6), await hist(B, s * 1e6)];
      for (let k = 0; k < 3; k++) for (let i = 0; i < 256; i++) { sumH[k]![0]![i]! += a[k]![i]!; sumH[k]![1]![i]! += b[k]![i]!; }
    }
    const q = (h: Float64Array, f: number) => { const tot = h.reduce((x, y) => x + y, 0); let c = 0; for (let i = 0; i < 256; i++) { c += h[i]!; if (c >= f * tot) return i; } return 255; };
    out.goproRender = [0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98].map((f) => `${f}: ${[0, 1, 2].map((k) => `${q(sumH[k]![0]!, f)}→${q(sumH[k]![1]!, f)}`).join('  ')}`);
    r.destroy();
  }
  return out;
}

const S = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The scene in the test clips' bottom third: linear Rec.709 light (see ten.swift). */
const PATCHES: Rgb[] = [...[0, 0.005, 0.02, 0.05, 0.18, 0.36, 0.7, 1.0].map((v): Rgb => [v, v, v]), [0.4, 0.05, 0.05], [0.05, 0.4, 0.05], [0.05, 0.05, 0.4], [0.4, 0.4, 0.05], [0.3, 0.15, 0.1], [0.1, 0.2, 0.5], [0.02, 0.1, 0.03], [0.5, 0.45, 0.4]];

export async function colorCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  setPrefs(defaultPrefs());
  const all = await ace.listFixtures();
  const open = async (end: string) => getMedia(all.find((f) => f.endsWith(end))!);
  const W = 2048, H = 1152;
  const cv = new OffscreenCanvas(W, H), r = await ReframeRenderer.create(cv);
  const read = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
  const base = (m: Media, o: Partial<TimelineClip> = {}): TimelineClip => ({ ...newClip(m.path, m.durationUs, m.is360), ...o, id: `c${Math.random()}` });
  const lk = (o: Partial<Look['grade']> = {}, blur = 0): Look => ({ ...DEFAULT_LOOK, motionBlur: blur, grade: { ...DEFAULT_LOOK.grade, ...o } });
  const draw = async (m: Media, c: TimelineClip, look: Look = lk(), frames?: VideoFrame[]) => {
    const got = frames ? null : await framesAt(m, 0.2 * S);
    r.setLayout(m.layout);
    pushClipFrame(r, c, m, 0.2 * S, frames ?? got!.frames);
    presentLook(r, look, { time: 12345 });
    read.drawImage(await createImageBitmap(cv), 0, 0);
    got?.close();
    return read.getImageData(0, 0, W, H).data;
  };
  const patch = (d: Uint8ClampedArray, i: number, y = 960): Rgb => {
    const x0 = Math.round(((i + 0.5) * W) / 16), a = [0, 0, 0];
    for (let dy = -20; dy < 20; dy++) for (let dx = -20; dx < 20; dx++) for (let k = 0; k < 3; k++) a[k]! += d[((y + dy) * W + x0 + dx) * 4 + k]! / 1600;
    return a.map((v) => v / 255) as Rgb;
  };
  ok('what the browser does was measured', ordinaryGamma() > 1.9 && ordinaryGamma() < 2.02, ordinaryGamma());

  // --- Curves, colours and ranges come out right -------------------------------------------------------------
  const og = ordinaryGamma(), gain = 2 ** LOG_EV;
  const shown = (l: Rgb): Rgb => browserSees(l.map((v) => rec709Encode(v * gain)) as Rgb, { gamma: og, browserWide: false }).map((v) => Math.max(0, shoulder(v))) as Rgb;
  for (const [file, o] of [['c10-gplog-709tag.mp4', { inputColor: 'gplog' }], ['c10-gplog-2020tag.mp4', { inputColor: 'gplog' }], ['c10-gplog2-2020tag.mp4', { inputColor: 'gplog2' }], ['c8-flat.mp4', { inputColor: 'flat' }]] as [string, Partial<TimelineClip>][]) {
    const m = await open(file), d = await draw(m, base(m, o));
    const err = PATCHES.map((p, i) => { const w = shown(p), g = patch(d, i); return Math.max(...w.map((v, k) => Math.abs(v - g[k]!))) * 255; });
    ok(`${file}: every patch as the scene was`, Math.max(...err) < 9 && err.reduce((a, b) => a + b) / 16 < 3.2, { worst: +Math.max(...err).toFixed(1), mean: +(err.reduce((a, b) => a + b) / 16).toFixed(1), each: err.map((e) => Math.round(e)).join() });
    const flat = await draw(m, base(m, { inputColor: 'raw' }));
    const e2 = PATCHES.map((p, i) => { const b = file.includes('flat') ? 113 : file.includes('gplog2') ? 600 : 400, w = file.includes('2020') ? [[0.627404, 0.329283, 0.043313], [0.069097, 0.91954, 0.011362], [0.016391, 0.088013, 0.895595]].map((q) => q[0]! * p[0] + q[1]! * p[1] + q[2]! * p[2]) : p; const g = patch(flat, i); return Math.max(...w.map((v, k) => Math.abs(logEncode(v, b) - g[k]!))) * 255; });
    ok(`${file}: unconverted gives the recorded values`, Math.max(...e2) < 4, +Math.max(...e2).toFixed(1));
  }
  {
    const m = await open('c10-hlg.mp4');
    ok('HLG is recognised', resolvedInput(m, base(m)) === 'hlg' && m.color!.wide, m.color);
    const d = await draw(m, base(m));
    const enc = (e: number) => { const a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a); return e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - b) + c; };
    const M = [[0.627404, 0.329283, 0.043313], [0.069097, 0.91954, 0.011362], [0.016391, 0.088013, 0.895595]];
    const err = PATCHES.map((p, i) => { const v = M.map((q) => enc(q[0]! * p[0] + q[1]! * p[1] + q[2]! * p[2])) as Rgb; const w = convertInput(v, { ...PLAIN_INPUT, curve: 'hlg', outGamma: og }).map((x) => Math.max(0, shoulder(x))), g = patch(d, i); return Math.max(...w.map((x, k) => Math.abs(x - g[k]!))) * 255; });
    ok('HLG: every patch right', Math.max(...err) < 9, { worst: +Math.max(...err).toFixed(1), each: err.map((e) => Math.round(e)).join() });
  }
  {
    const m = await open('c8-709.mp4'), { frames, close } = await framesAt(m, 0.2 * S);
    ok('an ordinary clip is not touched', !needsConversion(inputFor(m, base(m), frames[0]!)!) && resolvedInput(m, base(m)) === 'standard');
    close();
    for (const n of ['GX010133.MP4', 'GS010120.360', 'virtual-wide.mp4']) { const q = await open(n), f = await framesAt(q, 0.2 * S); ok(`${n} is not touched`, !needsConversion(inputFor(q, base(q), f.frames[0]!)!), [q.color, q.camera.colorProfile]); f.close(); }
  }

  // --- Highlights, banding ------------------------------------------------------------------------------------------
  {
    const m = await open('c10-gplog-709tag.mp4'), c = base(m, { inputColor: 'gplog' });
    const d = await draw(m, c), low = await draw(m, c, lk({ exposure: -2 }));
    const top = patch(d, 7)[1], next = patch(d, 6)[1], l7 = patch(low, 7)[1], l6 = patch(low, 6)[1];
    ok('highlights are eased in, not cut', top < 1.001 && top > next && next > patch(d, 5)[1], [patch(d, 5)[1], next, top]);
    ok('and come back when darkened', l7 - l6 > 0.05 && l7 < 0.97, [l6, l7]);
    const g = await draw(m, base(m, { inputColor: 'gplog' }), lk({ exposure: 4 }));
    // Averages over many rows of a slow gradient must rise smoothly, without steps.
    const col: number[] = [];
    for (let x = 200; x < 1850; x++) { let a = 0; for (let y = 430; y < 720; y++) a += g[(y * W + x) * 4 + 1]!; col.push(a / 290); }
    const fit = (i: number) => { let a = 0, n = 0; for (let k = Math.max(0, i - 60); k <= Math.min(col.length - 1, i + 60); k++) { a += col[k]!; n++; } return a / n; };
    let step = 0;
    for (let i = 60; i < col.length - 60; i++) step = Math.max(step, Math.abs(col[i]! - fit(i)));
    // (The browser decodes to 8 bits: four stops up, one recorded step is about 3.6 of 255.)
    ok('a dark gradient pushed four stops has steps under 2 of 255', step < 2, { worstStepOf255: +step.toFixed(2), range: [Math.round(col[0]!), Math.round(col.at(-1)!)] });
    out['gradient levels'] = new Set(col.map((v) => v.toFixed(1))).size;
  }
  {
    // A LUT that changes nothing must change nothing.
    const m = await open('c8-709.mp4'), n = 33, data = new Float32Array(n ** 3 * 3);
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let q = 0; q < n; q++) data.set([q / (n - 1), g / (n - 1), b / (n - 1)], (b * n * n + g * n + q) * 3);
    const a = (await draw(m, base(m))).slice();
    r.setLut({ size: n, data });
    const b = await draw(m, base(m));
    r.setLut(null);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    ok('a neutral LUT changes nothing', worst <= 1, worst);
  }
  {
    const m = await open('GX010133.MP4');
    r.setLayout(null);
    for (const b of [0, 1, 0.4]) { for (let i = 0; i < 10; i++) { const f = await framesAt(m, 0.2 * S + i * 16_700); pushClipFrame(r, base(m, { inputColor: 'flat' }), m, 0.2 * S + i * 16_700, f.frames); presentLook(r, lk({}, b)); f.close(); } }
    ok('motion blur works with more bits', r.historyFilled >= 4, r.historyFilled);
  }

  // --- Preview copies look like the originals -------------------------------------------------------------------------------
  for (const n of ['c8-709.mp4', 'c10-709.mp4', 'c10-hlg.mp4', 'c10-gplog-2020tag.mp4', 'c10-gplog-709tag.mp4', 'GX010133.MP4', 'GS010004.mp4']) {
    const m = await open(n), c = base(m, /gplog/.test(n) ? { inputColor: 'gplog' } : {});
    if (m.durationUs > 60 * S) continue;
    const a = (await draw(m, c)).slice();
    setPreviewLevel(2, [m]);
    await proxiesIdle();
    const src = previewSource(m), fr: VideoFrame[] = [];
    for (const t of src.tracks) {
      const s0 = t.samples.filter((x) => x.isSync && x.timestamp <= 0.2 * S).at(-1)!, i0 = t.samples.indexOf(s0), want = t.samples.filter((x) => x.timestamp <= 0.2 * S + 500).sort((x, y) => y.timestamp - x.timestamp)[0]!.timestamp;
      const list = await Promise.all(t.samples.slice(i0, i0 + 24).map(async (x) => new EncodedVideoChunk({ type: x.isSync ? 'key' : 'delta', timestamp: x.timestamp, data: await src.reader.read(x.offset, x.size) })));
      fr.push(await new Promise<VideoFrame>((res, rej) => { const dec = new VideoDecoder({ output: (f) => (f.timestamp === want ? res(f) : f.close()), error: rej }); dec.configure(decoderConfig(t)); list.forEach((x) => dec.decode(x)); void dec.flush(); }));
    }
    const b = await draw(m, c, lk(), fr);
    fr.forEach((f) => f.close());
    const mean = [0, 0, 0];
    let abs = 0;
    for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { mean[k]! += (b[i + k]! - a[i + k]!) / (a.length / 4); abs += Math.abs(b[i + k]! - a[i + k]!) / ((a.length / 4) * 3); }
    ok(`preview copy of ${n} looks the same`, src.level === 2 && Math.max(...mean.map(Math.abs)) < 1.6 && abs < 4, { tint: mean.map((v) => +v.toFixed(2)), difference: +abs.toFixed(2) });
    setPreviewLevel(1, [m]);
  }

  // --- GoPro's cloud 360 MP4: full range said only in the container ---------------------------------------------------------------
  {
    const A = await open('GS010004.360'), B = await open('GS010004.mp4');
    ok('its range is noticed, and only there', !!B.color?.rangeFix && !A.color?.rangeFix && !(await open('c10-709full.mp4')).color?.rangeFix && !(await open('c8-709.mp4')).color?.rangeFix, [A.color, B.color]);
    const dark = async (m: Media) => {
      let black = 0, sum = 0;
      for (const t of [60, 220, 400]) { const f = await framesAt(m, t * S); r.setLayout(m.layout); r.resetHistory(); pushClipFrame(r, base(m, { stabilize: { smoothing: 'off', horizon: false }, look: { ...DEFAULT_LOOK, fov: 300, fisheye: 0.4 } }), m, t * S, f.frames); presentLook(r, lk()); read.drawImage(await createImageBitmap(cv), 0, 0); f.close(); const d = read.getImageData(0, 0, W, H).data; for (let i = 0; i < d.length; i += 64) { const v = d[i + 1]!; sum += v; if (v < 3 && Math.abs(((i / 4) % W) - W / 2) < H * 0.3) black++; } }
      return { black, mean: sum / ((W * H * 3) / 16) };
    };
    const a = await dark(A), b = await dark(B);
    ok('its shadows are no longer crushed', b.black < 600 + a.black * 2 && Math.abs(b.mean - a.mean) < 22, { '.360': a, '.mp4': b });
  }

  // --- Exports match the preview -----------------------------------------------------------------------------------------------------
  {
    const m = await open('c10-gplog-709tag.mp4'), c = base(m, { inputColor: 'gplog' });
    const a = (await draw(m, c)).slice(), path = await ace.selftestOut('color.mp4');
    await exportTimeline(addClip(emptyTimeline(), c), { path, resolution: 1080, fps: 30, codec: 'avc', quality: 'max' }, () => {}, new AbortController().signal);
    const x = await getMedia(path), b = await draw(x, base(x));
    const err = PATCHES.map((_, i) => Math.max(...patch(a, i).map((v, k) => Math.abs(v - patch(b, i)[k]!))) * 255);
    const plain = await open('c8-709.mp4');
    await exportTimeline(addClip(emptyTimeline(), base(plain)), { path: await ace.selftestOut('color709.mp4'), resolution: 1080, fps: 30, codec: 'hevc', quality: 'max' }, () => {}, new AbortController().signal);
    ok('the export looks like the preview', Math.max(...err) < 5, err.map((e) => +e.toFixed(1)));
  }

  // --- In the app ------------------------------------------------------------------------------------------------------------------------
  const log = await open('c10-gplog-709tag.mp4');
  await api.importPaths([log.path]);
  api.setTimeline(addClip(emptyTimeline(), base(log)));
  await sleep(800);
  const tab = document.querySelector('.dock-tab[data-panel="color"]')!.getBoundingClientRect();
  for (const type of ['mouseDown', 'mouseUp']) await ace.selftestInput({ type, x: Math.round(tab.left + tab.width / 2), y: Math.round(tab.top + tab.height / 2), button: 'left', clickCount: 1 });
  await sleep(400);
  let sel = document.querySelector<HTMLSelectElement>('select[aria-label="Input color"]');
  if (!sel) { [...document.querySelectorAll<HTMLElement>('[data-panel-body="color"] *')].find((e) => e.textContent === 'Input color' && !e.children.length)?.click(); await sleep(300); sel = document.querySelector('select[aria-label="Input color"]'); }
  ok('the color panel has Input color', !!sel);
  const grab = async () => { await sleep(350); const f = document.querySelector('.frame canvas.layer') as HTMLCanvasElement; const o = new OffscreenCanvas(64, 36), x = o.getContext('2d')!; await api.nextRender(); x.drawImage(await createImageBitmap(f), 0, 0, 64, 36); return [...x.getImageData(18, 30, 1, 1).data.slice(0, 3)]; };
  const before = await grab();
  if (sel) {
    sel.value = 'gplog';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const after = await grab();
    ok('choosing GP-Log changes the picture at once', api.getTimeline().clips[0]!.inputColor === 'gplog' && Math.abs(after[1]! - before[1]!) > 10, [before, after]);
    await ace.capture('color-input');
    await ace.selftestInput({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] });
    await ace.selftestInput({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] });
    await sleep(300);
    ok('undo', api.getTimeline().clips[0]!.inputColor === undefined);
  }

  // --- What it costs -----------------------------------------------------------------------------------------------------------------------
  for (const [n, o] of [['GX010133.MP4', {}], ['GX010133.MP4', { inputColor: 'flat' }], ['GS010083.360', {}], ['GS010083.360', { inputColor: 'flat' }], ['GS010083.360', { inputColor: 'flat', look: { ...DEFAULT_LOOK, motionBlur: 1 } }]] as [string, Partial<TimelineClip>][]) {
    const m = await open(n);
    api.setTimeline(addClip(emptyTimeline(), base(m, o)));
    api.player.seek(0);
    await sleep(1200);
    const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
    let k = 0;
    api.player.play();
    while (performance.now() - w0 < 4000) { await api.nextRender(); k++; await sleep(0); }
    api.player.pause();
    const t = performance.now() - w0, speed = (api.player.time - p0) / 1000 / t;
    ok(`plays in real time: ${n} ${o.inputColor ?? 'as recorded'}${o.look ? ' + motion blur' : ''}`, speed > 0.95, { speed: +speed.toFixed(3), stalls: api.player.stalls - s0, drawnPerS: Math.round((k * 1000) / t) });
  }
  ok('no errors', !errors.length, errors);
  r.destroy();
  return { fails, ...out };
}

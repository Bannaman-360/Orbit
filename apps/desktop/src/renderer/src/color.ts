// What a file's recorded values mean: from its tags, the camera's notes and the clip's setting.

import { avcFullRange, type VideoTrackInfo } from '@ace/engine';
import { browserSees, LOG_BASE, LOG_EV, PLAIN_INPUT, sharedDevice, type InputColor } from '@ace/media360';
import type { InputChoice, TimelineClip } from '@ace/project';
import type { CameraInfo } from '@ace/telemetry';
import type { Media } from './media';

export interface MediaColor {
  bits: number;
  /** As the browser reports it: bt709, hlg, pq, iec61966-2-1… */
  transfer: string;
  /** Tagged with Rec.2020 colours. */
  wide: boolean;
  /** Full-range values that decoders take for video range (said only in the container). */
  rangeFix: boolean;
}

export function mediaColor(frame: VideoFrame, track: VideoTrackInfo): MediaColor {
  const cs = frame.colorSpace;
  const bits = /^h(vc|ev)1\.[A-C]?2\b/i.test(track.codec) || /^av01.*\.10\b/.test(track.codec) || /^vp09\.02/.test(track.codec) ? 10 : 8;
  const full = !!track.colr?.full && !cs.fullRange && /^avc/.test(track.codec) && !!track.description && avcFullRange(track.description) === undefined;
  return { bits, transfer: cs.transfer ?? 'bt709', wide: (cs.primaries as string | null) === 'bt2020', rangeFix: full };
}
/** Whether a preview copy must be made with the recorded values (a plain drawing would convert them). */
export const specialColor = (c: MediaColor | undefined) => !!c && (c.bits > 8 || c.wide || c.rangeFix || !['bt709', 'smpte170m', 'iec61966-2-1', 'bt2020-10'].includes(c.transfer));

// --- What this computer's browser does to ordinary video --------------------------------------------
const MAC_GAMMA = 1.961;
let gamma709 = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? MAC_GAMMA : 0;
let measured: Promise<number> | null = null;
export const ordinaryGamma = () => gamma709;

/** Measures it once, with a little clip of known greys through the same decoder footage uses. */
export function measureBrowser(): Promise<number> {
  return (measured ??= Promise.race([measure(), new Promise<null>((r) => setTimeout(() => r(null), 4000))]).then((g) => { if (g !== null) gamma709 = g; return gamma709; }).catch(() => gamma709));
}

async function measure(): Promise<number | null> {
  const W = 640, H = 368, N = 16;
  const buf = new Uint8Array(W * H * 1.5).fill(128);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = 16 + Math.round((219 * Math.floor((x * N) / W)) / (N - 1));
  const src = new VideoFrame(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } });
  const chunks: EncodedVideoChunk[] = [];
  let config: VideoDecoderConfig | null = null;
  const enc = new VideoEncoder({ output: (c, m) => { chunks.push(c); config ??= m?.decoderConfig ?? null; }, error: () => {} });
  enc.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 8_000_000, framerate: 30, avc: { format: 'avc' } });
  enc.encode(src, { keyFrame: true });
  src.close();
  await enc.flush();
  enc.close();
  if (!config || !chunks.length) return null;
  const frame = await new Promise<VideoFrame>((res, rej) => {
    const d = new VideoDecoder({ output: res, error: rej });
    d.configure({ ...(config as VideoDecoderConfig), hardwareAcceleration: 'prefer-hardware' });
    d.decode(chunks[0]!);
    void d.flush().then(() => d.close(), rej);
    setTimeout(() => rej(new Error('timeout')), 3000);
  });
  try {
    if ((frame.colorSpace.transfer ?? 'bt709') !== 'bt709') return null;
    const seen = await greys(frame, N);
    let best = 0, err = Infinity;
    for (let g = 0; g <= 2.7; g = g === 0 ? 1.6 : g + 0.005) {
      let e = 0;
      for (let i = 0; i < N; i++) { const v = i / (N - 1); e = Math.max(e, Math.abs(browserSees([v, v, v], { gamma: g, browserWide: false })[0] - seen[i]!)); }
      if (e < err) { err = e; best = g; }
    }
    return err < 0.02 ? (Math.abs(best - MAC_GAMMA) < 0.03 ? MAC_GAMMA : best) : null;
  } finally {
    frame.close();
  }
}

/** The grey of each of `n` vertical bands, as a shader sees it. */
async function greys(frame: VideoFrame, n: number): Promise<number[]> {
  const device = await sharedDevice();
  const code = `
    @group(0) @binding(0) var s : sampler; @group(0) @binding(1) var t : texture_external;
    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f { var p = array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.); }
    @fragment fn fs(@builtin(position) p : vec4f) -> @location(0) vec4f { return textureSampleBaseClampToEdge(t, s, vec2f(p.x / ${n}.0, 0.5)); }`;
  const m = device.createShaderModule({ code });
  const pipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] } });
  const tex = device.createTexture({ size: [n, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const out = device.createBuffer({ size: Math.max(256, n * 16), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: device.createSampler() }, { binding: 1, resource: device.importExternalTexture({ source: frame }) }] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bind);
  pass.draw(3);
  pass.end();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: out, bytesPerRow: 256 }, [n, 1]);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const f = new Float32Array(out.getMappedRange());
  const g = Array.from({ length: n }, (_, i) => f[i * 4 + 1]!);
  out.unmap();
  out.destroy();
  tex.destroy();
  return g;
}

// --- A clip's setting -------------------------------------------------------------------------------------
export type ResolvedInput = Exclude<InputChoice, 'auto'>;

/** What "Auto" means for a file. Flat is left as it is: GoPro's own software shows it that way. */
export function autoInput(color: MediaColor | undefined, camera: CameraInfo): ResolvedInput {
  const p = camera.colorProfile ?? '';
  if (/log\s*2/i.test(p)) return 'gplog2';
  if (/log/i.test(p)) return 'gplog';
  if (color?.transfer === 'hlg') return 'hlg';
  return 'standard';
}
export const resolvedInput = (media: Media, clip: Pick<TimelineClip, 'inputColor'>): ResolvedInput => (!clip.inputColor || clip.inputColor === 'auto' ? autoInput(media.color, media.camera) : clip.inputColor);
/** Whether the camera's colours are Rec.2020 (from the tags, unless the clip says otherwise). */
export const wideColor = (media: Media, clip: Pick<TimelineClip, 'wideColor'>) => clip.wideColor ?? !!media.color?.wide;

const gammaOf = (transfer: string) => (transfer === 'iec61966-2-1' ? 0 : transfer === 'hlg' ? 1 : transfer === 'pq' ? 0 : gamma709);

/** How to read a frame of a clip (undefined: exactly as the browser shows it). */
export function inputFor(media: Media, clip: Pick<TimelineClip, 'inputColor' | 'wideColor'>, frame: VideoFrame): InputColor | undefined {
  const color = media.color;
  if (!color) return undefined;
  // Preview copies hold the recorded values as they are.
  const copy = frame.colorSpace.transfer === 'iec61966-2-1' && color.transfer !== 'iec61966-2-1';
  const own = gammaOf(color.transfer), choice = resolvedInput(media, clip);
  const base: InputColor = { ...PLAIN_INPUT, gamma: copy ? 0 : own, browserWide: color.wide, rangeFix: color.rangeFix && !copy, outGamma: own };
  if (choice === 'standard') return base;
  if (choice === 'raw') return { ...base, curve: 'raw' };
  const to = { ...base, outGamma: gamma709, wide: wideColor(media, clip), dither: 0.5 / 255 };
  return choice === 'hlg' ? { ...to, curve: 'hlg' } : { ...to, curve: 'log', base: LOG_BASE[choice], gain: 2 ** LOG_EV };
}
/** For making a preview copy: the recorded values, unconverted. */
export const copyInput = (media: Media): InputColor => ({ ...PLAIN_INPUT, gamma: gammaOf(media.color!.transfer), browserWide: media.color!.wide, rangeFix: media.color!.rangeFix, curve: 'raw' });

export const INPUT_NAMES: [InputChoice, string][] = [['auto', 'Auto'], ['standard', 'Standard (as recorded)'], ['gplog', 'GP-Log'], ['gplog2', 'GP-Log2'], ['flat', 'Flat / Protune'], ['hlg', 'HLG (HDR)'], ['raw', 'Unconverted, for a camera LUT']];
export const inputName = (c: InputChoice) => INPUT_NAMES.find(([k]) => k === c)?.[1] ?? c;

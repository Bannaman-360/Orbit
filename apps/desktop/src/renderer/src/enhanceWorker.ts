// Runs the picture models away from the screen, on the graphics chip where it can:
// RIFE makes in-between frames, Real-ESRGAN makes a picture 4× bigger and sharper.
// Pictures come and go as RGBA bytes.

import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;

export type EnhanceIn =
  | { kind: 'load'; id: number; rife?: ArrayBuffer; esrgan?: ArrayBuffer; /** For checking: other ways to run it (replaces a loaded RIFE). */ variant?: { layout?: 'NCHW' | 'NHWC'; opt?: 'disabled' | 'basic' | 'extended' | 'all'; ep?: 'webgpu' | 'wasm' } }
  | { kind: 'between'; id: number; a: Uint8ClampedArray; b: Uint8ClampedArray; w: number; h: number; ts: number[] }
  | { kind: 'upscale'; id: number; img: Uint8ClampedArray; w: number; h: number };
export type EnhanceOut =
  | { kind: 'ready'; id: number; ep: string }
  | { kind: 'frames'; id: number; frames: Uint8ClampedArray[] }
  | { kind: 'image'; id: number; img: Uint8ClampedArray; w: number; h: number }
  | { kind: 'error'; id: number; message: string };

let rife: ort.InferenceSession | null = null, esrgan: ort.InferenceSession | null = null, ep = 'webgpu';
const post = (m: EnhanceOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

async function session(bytes: ArrayBuffer, v: { layout?: 'NCHW' | 'NHWC'; opt?: 'disabled' | 'basic' | 'extended' | 'all'; ep?: 'webgpu' | 'wasm' } = {}): Promise<ort.InferenceSession> {
  if (v.ep === 'wasm') { ep = 'wasm'; return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] }); }
  try {
    const s = await ort.InferenceSession.create(new Uint8Array(bytes), { // (NCHW: with the default NHWC layout the graphics-chip version of RIFE's warping goes wrong,
    // and in-between frames come out at the wrong moment. NCHW matches the CPU exactly.)
    executionProviders: [{ name: 'webgpu', preferredLayout: v.layout ?? 'NCHW' }], graphOptimizationLevel: v.opt ?? 'all' });
    ep = 'webgpu';
    return s;
  } catch {
    // No usable graphics chip: slower, but it works.
    ep = 'wasm';
    return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
}

/** RGBA bytes → planar RGB 0–1, padded (edge pixels repeated) to pw × ph. */
function planar(rgba: Uint8ClampedArray, w: number, h: number, pw = w, ph = h): Float32Array {
  const out = new Float32Array(3 * pw * ph), plane = pw * ph;
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, y);
    for (let x = 0; x < pw; x++) {
      const i = (sy * w + Math.min(w - 1, x)) * 4, o = y * pw + x;
      out[o] = rgba[i]! / 255; out[o + plane] = rgba[i + 1]! / 255; out[o + 2 * plane] = rgba[i + 2]! / 255;
    }
  }
  return out;
}
/** Planar RGB 0–1 (pw wide) → RGBA bytes w × h (the top-left part). */
function rgbaOf(p: Float32Array, pw: number, ph: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4), plane = pw * ph;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * pw + x, o = (y * w + x) * 4;
    out[o] = p[i]! * 255 + 0.5; out[o + 1] = p[i + plane]! * 255 + 0.5; out[o + 2] = p[i + 2 * plane]! * 255 + 0.5; out[o + 3] = 255;
  }
  return out;
}

async function between(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, ts: number[]): Promise<Uint8ClampedArray[]> {
  const pw = Math.ceil(w / 64) * 64, ph = Math.ceil(h / 64) * 64;
  const img0 = new ort.Tensor('float32', planar(a, w, h, pw, ph), [1, 3, ph, pw]);
  const img1 = new ort.Tensor('float32', planar(b, w, h, pw, ph), [1, 3, ph, pw]);
  const [n0, n1, nt] = rife!.inputNames;
  const out: Uint8ClampedArray[] = [];
  for (const t of ts) {
    const r = await rife!.run({ [n0!]: img0, [n1!]: img1, [nt!]: new ort.Tensor('float32', Float32Array.of(t), [1, 1, 1, 1]) });
    const f = Object.values(r)[0]!;
    out.push(rgbaOf(f.data as Float32Array, pw, ph, w, h));
    f.dispose();
  }
  return out;
}

/** Tiles of the input this size, overlapping by this much, so big pictures fit. */
const TILE = 480, PAD = 12;
async function upscale(img: Uint8ClampedArray, w: number, h: number): Promise<{ img: Uint8ClampedArray; w: number; h: number }> {
  const S = 4, W = w * S, H = h * S;
  const out = new Uint8ClampedArray(W * H * 4);
  const name = esrgan!.inputNames[0]!;
  for (let ty = 0; ty < h; ty += TILE) for (let tx = 0; tx < w; tx += TILE) {
    // The tile with a margin round it (cut off afterwards, so the seams don't show).
    const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD), x1 = Math.min(w, tx + TILE + PAD), y1 = Math.min(h, ty + TILE + PAD);
    const tw = x1 - x0, th = y1 - y0, plane = tw * th;
    const t = new Float32Array(3 * plane);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = ((y0 + y) * w + x0 + x) * 4, o = y * tw + x;
      t[o] = img[i]! / 255; t[o + plane] = img[i + 1]! / 255; t[o + 2 * plane] = img[i + 2]! / 255;
    }
    const r = await esrgan!.run({ [name]: new ort.Tensor('float32', t, [1, 3, th, tw]) });
    const o = Object.values(r)[0]!, d = o.data as Float32Array, OW = tw * S, OP = OW * th * S;
    const cx0 = (tx - x0) * S, cy0 = (ty - y0) * S, cw = Math.min(TILE, w - tx) * S, ch = Math.min(TILE, h - ty) * S;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (cy0 + y) * OW + cx0 + x, q = ((ty * S + y) * W + tx * S + x) * 4;
      out[q] = d[i]! * 255 + 0.5; out[q + 1] = d[i + OP]! * 255 + 0.5; out[q + 2] = d[i + 2 * OP]! * 255 + 0.5; out[q + 3] = 255;
    }
    o.dispose();
  }
  return { img: out, w: W, h: H };
}

self.onmessage = async (e: MessageEvent<EnhanceIn>) => {
  const m = e.data;
  try {
    if (m.kind === 'load') {
      if (m.rife && (!rife || m.variant)) rife = await session(m.rife, m.variant);
      // (Real-ESRGAN is right with the default layout, and faster with it.)
      if (m.esrgan && !esrgan) esrgan = await session(m.esrgan, { layout: 'NHWC' });
      post({ kind: 'ready', id: m.id, ep });
    } else if (m.kind === 'between') {
      const frames = await between(m.a, m.b, m.w, m.h, m.ts);
      post({ kind: 'frames', id: m.id, frames }, frames.map((f) => f.buffer));
    } else if (m.kind === 'upscale') {
      const r = await upscale(m.img, m.w, m.h);
      post({ kind: 'image', id: m.id, ...r }, [r.img.buffer]);
    }
  } catch (err) {
    post({ kind: 'error', id: m.id, message: (err as Error).message ?? String(err) });
  }
};

// Generates a synthetic GoPro-Max-style .360 file: two HEVC streams laid out with
// goproMaxLayout and painted with a latitude/longitude grid. If the player and
// shader agree with the layout, reframed views show straight, continuous grid lines
// across every cube seam. This tests our own pipeline end to end before real footage
// is available (it does not prove the layout matches GoPro's).

import { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';
import { directionToStream, goproMaxLayout, streamToDirection, tileWidth, type Vec3 } from '@ace/media360';
import { ace } from './api';

const FACE_TINT: Record<string, [number, number, number]> = {
  front: [70, 120, 200], right: [200, 110, 70], back: [110, 70, 170],
  left: [70, 160, 110], up: [190, 180, 80], down: [120, 120, 120],
};

function paintBase(layout: ReturnType<typeof goproMaxLayout>, stream: number): ImageData {
  const { streamWidth: W, streamHeight: H } = layout;
  const img = new ImageData(W, H);
  const d = img.data;
  const deg = 180 / Math.PI;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dir = streamToDirection(layout, stream, x + 0.5, y + 0.5);
      if (!dir) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 255; d[i + 3] = 255; continue; } // seam: magenta
      const lon = Math.atan2(dir[0], dir[2]) * deg; // 0 = front, +90 = right
      const lat = Math.asin(Math.max(-1, Math.min(1, dir[1]))) * deg;
      const face = layout.tiles.find((t) => t.stream === stream && x >= t.x && x < t.x + tileWidth(t))!.face;
      let [r, g, b] = FACE_TINT[face]!;
      const near = (v: number, step: number, w: number) => Math.abs(v - Math.round(v / step) * step) < w;
      if (near(lon, 15, 0.35) || near(lat, 15, 0.35)) { r *= 0.35; g *= 0.35; b *= 0.35; }
      if (Math.abs(lat) < 0.6) { r = 255; g = 40; b = 40; } // equator: red
      if (Math.abs(lon) < 0.6 && Math.abs(lat) < 80) { r = 40; g = 255; b = 40; } // straight ahead: green
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return img;
}

function drawLabels(ctx: OffscreenCanvasRenderingContext2D, layout: ReturnType<typeof goproMaxLayout>, stream: number) {
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 6;
  ctx.font = `bold ${Math.round(layout.streamHeight / 9)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of layout.tiles.filter((t) => t.stream === stream)) {
    const label = t.face.toUpperCase();
    ctx.strokeText(label, t.x + tileWidth(t) / 2, t.y + t.size * 0.3);
    ctx.fillText(label, t.x + tileWidth(t) / 2, t.y + t.size * 0.3);
  }
}

export interface SynthOptions {
  width?: number;
  height?: number;
  seconds?: number;
  fps?: number;
}

export async function generateSynthetic360(opts: SynthOptions = {}, onProgress?: (p: number) => void): Promise<string> {
  const W = opts.width ?? 4096, H = opts.height ?? 1344, fps = opts.fps ?? 30, seconds = opts.seconds ?? 4;
  const layout = goproMaxLayout(W, H);
  const codec = (await canEncodeVideo('hevc', { width: W, height: H })) ? 'hevc' : 'avc';

  const canvases = [0, 1].map(() => new OffscreenCanvas(W, H));
  const ctxs = canvases.map((c) => c.getContext('2d')!);
  const bases = [0, 1].map((s) => paintBase(layout, s));

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const sources = canvases.map((c) => new CanvasSource(c, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 }));
  for (const s of sources) output.addVideoTrack(s, { frameRate: fps });
  await output.start();

  const total = fps * seconds;
  for (let f = 0; f < total; f++) {
    // A white marker circles the equator at 90°/s, crossing from stream 0 to the back face on stream 1.
    const lon = ((f / fps) * 90 * Math.PI) / 180;
    const marker: Vec3 = [Math.sin(lon), 0, Math.cos(lon)];
    const m = directionToStream(layout, marker);
    for (let s = 0; s < 2; s++) {
      const ctx = ctxs[s]!;
      ctx.putImageData(bases[s]!, 0, 0);
      drawLabels(ctx, layout, s);
      ctx.fillStyle = 'white';
      ctx.font = `bold ${Math.round(H / 14)}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(`stream ${s}  frame ${f}`, 20, H - 40);
      if (m.stream === s) {
        ctx.beginPath();
        ctx.arc(m.x, m.y, H / 30, 0, Math.PI * 2);
        ctx.fill();
      }
      await sources[s]!.add(f / fps, 1 / fps);
    }
    onProgress?.((f + 1) / total);
  }
  await output.finalize();
  const buf = (output.target as BufferTarget).buffer!;
  const { fixtures } = await ace.info();
  return ace.writeFile(`${fixtures}/synthetic/synthetic-${W}x${H}-${codec}.360`, new Uint8Array(buf));
}

/** A short stereo WAV (chord with a beat) for testing the music track. */
export async function generateTone(seconds = 20, sampleRate = 48000): Promise<string> {
  const n = seconds * sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, t: string) => [...t].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); data.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 2, true);
  data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * 4, true); data.setUint16(32, 4, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const beat = Math.exp(-((t * 2) % 1) * 6);
    const v = 0.18 * beat * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
    data.setInt16(44 + i * 4, v * 32767, true);
    data.setInt16(46 + i * 4, v * 32767, true);
  }
  const { fixtures } = await ace.info();
  return ace.writeFile(`${fixtures}/synthetic/test-tone.wav`, new Uint8Array(data.buffer));
}

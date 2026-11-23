// Exports: what is stored in the file (values and their colour label).

import { BufferTarget, Mp4OutputFormat, Output, VideoSample, VideoSampleSource } from 'mediabunny';
import { addClip, DEFAULT_LOOK, emptyTimeline, newClip, newGaugeOverlay, newTextOverlay, type Look } from '@ace/project';
import { ReframeRenderer } from '@ace/media360';
import { ace } from './api';
import { framesAt } from './calib';
import { exportCost, exportTimeline, outputSize } from './exporter';
import { presentLook, pushClipFrame } from './frameRender';
import { getMedia, type Media } from './media';
import { compositeLayers, drawOverlays } from './overlayRender';

/** Does the encoder write the colour label we give it? */
export async function exportTag() {
  const out: Record<string, unknown> = {};
  const W = 640, H = 360;
  for (const codec of ['avc', 'hevc'] as const) {
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const src = new VideoSampleSource({ codec, bitrate: 8e6 });
    output.addVideoTrack(src, { frameRate: 30 });
    await output.start();
    const buf = new Uint8Array(W * H * 4);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { const i = (y * W + x) * 4, v = Math.floor((x / W) * 256); buf[i] = buf[i + 1] = buf[i + 2] = v; buf[i + 3] = 255; }
    for (let n = 0; n < 10; n++) {
      const s = new VideoSample(buf, { format: 'RGBX', codedWidth: W, codedHeight: H, timestamp: n / 30, duration: 1 / 30, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } });
      await src.add(s);
      s.close();
    }
    await output.finalize();
    const path = await ace.selftestOut(`tag-${codec}.mp4`);
    await ace.writeFile(path, new Uint8Array((output.target as BufferTarget).buffer!));
    out[codec] = path;
  }
  return out;
}

/** Exports: right values for players that ignore labels, and still the same picture in the app. */
export async function exportCheck() {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const open = async (n: string) => getMedia(all.find((f) => f.endsWith(n))!);
  const S = 1e6;
  // 1. An untouched clip comes out with its own values (read back by the system's decoder outside the app).
  const ramp = await open('c8-709.mp4');
  await exportTimeline(addClip(emptyTimeline(), newClip(ramp.path, ramp.durationUs, false)), { path: await ace.selftestOut('export-values.mp4'), resolution: 1080, fps: 30, codec: 'hevc', quality: 'max' }, () => {}, new AbortController().signal);
  out.valuesFile = await ace.selftestOut('export-values.mp4');
  // 2. In the app, an export looks like the preview it came from: video, grade, text and a coloured gauge.
  const m = await open('GX010133.MP4');
  const c = { ...newClip(m.path, 3 * S, false), outUs: 3 * S, lensMode: 'source' as const, look: { ...DEFAULT_LOOK, fov: m.lens!.hfov, grade: { ...DEFAULT_LOOK.grade, contrast: 0.2, saturation: 0.2, temperature: 0.2 } } };
  let tl = addClip(emptyTimeline(), c);
  tl = { ...tl, overlays: [{ ...newTextOverlay(0, 3 * S, 'Colour test'), color: '#ff7a1a', size: 0.12, y: 0.3 }, { ...newGaugeOverlay('speed', 0, 3 * S), style: 'digital' }] };
  const path = await ace.selftestOut('export-look.mp4');
  const t0 = performance.now();
  await exportTimeline(tl, { path, resolution: 1080, fps: 30, codec: 'avc', quality: 'max' }, () => {}, new AbortController().signal);
  out.export1080RealtimeFactor = +((3 * 1000) / (performance.now() - t0)).toFixed(2);
  const { width: W, height: H } = outputSize(tl.framing, 1080);
  // What the preview shows at 1.5 s, the same way the screen gets it.
  const cv = new OffscreenCanvas(W, H), r = await ReframeRenderer.create(cv);
  const f = await framesAt(m, 1.5 * S);
  pushClipFrame(r, c, m, f.frames[0]!.timestamp, f.frames);
  presentLook(r, c.look as Look, { time: f.frames[0]!.timestamp });
  const ref = new OffscreenCanvas(W, H), rc = ref.getContext('2d', { willReadFrequently: true })!;
  compositeLayers(rc, W, H, cv, null, null);
  drawOverlays(rc, W, H, tl, f.frames[0]!.timestamp);
  f.close();
  const a = rc.getImageData(0, 0, W, H).data;
  // The export, shown in the app.
  const x: Media = await getMedia(path), g = await framesAt(x, 1.5 * S);
  r.setLayout(null);
  r.resetHistory();
  r.pushFrame({ frames: [g.frames[0]!], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true });
  presentLook(r, DEFAULT_LOOK);
  const shown = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
  shown.drawImage(await createImageBitmap(cv), 0, 0);
  g.close();
  const b = shown.getImageData(0, 0, W, H).data;
  const region = (x0: number, y0: number, x1: number, y1: number) => { let s2 = 0, n = 0, t = [0, 0, 0]; for (let y = y0; y < y1; y++) for (let xx = x0; xx < x1; xx++) { const i = (y * W + xx) * 4; for (let k = 0; k < 3; k++) { s2 += Math.abs(a[i + k]! - b[i + k]!); t[k]! += b[i + k]! - a[i + k]!; } n++; } return { meanDiff: +(s2 / n / 3).toFixed(2), tint: t.map((v) => +(v / n).toFixed(2)) }; };
  const whole = region(0, 0, W, H);
  ok('in the app, an export looks like the preview', whole.meanDiff < 3.2 && whole.tint.every((v) => Math.abs(v) < 1.5), whole);
  const text = region(Math.round(W * 0.3), Math.round(H * 0.24), Math.round(W * 0.7), Math.round(H * 0.36));
  ok('text keeps its colour', text.meanDiff < 4 && text.tint.every((v) => Math.abs(v) < 2.5), text);
  ok('exporting stays faster than real time at 1080p', out.export1080RealtimeFactor as number > 1.5, out.export1080RealtimeFactor);
  out.cost1080 = { readMsPerFrame: +(exportCost.readMs / exportCost.frames).toFixed(1), encodeMsPerFrame: +(exportCost.encodeMs / exportCost.frames).toFixed(1) };
  Object.assign(exportCost, { readMs: 0, encodeMs: 0, frames: 0 });
  const t1 = performance.now();
  await exportTimeline({ ...tl, overlays: [] }, { path: await ace.selftestOut('export-4k.mp4'), resolution: 2160, fps: 30, codec: 'hevc', quality: 'high' }, () => {}, new AbortController().signal);
  out.export4kRealtimeFactor = +((3 * 1000) / (performance.now() - t1)).toFixed(2);
  out.cost4k = { readMsPerFrame: +(exportCost.readMs / exportCost.frames).toFixed(1), encodeMsPerFrame: +(exportCost.encodeMs / exportCost.frames).toFixed(1), totalMsPerFrame: +((performance.now() - t1) / exportCost.frames).toFixed(1) };
  r.destroy();
  return { fails, ...out };
}

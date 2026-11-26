// Sound spectrum gauges: the right bars light for the sound at each moment (clip sound and music),
// all five looks draw, and the preview matches the export. Runs hidden.

import { AudioBufferSource, BufferTarget, CanvasSource, canEncodeAudio, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';
import { addClip, emptyTimeline, GAUGE_STYLES, newAudioClip, newClip, newGaugeOverlay, type Timeline } from '@ace/project';
import { ace } from './api';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { getMedia, getMusic } from './media';
import { drawGaugePreview, overlayBox } from './overlayRender';
import type { EditorApi } from './selftest';
import { loadSpectrum, spectrumColumns, spectrumSource } from './soundSpectrum';
import { bandEdges, barsAt } from './spectrum';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TONES = [100, 1000, 8000];

/** 6 s: 100 Hz, then 1 kHz, then 8 kHz, two seconds each; a plain grey picture. */
async function toneClip(): Promise<string> {
  const { fixtures } = await ace.info();
  const path = `${fixtures}/synthetic/spectrum-tones.mp4`;
  if ((await ace.listFixtures()).some((f) => f.endsWith('synthetic/spectrum-tones.mp4'))) return path;
  const SR = 48000, n = SR * 6;
  const ctx = new OfflineAudioContext(2, n, SR), buf = ctx.createBuffer(2, n, SR);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = 0.4 * Math.sin((2 * Math.PI * TONES[Math.min(2, Math.floor(i / (SR * 2)))]! * i) / SR); }
  const W = 640, H = 360, fps = 30, cv = new OffscreenCanvas(W, H), x = cv.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(cv, { codec: (await canEncodeVideo('avc', { width: W, height: H })) ? 'avc' : 'vp9', bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
  const audio = new AudioBufferSource({ codec: (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: SR })) ? 'aac' : 'opus', bitrate: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  await output.start();
  await audio.add(buf);
  for (let f = 0; f < 6 * fps; f++) { x.fillStyle = '#3a3a3a'; x.fillRect(0, 0, W, H); await video.add(f / fps, 1 / fps); }
  await output.finalize();
  return ace.writeFile(path, new Uint8Array((output.target as BufferTarget).buffer!));
}

interface Pic { w: number; h: number; d: Uint8ClampedArray }
async function readPicture(path: string, crop?: { x: number; y: number; w: number; h: number }, size?: { w: number; h: number }): Promise<Pic> {
  const bmp = await createImageBitmap(new Blob([(await ace.readAll(path)) as Uint8Array<ArrayBuffer>]));
  const c = crop ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const w = size?.w ?? Math.round(c.w), h = size?.h ?? Math.round(c.h);
  const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return { w, h, d: x.getImageData(0, 0, w, h).data };
}
const diff = (a: Pic, b: Pic) => { let s = 0; for (let i = 0; i < a.d.length; i += 4) s += Math.abs(a.d[i]! - b.d[i]!) + Math.abs(a.d[i + 1]! - b.d[i + 1]!) + Math.abs(a.d[i + 2]! - b.d[i + 2]!); return s / (a.w * a.h * 3); };

export async function spectrumCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };

  const path = await toneClip();
  const m = await getMedia(path);
  const t0 = performance.now();
  const cols = await loadSpectrum(path, false);
  out['reading 6 s of sound took (ms)'] = Math.round(performance.now() - t0);
  ok('the clip’s sound is read', !!cols && cols.known.every(Boolean), cols && [cols.steps, cols.known.filter(Boolean).length]);
  const edges = bandEdges();
  const bandOf = (hz: number) => edges.findIndex((e, i) => hz >= e && hz < edges[i + 1]!);
  for (const [i, hz] of TONES.entries()) {
    const { bars } = barsAt(cols, (i * 2 + 1) * S);
    const top = bars.indexOf(Math.max(...bars));
    ok(`at ${i * 2 + 1} s the ${hz} Hz band is the tallest`, Math.abs(top - bandOf(hz)) <= 1 && bars[top]! > 0.6, { tallest: top, want: bandOf(hz), level: +bars[top]!.toFixed(2) });
  }
  // Right after the tone changes, the old band falls back rather than vanishing.
  const after = barsAt(cols, 2.15 * S).bars[bandOf(100)]!;
  ok('bars fall back smoothly after the sound changes', after > 0.3 && after < barsAt(cols, 1.9 * S).bars[bandOf(100)]!, +after.toFixed(2));

  // Listening: music while there is some, else the clip's sound.
  const music = await getMusic(path).catch(() => null);
  let tl: Timeline = { ...addClip(emptyTimeline(), newClip(path, m.durationUs, false)), overlays: [{ ...newGaugeOverlay('spectrum', 0, 6 * S), id: 'sp' }] };
  ok('without music it listens to the clip', spectrumSource(tl, 1 * S, tl.overlays[0]!)?.music === false);
  if (music) {
    tl = { ...tl, audio: [{ ...newAudioClip(path, music.durationUs, 3 * S), inUs: 0 }] };
    const src = spectrumSource(tl, 4 * S, tl.overlays[0]!);
    ok('with music playing it listens to the music, from where the music is', !!src && src.music && Math.abs(src.mediaUs - 1 * S) < 2000, src);
    ok('and can be told to listen to the clip', spectrumSource(tl, 4 * S, { ...tl.overlays[0]!, listen: 'clip' })?.music === false);
    await loadSpectrum(path, true);
    const { bars } = barsAt(spectrumColumns(path, true), 1 * S);
    ok('music is read too', bars[bandOf(100)]! > 0.6, +bars[bandOf(100)]!.toFixed(2));
  } else ok('music can be loaded', false);

  // Every look draws something (sample sound, as in the look picker).
  const looks = GAUGE_STYLES.spectrum;
  const sheet = new OffscreenCanvas(1280, 160 * looks.length), sx = sheet.getContext('2d')!;
  sx.fillStyle = '#20252b'; sx.fillRect(0, 0, sheet.width, sheet.height);
  const empty: string[] = [];
  for (const [i, [style]] of looks.entries()) {
    const o = { ...newGaugeOverlay('spectrum', 0, S), style, x: 0.5, y: (i + 0.5) / looks.length, size: 0.8 / looks.length };
    const c = new OffscreenCanvas(1280, 160 * looks.length), x = c.getContext('2d', { willReadFrequently: true })!;
    drawGaugePreview(x, o, c.width, c.height);
    const b = overlayBox(o, c.width, c.height), px = x.getImageData(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)).data;
    let lit = 0;
    for (let k = 3; k < px.length; k += 4) if (px[k]! > 100) lit++;
    if (lit < (b.w * b.h) / 40) empty.push(style);
    sx.drawImage(c, 0, 0);
  }
  ok('all five looks draw', !empty.length, empty);
  const blob = await sheet.convertToBlob({ type: 'image/png' });
  await ace.writeFile(await ace.selftestOut('spectrum-looks.png'), new Uint8Array(await blob.arrayBuffer()));

  // Preview and export draw the same bars.
  const T = 3.2 * S;
  const tl2: Timeline = { ...addClip(emptyTimeline(), newClip(path, m.durationUs, false)), overlays: [{ ...newGaugeOverlay('spectrum', 0, 6 * S), id: 'sp', size: 0.3, y: 0.6, style: 'bars' }] };
  api.setTimeline(tl2);
  api.player.seek(T);
  for (let i = 0; i < 8; i++) await Promise.race([api.nextRender(), sleep(1500)]);
  await sleep(500);
  const frame = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect();
  const shot = await ace.capture('spectrum-preview');
  const k = (await createImageBitmap(new Blob([(await ace.readAll(shot)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
  const ob = overlayBox(tl2.overlays[0]!, frame.width, frame.height);
  const shown = await readPicture(shot, { x: (frame.left + ob.x) * k, y: (frame.top + ob.y) * k, w: ob.w * k, h: ob.h * k }, { w: 160, h: 50 });
  const f = await framesAt(m, T);
  const layers: LayerFrame[] = [{ clip: tl2.clips[0]!, index: 0, track: 0, media: m, layout: m.layout, level: 1, mediaUs: T, frames: f.frames }];
  const png = await ace.selftestOut('spectrum-export.png');
  await grabFrame(tl2, T, layers, png, 720);
  f.close();
  const ex = await readPicture(png);
  const eb = overlayBox(tl2.overlays[0]!, ex.w, ex.h);
  const exported = await readPicture(png, eb, { w: 160, h: 50 });
  const d = diff(shown, exported);
  ok('the preview and the export draw the same bars', d < 10, +d.toFixed(2));
  return { fails, ...out };
}

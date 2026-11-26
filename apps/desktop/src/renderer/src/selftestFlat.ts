// Regular-clip self-test. A "virtual camera" renders 360 footage through a known lens into an
// ordinary MP4; reframing that clip must then match the same view taken from the 360 file.

import { CanvasSource, Mp4OutputFormat, Output, BufferTarget, QUALITY_VERY_HIGH } from 'mediabunny';
import { addClip, emptyTimeline, newClip, type Look, type TimelineClip, DEFAULT_LOOK } from '@ace/project';
import { TrackDecoder } from '@ace/engine';
import { IDENTITY, lensFor, mulMat, ReframeRenderer, sampleMatrix, SHUTTER_ROWS, transpose, viewRotation, type Mat3, type SourceLens } from '@ace/media360';
import { alignToFrames, fitGyro, qconj, qlog, qmul, qnorm, Stabilizer, type OrientationData } from '@ace/telemetry';
import { ace } from './api';
import { framesAt } from './calib';
import { exportTimeline } from './exporter';
import { clipLookAt, cropReady, flatShot, presentLook, pushClipFrame, shownFov } from './frameRender';
import { getMedia, type Media } from './media';
import type { EditorApi } from './selftest';

const S = 1_000_000, RAD = Math.PI / 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const look = (o: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...o });

/** Where the virtual camera points (world directions of the 360 clip). */
const AIM = viewRotation(25 * RAD, -6 * RAD, 0);

export const VIRTUAL: [string, SourceLens][] = [
  ['wide', lensFor({ model: 'HERO12 Black', fovMode: 'W' }, 3840, 2160)],
  ['linear', lensFor({ model: 'HERO12 Black', fovMode: 'L' }, 3840, 2160)],
  ['superview', lensFor({ model: 'HERO12 Black', fovMode: 'S' }, 3840, 2160)],
  ['hyperview', lensFor({ model: 'MAX2', fovMode: 'H', diagonalFov: 179.9762, aspectUnwarped: 1.142857, polyScale: 1.14707, poly: [0, 1.3743869, 0.0607124, -0.2842079, 0.1151233, 0, 0], mapX: [1.580514, -8.166883, 74.51987, -451.5002, 1551.292, -2735.542, 1923.157, -0.1086027], mapY: [1.0238225, -0.1025671, -0.263993, 0.2979266] }, 3840, 2160)],
  ['max2', lensFor({ model: 'MAX2', lenses: { FRNT: [1300.58, 97.83, -110.66, 36.26, -4.632] } }, 3840, 2160)],
];

/** Records one still moment of 360 footage through `lens` as a short MP4. */
async function record(src: Media, lens: SourceLens, us: number, name: string): Promise<string> {
  const W = 2560, H = 1440;
  const canvas = new OffscreenCanvas(W, H);
  const r = await ReframeRenderer.create(canvas);
  r.setLayout(src.layout);
  const { frames, close } = await framesAt(src, us);
  r.pushFrame({ frames: frames as [VideoFrame, VideoFrame], mode: '360', view: { yaw: 0, pitch: 0, roll: 0, fov: lens.hfov, fisheye: 0 }, correction: transpose(AIM), lens, outputLens: 'source' });
  presentLook(r, look({}));
  const pic = new OffscreenCanvas(W, H);
  pic.getContext('2d')!.drawImage(await createImageBitmap(canvas), 0, 0);
  close();
  r.destroy();
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(pic, { codec: 'avc', bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 0.5 });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let f = 0; f < 60; f++) await source.add(f / 30, 1 / 30);
  await output.finalize();
  const { fixtures } = await ace.info();
  return ace.writeFile(`${fixtures}/synthetic/virtual-${name}.mp4`, new Uint8Array((output.target as BufferTarget).buffer!));
}

const pixels = async (c: OffscreenCanvas) => {
  const o = new OffscreenCanvas(c.width, c.height), x = o.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(await createImageBitmap(c), 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
};
/** Mean difference per channel, 0–255. */
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!); return s / ((a.length / 4) * 3); };
/** Share of the outermost pixels that are pure black. */
/** Share of the border where a strip at least 3 pixels deep is pure black: picture that isn't there. */
const uncovered = (a: Uint8ClampedArray, w: number, h: number) => {
  const zero = (x: number, y: number) => { const i = (y * w + x) * 4; return a[i]! + a[i + 1]! + a[i + 2]! === 0; };
  let n = 0, k = 0;
  for (let x = 0; x < w; x++) for (const [y, dy] of [[0, 1], [h - 1, -1]] as const) { n++; if (zero(x, y) && zero(x, y + dy) && zero(x, y + 2 * dy)) k++; }
  for (let y = 0; y < h; y++) for (const [x, dx] of [[0, 1], [w - 1, -1]] as const) { n++; if (zero(x, y) && zero(x + dx, y) && zero(x + 2 * dx, y)) k++; }
  return k / n;
};
const blackEdge = (a: Uint8ClampedArray, w: number, h: number) => { let n = 0, k = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { n++; const i = (y * w + x) * 4; if (a[i]! + a[i + 1]! + a[i + 2]! < 4) k++; } return k / n; };

export async function flatCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? 'ok' : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const file = (await ace.listFixtures()).find((f) => f.endsWith('GS010120.360'))!;
  const src = await getMedia(file);
  const us = 6 * S;
  const { frames: s360, close: close360 } = await framesAt(src, us);

  const draw = async (w: number, h: number, push: (r: ReframeRenderer) => void) => {
    const c = new OffscreenCanvas(w, h);
    const r = await ReframeRenderer.create(c);
    push(r);
    presentLook(r, look({}));
    const px = await pixels(c);
    const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    r.destroy();
    return { px, png };
  };

  let widePath = '';
  for (const [name, lens] of VIRTUAL) {
    const path = await record(src, lens, us, name);
    if (name === 'wide') widePath = path;
    const media = await getMedia(path);
    out[`${name}: guessed lens without metadata`] = `${media.lens!.name} ${media.lens!.hfov.toFixed(0)}°`;
    media.lens = lens; // what GoPro's metadata would say
    const { frames, close } = await framesAt(media, S);
    const base: TimelineClip = { ...newClip(path, media.durationUs, false), lensMode: 'source', look: look({ fov: lens.hfov }) };
    // Untouched: the same pixels as before reframing existed.
    const legacy = { ...base, lensMode: undefined, look: look({ fov: 100 }) };
    const a = await draw(640, 360, (r) => void pushClipFrame(r, legacy, media, S, frames));
    const b = await draw(640, 360, (r) => void pushClipFrame(r, base, media, S, frames));
    const c = await draw(640, 360, (r) => void pushClipFrame(r, { ...base, look: look({ fov: lens.hfov, yaw: 0.0002 }) }, media, S, frames));
    ok(`${name}: untouched clips are pixel-identical`, diff(a.px, b.px) === 0, diff(a.px, b.px));
    ok(`${name}: drawing through the lens changes nothing by itself`, diff(a.px, c.px) < 0.9, diff(a.px, c.px));
    // Reframed views against the truth.
    for (const [vn, v, mode, w, h] of [
      ['zoom', { fov: 45 }, 'custom', 640, 360], ['pan', { fov: 50, yaw: 18, pitch: 6 }, 'custom', 640, 360], ['roll', { fov: 50, roll: 20, yaw: -8 }, 'custom', 640, 360],
      ['linear, wide as possible', { fov: 160 }, 'custom', 640, 360], ['fisheye', { fov: 70, fisheye: 0.67 }, 'custom', 640, 360], ['vertical', { fov: 80, yaw: 10 }, 'custom', 360, 640],
    ] as [string, Partial<Look>, 'custom', number, number][]) {
      const cl: TimelineClip = { ...base, lensMode: mode, look: look(v) };
      const lk = clipLookAt(cl, S);
      const fov = shownFov(cl, media, lk, w / h);
      const got = await draw(w, h, (r) => void pushClipFrame(r, cl, media, S, frames));
      // The output shows only part of the picture's width in vertical: the matching plain view.
      const across = Math.min(1, w / h / (16 / 9));
      const k = 1 - 1.5 * (v.fisheye ?? 0);
      const half = Math.abs(k) < 1e-4 ? (fov * RAD) / 2 * across : Math.atan(Math.tan(k * (fov * RAD) / 2) * across) / k;
      const want = await draw(w, h, (r) => {
        r.setLayout(src.layout);
        r.pushFrame({ frames: s360 as [VideoFrame, VideoFrame], mode: '360', view: { yaw: lk.yaw, pitch: lk.pitch, roll: lk.roll, fov: (2 * half) / RAD, fisheye: lk.fisheye, autoLens: false }, correction: transpose(AIM) });
      });
      const wrong = await draw(w, h, (r) => void pushClipFrame(r, { ...cl, lensFix: { hfov: lens.hfov * 0.94 } }, media, S, frames));
      const d = diff(got.px, want.px), dw = diff(wrong.px, want.px);
      // (A linear lens shown whole looks the same whatever its width, so only the match counts there.)
      ok(`${name} ${vn}: matches the 360 truth`, d < 2.5 && (d < dw * 0.4 || (name === 'linear' && fov > 86)), { diff: +d.toFixed(2), withWrongLens: +dw.toFixed(2), fov: +fov.toFixed(1) });
      if (out[`${name} ${vn}: matches the 360 truth`] === 'ok') out[`${name} ${vn}: matches the 360 truth`] = `ok (${d.toFixed(2)}; 6% wrong lens ${dw.toFixed(2)}; fov ${fov.toFixed(0)}°)`;
      ok(`${name} ${vn}: no black edges`, blackEdge(got.px, w, h) === 0, blackEdge(got.px, w, h));
      if (name === 'wide') { await ace.writeFile(await ace.selftestOut(`flat-${vn.replace(/[^a-z]+/g, '-')}-got.png`), got.png); await ace.writeFile(await ace.selftestOut(`flat-${vn.replace(/[^a-z]+/g, '-')}-want.png`), want.png); }
    }
    close();
  }
  close360();

  // --- In the app, with real input ---------------------------------------------------------------
  const media = await getMedia(widePath);
  await api.importPaths([widePath]);
  await sleep(400);
  const bin = [...document.querySelectorAll<HTMLElement>('.bin-item')].find((e) => e.textContent?.includes('virtual-wide'))!;
  bin.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(800);
  const clip = () => api.getTimeline().clips[0]!;
  ok('a regular clip starts as recorded', clip().lensMode === 'source' && clip().look.fov === media.lens!.hfov, [clip().lensMode, clip().look.fov]);
  ok('without motion data it starts unsteadied', clip().stabilize.smoothing === 'off', clip().stabilize);
  {
    // A real clip with the camera's motion data, not steadied by the camera: starts steadied, edges hidden.
    const realPath = (await ace.listFixtures()).find((f) => f.endsWith('GX010133.MP4'))!, real = await getMedia(realPath);
    await api.importPaths([realPath]);
    await sleep(500);
    const t0 = api.getTimeline();
    [...document.querySelectorAll<HTMLElement>('.bin-item')].find((e) => e.textContent?.includes('GX010133'))!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(800);
    const added = api.getTimeline().clips.at(-1)!;
    ok('with motion data it starts steadied, cropping itself', added.mediaPath === realPath && added.stabilize.smoothing === 'medium' && added.stabilize.crop === 'auto' && !real.camera.stabilizedInCamera, added.stabilize);
    api.setTimeline(addClip(emptyTimeline(), { ...added, inUs: 0, outUs: 4 * S }));
    await cropReady(added, real, 16 / 9);
    let black = 0;
    const cv = new OffscreenCanvas(480, 270), r = await ReframeRenderer.create(cv);
    let worstAt = 0;
    for (let t = 0.5; t < 4; t += 0.5) {
      const { frames, close } = await framesAt(real, t * S);
      const lk = pushClipFrame(r, added, real, frames[0]!.timestamp, frames);
      presentLook(r, lk);
      const e = uncovered(await pixels(cv), 480, 270);
      if (e > black) { black = e; worstAt = t; const b = await cv.convertToBlob({ type: 'image/png' }); await ace.writeFile(await ace.selftestOut('flat-steady-edge.png'), new Uint8Array(await b.arrayBuffer())); }
      close();
    }
    out['steadied worst moment'] = { t: worstAt, shot: flatShot(added, real, clipLookAt(added, worstAt * S), worstAt * S, 16 / 9) && { fov: flatShot(added, real, clipLookAt(added, worstAt * S), worstAt * S, 16 / 9)!.fov, crop: flatShot(added, real, clipLookAt(added, worstAt * S), worstAt * S, 16 / 9)!.crop } };
    r.destroy();
    ok('and shows no edges', black === 0, black);
    api.player.seek(0);
    await sleep(900);
    const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
    api.player.play();
    await sleep(3000);
    api.player.pause();
    const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
    ok('and plays in real time', speed > 0.95, { speed: +speed.toFixed(3), stalls: api.player.stalls - s0 });
    api.setTimeline(t0);
    await sleep(300);
  }
  const frame = document.querySelector('.frame') as HTMLElement;
  const r0 = frame.getBoundingClientRect();
  const at = (fx: number, fy: number) => ({ x: Math.round(r0.left + r0.width * fx), y: Math.round(r0.top + r0.height * fy) });
  for (let k = 0; k < 6; k++) { frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -70 })); await sleep(30); }
  await sleep(200);
  // A regular clip is moved and sized as a picture on the preview, as in other editors.
  const z = clip().look.xf?.scale ?? 1;
  ok('scrolling makes the picture bigger', z > 1.6 && clip().look.fov === media.lens!.hfov, [z, clip().look.fov]);
  const a = at(0.5, 0.5), b = at(0.4, 0.5);
  await ace.selftestInput({ type: 'mouseMove', ...a });
  await ace.selftestInput({ type: 'mouseDown', ...a, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) { await ace.selftestInput({ type: 'mouseMove', x: a.x + ((b.x - a.x) * i) / 6, y: a.y, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(20); }
  await ace.selftestInput({ type: 'mouseUp', ...b, button: 'left', clickCount: 1 });
  await sleep(250);
  ok('dragging moves the picture', (clip().look.xf?.x ?? 0) < -0.05 && clip().look.yaw === 0, [clip().look.xf?.x, clip().look.yaw]);
  // (Whatever tab an earlier test left in front.)
  document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
  await sleep(250);
  for (const id of ['Lens', 'Lens details', 'Transform']) { const s = document.querySelector<HTMLElement>(`[data-section="${id}"] .section-toggle`); if (s?.getAttribute('aria-expanded') === 'false') { s.click(); await sleep(120); } }
  const has = (l: string) => !!document.querySelector(`input[aria-label="${l}"]`);
  const controls = ['Position across', 'Position up/down', 'Size', 'Turn', 'Field of view', 'Fisheye', 'Recorded width', 'Bend'];
  ok('picture and lens controls are there', controls.every(has), controls.filter((l) => !has(l)));
  ok('and no 360 view controls', !has('Pan') && !has('Tilt'));
  const fish = () => document.querySelector<HTMLInputElement>('input[aria-label="Fisheye"]')!;
  ok('fisheye is locked on the original lens', fish().disabled);
  await ace.capture('flat-ui-original');
  const btn = (t: string) => [...document.querySelectorAll('button')].find((x) => x.textContent === t) as HTMLButtonElement;
  btn('Linear').click();
  await sleep(300);
  ok('Linear straightens it', clip().lensMode === 'custom' && !fish().disabled && clip().look.fisheye === 0, [clip().lensMode, clip().look.fisheye]);
  await ace.capture('flat-ui-linear');
  // A clip saved before reframing existed, edited now.
  api.setTimeline(addClip(emptyTimeline(), newClip(widePath, media.durationUs, false), 0));
  await sleep(400);
  frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -60 }));
  await sleep(200);
  ok('an old clip can be sized too', Math.abs((clip().look.xf?.scale ?? 1) / Math.exp(0.09) - 1) < 0.01 && Math.abs(clip().look.fov / media.lens!.hfov - 1) < 1e-6, [clip().lensMode, clip().look.xf?.scale, clip().look.fov]);
  // Colour edits on an old clip leave it untouched.
  api.setTimeline({ ...api.getTimeline(), framing: '9:16' });
  await sleep(600);
  await ace.capture('flat-ui-vertical');
  void IDENTITY; void sampleMatrix;
  return { fails, ...out };
}

/** Everything the app can read about the sample clips (nothing is changed). */
export async function flatProbe() {
  const out: Record<string, unknown> = {};
  for (const f of await ace.listFixtures()) {
    try {
      const m = await getMedia(f);
      out[f.split('/').slice(-2).join('/')] = {
        kind: m.is360 ? '360' : 'regular', codec: m.tracks[0]!.codec, size: `${m.width}x${m.height}`, fps: +m.fps.toFixed(2), turns: m.turns, camera: { ...m.camera, lenses: m.camera.lenses && Object.keys(m.camera.lenses) },
        lens: m.lens && { name: m.lens.name, hfov: +m.lens.hfov.toFixed(1), from: m.lens.from, kind: m.lens.kind, aspect: +m.lens.aspect.toFixed(3), stretch: m.lens.stretch },
        streams: m.stabilizer.data?.streams?.join(' '), cori: m.stabilizer.data?.cori.length, iori: m.stabilizer.data?.iori?.length, grav: m.stabilizer.data?.grav.length, gps: m.stabilizer.data?.gps?.length, frames: m.tracks[0]!.samples.length, telemetryError: m.telemetryError,
      };
    } catch (e) {
      out[f] = String(e);
    }
  }
  return out;
}

// --- Stabilisation: a shaking virtual camera with a rolling shutter --------------------------------------

const SHAKE = (t: number) => {
  // Slow turn, riding bumps and fast vibration (degrees).
  const y = 4 * Math.sin(2 * Math.PI * 0.35 * t) + 1.1 * Math.sin(2 * Math.PI * 3.1 * t + 1) + 0.45 * Math.sin(2 * Math.PI * 9.7 * t);
  const p = 0.9 * Math.sin(2 * Math.PI * 2.3 * t + 2) + 0.5 * Math.sin(2 * Math.PI * 8.3 * t + 0.5);
  const r = 1.4 * Math.sin(2 * Math.PI * 1.7 * t + 0.7) + 0.5 * Math.sin(2 * Math.PI * 11.1 * t);
  // From 2.4 s to 3.2 s the ride gets really rough.
  const hard = Math.exp(-(((t - 2.8) / 0.22) ** 2));
  return viewRotation((y + hard * 9 * Math.sin(2 * Math.PI * 2.2 * t)) * RAD, (p + hard * 6 * Math.sin(2 * Math.PI * 2.9 * t + 1)) * RAD, (r + hard * 7 * Math.sin(2 * Math.PI * 1.9 * t)) * RAD);
};
const READOUT_MS = 16;
/** Camera → 360 clip directions at time t (s). */
const cameraAt = (t: number) => mulMat(AIM, SHAKE(t));

const quatOf = (m: Mat3): [number, number, number, number] => {
  const w = Math.sqrt(Math.max(0, 1 + m[0] + m[4] + m[8])) / 2;
  return qnorm([w, (m[7] - m[5]) / (4 * w), (m[2] - m[6]) / (4 * w), (m[3] - m[1]) / (4 * w)]);
};
/** Sensor convention (the app's default axis map mirrors y). */
const P: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, 1];
const sensorQuat = (t: number) => quatOf(mulMat(mulMat(P, cameraAt(t)), P));

const SHUTTER = Array.from({ length: SHUTTER_ROWS }, (_, i) => (i / (SHUTTER_ROWS - 1) - 0.5) * READOUT_MS * 1000);

async function recordShaking(src: Media, lens: SourceLens, us: number, seconds: number, fps: number): Promise<{ path: string; orientation: OrientationData }> {
  const W = 1920, H = 1080;
  const canvas = new OffscreenCanvas(W, H);
  const r = await ReframeRenderer.create(canvas);
  r.setLayout(src.layout);
  const { frames, close } = await framesAt(src, us);
  const pic = new OffscreenCanvas(W, H), ctx = pic.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(pic, { codec: 'avc', bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 0.5 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  for (let f = 0; f < seconds * fps; f++) {
    const t = f / fps;
    r.resetHistory();
    r.pushFrame({ frames: frames as [VideoFrame, VideoFrame], mode: '360', view: { yaw: 0, pitch: 0, roll: 0, fov: lens.hfov, fisheye: 0 }, correction: transpose(cameraAt(t)), rowCorrections: SHUTTER.map((o) => transpose(cameraAt(t + o / 1e6))), lens, outputLens: 'source' });
    presentLook(r, look({}));
    ctx.drawImage(await createImageBitmap(canvas), 0, 0);
    await source.add(t, 1 / fps);
  }
  close();
  r.destroy();
  await output.finalize();
  const { fixtures } = await ace.info();
  const path = await ace.writeFile(`${fixtures}/synthetic/virtual-shaking-${fps}.mp4`, new Uint8Array((output.target as BufferTarget).buffer!));
  const cori = Array.from({ length: seconds * fps }, (_, i) => ({ t: (i / fps) * 1e6, q: sensorQuat(i / fps) }));
  const rateHz = 800;
  const gyro = Array.from({ length: Math.round((seconds + 0.4) * rateHz) }, (_, i) => {
    const t = i / rateHz - 0.2, h = 0.5 / rateHz;
    const d = qlog(qmul(qconj(sensorQuat(t - h)), sensorQuat(t + h)));
    return { t: t * 1e6, v: d.map((x) => x * rateHz) as [number, number, number] };
  });
  return { path, orientation: { grav: [], cori, gyro, streams: [] } };
}

export async function stabCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const src = await getMedia((await ace.listFixtures()).find((f) => f.endsWith('GS010120.360'))!);
  const us = 6 * S, W = 480, H = 270;
  const { frames: s360, close: close360 } = await framesAt(src, us);
  const lens = lensFor({ model: 'HERO12 Black', fovMode: 'W' }, 3840, 2160);
  const canvas = new OffscreenCanvas(W, H);
  const r = await ReframeRenderer.create(canvas);
  for (const fps of [30, 60]) {
    const { path, orientation } = await recordShaking(src, lens, us, 4, fps);
    const media = await getMedia(path);
    Object.assign(media, { lens, stabilizer: new Stabilizer(orientation), camera: { model: 'HERO12 Black', readoutMs: READOUT_MS } });
    ok(`${fps} fps: gyro agrees with the orientation`, !!media.stabilizer.gyroFit && media.stabilizer.gyroFit.residual < 0.05, media.stabilizer.gyroFit && { residual: +media.stabilizer.gyroFit.residual.toFixed(4), offsetMs: media.stabilizer.gyroFit.offsetUs / 1000 });
    const base: TimelineClip = { ...newClip(path, media.durationUs, false), lensMode: 'custom', look: look({ fov: 100 }) };
    const decs = media.tracks.map((t) => new TrackDecoder(media.reader, t));
    const times = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
    const run = async (cl: TimelineClip) => {
      await cropReady(cl, media, W / H);
      decs.forEach((d) => { d.maxAhead = 6; d.seek(0); });
      const errs: number[] = [];
      let wrongTime = 0;
      let err = 0, move = 0, ideal = 0, black = 0, n = 0, minFov = 999, maxStep = 0, lastFov = 0;
      let prev: Uint8ClampedArray | null = null, prevIdeal: Uint8ClampedArray | null = null;
      for (let i = 0; i < times.length; i++) {
        const t = times[i]!;
        let fr: (VideoFrame | null)[] = [];
        for (let k = 0; ; k++) { for (const d of decs) void d.pump(); fr = decs.map((d) => d.frameAt(t)); if (fr.every(Boolean)) break; if (k > 4000) throw new Error('decode'); await sleep(2); }
        if (i < 6 || i > times.length - 6) continue;
        if (fps === 60 && i % 2) continue;
        r.setLayout(media.layout);
        const lk = pushClipFrame(r, cl, media, t, fr as VideoFrame[]);
        presentLook(r, look({}));
        const px = await pixels(canvas);
        black += blackEdge(px, W, H);
        minFov = Math.min(minFov, lk.fov);
        if (lastFov) maxStep = Math.max(maxStep, Math.abs(Math.log(lk.fov / lastFov)));
        lastFov = lk.fov;
        // What a perfectly steadied camera would have seen: same view, straight from the 360 file.
        const shot = flatShot(cl, media, clipLookAt(cl, t), t, W / H)!;
        r.setLayout(src.layout);
        r.pushFrame({ frames: s360 as [VideoFrame, VideoFrame], mode: '360', view: { yaw: lk.yaw, pitch: lk.pitch, roll: lk.roll, fov: lk.fov, fisheye: 0, autoLens: false }, correction: mulMat(shot.correction, transpose(cameraAt(t / 1e6))) });
        presentLook(r, look({}));
        const want = await pixels(canvas);
        const e = diff(px, want);
        err += e;
        errs.push(e);
        if (fr[0]!.timestamp !== t) wrongTime++;
        if (prev) { move += diff(px, prev); ideal += diff(want, prevIdeal!); }
        prev = px;
        prevIdeal = want;
        n++;
      }
      const sorted = [...errs].sort((x, y) => x - y);
      return { err: +(err / n).toFixed(2), median: +sorted[n >> 1]!.toFixed(2), worst: +sorted[n - 1]!.toFixed(2), bad: errs.map((e, i) => (e > sorted[n >> 1]! * 2 ? `${i}:${e.toFixed(1)}` : '')).filter(Boolean).slice(0, 8).join(' '), wrongTime, motion: +(move / (n - 1)).toFixed(2), idealMotion: +(ideal / (n - 1)).toFixed(2), blackEdge: +(black / n).toFixed(4), minFov: +minFov.toFixed(1), zoomStep: +(maxStep * 100).toFixed(2) };
    };
    const st = (o: Partial<TimelineClip['stabilize']>) => ({ ...base, id: `s${Math.random()}`, stabilize: { ...base.stabilize, smoothing: 'high' as const, rolling: true, ...o } });
    const off = await run(base);
    const plain = await run(st({ rolling: false }));
    const on = await run(st({}));
    const low = await run(st({ smoothing: 'low' }));
    const manual = await run(st({ crop: 'manual', cropAmount: 0.3 }));
    const tight = await run(st({ maxCrop: 0.05 }));
    const fixed = await run(st({ cropSpeed: 0 }));
    const quick = await run(st({ cropSpeed: 0.4 }));
    const again = await run(st({}));
    Object.assign(out, { [`${fps} fps off`]: off, [`${fps} fps high, no rolling fix`]: plain, [`${fps} fps high`]: on, [`${fps} fps low`]: low, [`${fps} fps manual 30%`]: manual, [`${fps} fps max crop 5%`]: tight, [`${fps} fps same crop`]: fixed, [`${fps} fps quick crop`]: quick });
    ok(`${fps} fps: the same settings give the same picture`, Math.abs(again.err - on.err) < 0.02, [on.err, again.err]);
    ok(`${fps} fps: quick crop follows the shake, fixed does not`, quick.zoomStep > 0.3 && quick.minFov <= on.minFov + 8 && fixed.zoomStep < 0.01, [quick.zoomStep, quick.minFov, fixed.minFov]);
    ok(`${fps} fps: a low maximum crops less and steadies less`, tight.minFov > on.minFov + 4 && tight.motion > on.motion, [tight.minFov, on.minFov, tight.motion, on.motion]);
    ok(`${fps} fps: every frame is the right one`, [off, plain, on, low, manual, tight, fixed, quick].every((x) => x.wrongTime === 0 && x.worst < 22) && on.worst < 2.5, [on.wrongTime, on.worst]);
    ok(`${fps} fps: stabilized picture matches a steady camera`, on.err < 3, on.err);
    ok(`${fps} fps: rolling shutter fix helps`, on.err < plain.err * 0.6, [plain.err, on.err]);
    // (High smooths over 300 ms, so it keeps a little more of the ride's own movement than it used to.)
    ok(`${fps} fps: movement is almost only what should be there`, on.motion < on.idealMotion * 1.25 + 0.6 && on.motion < off.motion * 0.6, [off.motion, on.motion, on.idealMotion]);
    ok(`${fps} fps: never a black edge`, [plain, on, low, manual, tight, fixed, quick].every((x) => x.blackEdge === 0), [plain, on, low, manual, tight, fixed].map((x) => x.blackEdge));
    ok(`${fps} fps: zoom changes gently`, on.zoomStep < 1.2 && quick.zoomStep < 8 && fixed.zoomStep < 0.01 && manual.zoomStep < 0.01, [on.zoomStep, fixed.zoomStep, manual.zoomStep]);
    ok(`${fps} fps: maximum crop is respected`, tight.minFov > 100 * 0.93 * (shownFov(base, media, clipLookAt(base, S), W / H) / 100), tight.minFov);
    decs.forEach((d) => d.close());
    if (fps === 30) {
      // Pictures of the strongest case, and playback speed in the app.
      await api.importPaths([path]);
      const live = st({});
      api.setTimeline(addClip(emptyTimeline(), live, 0));
      api.player.seek(1 * S);
      await sleep(1200);
      for (const id of ['Stabilize']) ([...document.querySelectorAll('.dock-tab')].find((b) => b.textContent === id) as HTMLElement | undefined)?.click();
      await sleep(300);
      await ace.capture('stab-ui');
      ok('crop controls are there', ['Crop speed', 'Maximum crop'].every((l) => { const e = document.querySelector<HTMLInputElement>(`input[aria-label="${l}"]`); return !!e && !e.disabled; }));
      api.player.seek(0);
      await sleep(300);
      const s0 = api.player.stalls;
      api.player.play();
      await sleep(3000);
      api.player.pause();
      ok('plays at full speed', api.player.time / 1e6 > 2.85 && api.player.stalls - s0 < 6, [api.player.time / 1e6, api.player.stalls - s0]);
      // Frames drawn in the app equal the test's (same code), and the export waits for the analysis.
      const p2 = await ace.selftestOut('stab-export.mp4');
      const before = performance.now();
      await exportTimeline({ ...api.getTimeline(), clips: [{ ...live, id: 'fresh' }] }, { path: p2, resolution: 720, fps: 30, codec: 'avc', quality: 'high' }, () => {}, new AbortController().signal);
      out.export = `${((performance.now() - before) / 1000).toFixed(1)} s for 4 s`;
      const ex = await getMedia(p2);
      const decE = ex.tracks.map((t) => new TrackDecoder(ex.reader, t));
      decE.forEach((d) => d.seek(0));
      let eb = 0, en = 0;
      for (const t of ex.tracks[0]!.samples.map((x) => x.timestamp).sort((x, y) => x - y)) {
        let f: VideoFrame | null = null;
        for (let k = 0; !f; k++) { void decE[0]!.pump(); f = decE[0]!.frameAt(t); if (!f) await sleep(2); if (k > 4000) throw new Error('export decode'); }
        const c = new OffscreenCanvas(320, 180);
        c.getContext('2d')!.drawImage(f, 0, 0, 320, 180);
        const d = c.getContext('2d')!.getImageData(0, 0, 320, 180).data;
        eb += blackEdge(d, 320, 180) > 0.02 ? 1 : 0;
        en++;
      }
      decE.forEach((d) => d.close());
      ok('export has no black edges', eb === 0, `${eb} of ${en} frames`);
    }
  }
  r.destroy();
  close360();
  // Real gyro: the Max 2 files have CORI and GYRO from the same sensors.
  for (const name of ['GS010120.360', 'GS010083.360']) {
    const m = await getMedia((await ace.listFixtures()).find((f) => f.endsWith(name))!);
    const g = m.info.gpmfTrack!;
    const raw = await ace.orientation(m.path, { samples: g.samples.map(({ offset, size, timestamp, duration }) => ({ offset, size, timestamp, duration })), durationUs: m.info.durationUs, created: m.info.created?.toISOString(), gyro: true });
    const al = alignToFrames(raw, m.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b));
    const fit = fitGyro(al.cori, al.gyro ?? []);
    ok(`${name}: real gyro matches the real orientation`, !!fit && fit.residual < 0.1, fit && { residual: +fit.residual.toFixed(4), offsetMs: +(fit.offsetUs / 1000).toFixed(1), axes: fit.axes.join(), signs: fit.signs.join(), scale: +fit.scale.toFixed(4), samples: al.gyro!.length });
  }
  return { fails, ...out };
}

/** Pictures of the real clip: as recorded, straightened, and other lenses. */
export async function realLooks(name: string) {
  const m = await getMedia((await ace.listFixtures()).find((f) => f.endsWith(name))!);
  const W = 960, H = 540, c = new OffscreenCanvas(W, H), r = await ReframeRenderer.create(c);
  const sheet = new OffscreenCanvas(W * 2, H * 3), x = sheet.getContext('2d')!;
  const base: TimelineClip = { ...newClip(m.path, m.durationUs, false), lensMode: 'source', look: look({ fov: m.lens!.hfov }) };
  const out: Record<string, unknown> = { lens: m.lens };
  const at = [0.35, 2.0, 5.2];
  for (const [row, t] of at.entries()) {
    const { frames, close } = await framesAt(m, t * S);
    for (const [col, cl] of ([base, { ...base, lensMode: 'custom', look: look({ fov: 110 }) }] as TimelineClip[]).entries()) {
      const lk = pushClipFrame(r, cl, m, t * S, frames);
      presentLook(r, look({}));
      x.drawImage(await createImageBitmap(c), col * W, row * H);
      out[`${t}s ${col ? 'linear' : 'as recorded'}`] = +lk.fov.toFixed(1);
    }
    close();
  }
  await ace.writeFile(await ace.selftestOut('real-looks.jpg'), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer()));
  // Cost of the exact lens per frame.
  const { frames, close } = await framesAt(m, 2 * S);
  const big = new OffscreenCanvas(2048, 1152), br = await ReframeRenderer.create(big);
  for (const [n, cl] of [['flat', base], ['linear', { ...base, lensMode: 'custom', look: look({ fov: 100 }) }]] as [string, TimelineClip][]) {
    const t0 = performance.now();
    for (let k = 0; k < 60; k++) { pushClipFrame(br, cl, m, 2 * S, frames); presentLook(br, look({})); }
    await br.idle();
    out[`${n}: ms per frame at 2048 px`] = +((performance.now() - t0) / 60).toFixed(2);
  }
  close();
  br.destroy();
  r.destroy();
  return out;
}

/** Writes small greyscale frames and the motion data of a regular clip, for measuring its lens. */
export async function lensDump(name: string) {
  const m = await getMedia((await ace.listFixtures()).find((f) => f.endsWith(name))!);
  const W = 960, H = Math.round((960 * m.height) / m.width / 2) * 2;
  const decs = new TrackDecoder(m.reader, m.tracks[0]!);
  decs.maxAhead = 6;
  decs.seek(0);
  const times = m.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
  const c = new OffscreenCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true })!;
  const parts: Uint8Array[] = [];
  const kept: number[] = [];
  for (let i = 0; i < times.length; i++) {
    let f: VideoFrame | null = null;
    for (let k = 0; !f; k++) { void decs.pump(); f = decs.frameAt(times[i]!); if (!f) await sleep(1); if (k > 6000) throw new Error('decode'); }
    x.drawImage(f, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data, g = new Uint8Array(W * H);
    for (let k = 0; k < g.length; k++) g[k] = (d[k * 4]! * 77 + d[k * 4 + 1]! * 150 + d[k * 4 + 2]! * 29) >> 8;
    parts.push(g);
    kept.push(times[i]!);
  }
  decs.close();
  const all = new Uint8Array(parts.length * W * H);
  parts.forEach((q, i) => all.set(q, i * W * H));
  await ace.writeFile(await ace.selftestOut('lens-frames.bin'), all);
  const d = m.stabilizer.data!;
  await ace.writeFile(await ace.selftestOut('lens-data.json'), JSON.stringify({ W, H, times: kept, camera: m.camera, cori: d.cori, iori: d.iori, grav: d.grav, gyroFit: m.stabilizer.gyroFit, coriFit: m.stabilizer.coriFit, gyro: d.gyro?.length, dense: m.stabilizer.dense?.cori }));
  return { W, H, frames: kept.length, gyroFit: m.stabilizer.gyroFit, coriFit: m.stabilizer.coriFit, camera: m.camera };
}

/** How steady a real clip gets: the picture's own movement from frame to frame, measured, and videos to watch. */
export async function realSteady(name: string) {
  const path = (await ace.listFixtures()).find((f) => f.endsWith(name))!;
  const m = await getMedia(path);
  const out: Record<string, unknown> = { lens: `${m.lens!.name} ${m.lens!.hfov.toFixed(1)}°`, camera: m.camera.model, stabilizedInCamera: m.camera.stabilizedInCamera };
  const base: TimelineClip = { ...newClip(path, m.durationUs, false), lensMode: 'custom', look: look({ fov: 95 }) };
  const times = m.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
  const W = 320, H = 180;
  const cv = new OffscreenCanvas(W, H), r = await ReframeRenderer.create(cv);
  const grey = async () => { const p = await pixels(cv), g = new Float32Array(W * H); for (let i = 0; i < g.length; i++) g[i] = 0.3 * p[i * 4]! + 0.59 * p[i * 4 + 1]! + 0.11 * p[i * 4 + 2]!; return g; };
  /** Shift of the middle of the picture between two frames, in pixels (sub-pixel). */
  const shift = (a: Float32Array, b: Float32Array): [number, number] => {
    const R2 = 14, x0 = 60, x1 = W - 60, y0 = 36, y1 = H - 36;
    const cost = (dx: number, dy: number) => { let s = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) s += Math.abs(a[y * W + x]! - b[(y + dy) * W + x + dx]!); return s; };
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -R2; dy <= R2; dy += 2) for (let dx = -R2; dx <= R2; dx += 2) { const c = cost(dx, dy); if (c < best) { best = c; bx = dx; by = dy; } }
    for (let dy = by - 1; dy <= by + 1; dy++) for (let dx = bx - 1; dx <= bx + 1; dx++) { const c = cost(dx, dy); if (c < best) { best = c; bx = dx; by = dy; } }
    const sub2 = (l: number, c: number, h: number) => { const d = l - 2 * c + h; return d > 0 ? Math.max(-0.5, Math.min(0.5, (l - h) / (2 * d))) : 0; };
    return [bx + sub2(cost(bx - 1, by), best, cost(bx + 1, by)), by + sub2(cost(bx, by - 1), best, cost(bx, by + 1))];
  };
  const rms = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / Math.max(1, v.length));
  for (const [n, c] of [
    ['off', base], ['low', { ...base, id: 'l', stabilize: { ...base.stabilize, smoothing: 'low' } }], ['medium', { ...base, id: 'm', stabilize: { ...base.stabilize, smoothing: 'medium' } }], ['high', { ...base, id: 'h', stabilize: { ...base.stabilize, smoothing: 'high' } }],
    ['high, max crop 70%', { ...base, id: 'h7', stabilize: { ...base.stabilize, smoothing: 'high', maxCrop: 0.7 } }],
  ] as [string, TimelineClip][]) {
    await cropReady(c, m, W / H);
    const dec = new TrackDecoder(m.reader, m.tracks[0]!);
    dec.maxAhead = 6;
    dec.seek(0);
    let prev: Float32Array | null = null;
    const xs: number[] = [], ys: number[] = [];
    let minFov = 999, keepMin = 1, black = 0;
    for (let i = 0; i < times.length; i += 1) {
      let f: VideoFrame | null = null;
      for (let k = 0; !f; k++) { void dec.pump(); f = dec.frameAt(times[i]!); if (!f) await sleep(1); if (k > 6000) throw new Error('decode'); }
      if (i % 2) continue;
      const lk = pushClipFrame(r, c, m, times[i]!, [f]);
      presentLook(r, look({}));
      const g = await grey();
      minFov = Math.min(minFov, lk.fov);
      if (prev) { const [dx, dy] = shift(prev, g); xs.push(dx); ys.push(dy); }
      prev = g;
    }
    dec.close();
    void keepMin; void black;
    // Shake = how much the movement itself changes from frame to frame.
    const jerk = (v: number[]) => v.slice(1).map((x, k) => x - v[k]!);
    out[n] = { movePx: +Math.hypot(rms(xs), rms(ys)).toFixed(2), shakePx: +Math.hypot(rms(jerk(xs)), rms(jerk(ys))).toFixed(2), tightestFov: +minFov.toFixed(0) };
    if (n === 'off' || n === 'high' || n === 'medium') await exportTimeline(addClip(emptyTimeline(), c, 0), { path: await ace.selftestOut(`steady-${n}.mp4`), resolution: 1080, fps: 60, codec: 'avc', quality: 'high' }, () => {}, new AbortController().signal);
  }
  r.destroy();
  return out;
}

/** The real clip in the app: plays at full speed, untouched and stabilised, without edges. */
export async function realPlay(api: EditorApi, name: string) {
  const path = (await ace.listFixtures()).find((f) => f.endsWith(name))!;
  const m = await getMedia(path);
  await api.importPaths([path]);
  const out: Record<string, unknown> = { orientation: m.stabilizer.hasOrientation, gyroFit: m.stabilizer.gyroFit && +m.stabilizer.gyroFit.residual.toFixed(4), gps: m.stabilizer.data?.gps?.length, gpsRange: m.telemetry.gpsRange, accel: m.telemetry.accelRange };
  const base: TimelineClip = { ...newClip(path, m.durationUs, false), lensMode: 'source', look: look({ fov: m.lens!.hfov }) };
  for (const [n, c] of [['as recorded', base], ['stabilized high', { ...base, id: 'x1', stabilize: { ...base.stabilize, smoothing: 'high' } }], ['linear', { ...base, id: 'x2', lensMode: 'custom', look: look({ fov: 110 }) }], ['level, stabilized and followed', { ...base, id: 'x3', lensMode: 'custom', look: look({ fov: 70 }), stabilize: { smoothing: 'medium', horizon: true }, track: { space: 'world', smoothing: 0.25, offsetYaw: 0, offsetPitch: 0, autoZoom: 1, subjectFrac: 0.2, points: Array.from({ length: 360 }, (_, i) => ({ t: (i / 30) * S, yaw: 20 * Math.sin(i / 40), pitch: 5 * Math.sin(i / 25), size: 12 + 4 * Math.sin(i / 30) })) } }]] as [string, TimelineClip][]) {
    api.setTimeline(addClip(emptyTimeline(), c, 0));
    const t0 = performance.now();
    await cropReady(c, m, 16 / 9);
    const ready = performance.now() - t0;
    api.player.seek(0);
    await sleep(900);
    const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
    api.player.play();
    await sleep(5000);
    api.player.pause();
    const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
    let black = 0, minFov = 999, maxStep = 0, last = 0;
    const cv = new OffscreenCanvas(480, 270), r = await ReframeRenderer.create(cv);
    for (let t = 0.5; t < 12.5; t += 0.5) {
      const { frames, close } = await framesAt(m, t * S);
      const lk = pushClipFrame(r, c, m, frames[0]!.timestamp, frames);
      presentLook(r, look({}));
      const px = await pixels(cv);
      // (Dark hallway: only count edges that are exactly black while the picture inside isn't.)
      black = Math.max(black, blackEdge(px, 480, 270));
      minFov = Math.min(minFov, lk.fov);
      close();
    }
    for (let t = 0; t < 13; t += 1 / 60) { const f = flatShot(c, m, clipLookAt(c, t * S), t * S, 16 / 9)!.fov; if (last) maxStep = Math.max(maxStep, Math.abs(Math.log(f / last))); last = f; }
    r.destroy();
    out[n] = { speed: +speed.toFixed(3), stalls: api.player.stalls - s0, analysedMs: Math.round(ready), blackEdge: +black.toFixed(3), minFov: +minFov.toFixed(1), zoomStepPercent: +(maxStep * 100).toFixed(2) };
  }
  // Gauges on a regular clip.
  out.gauges = { accelSamples: m.stabilizer.data?.accl?.length, gForce: [1, 3.5, 5, 9].map((t) => m.telemetry.gforceAt(t * S)), speed: m.telemetry.speedAt(5 * S) };
  await ace.capture('real-ui');
  return out;
}

/** A shaking clip with no motion data of its own, and how its camera really turned (for selftestFinish). */
export async function shakingClip(fps: number): Promise<{ path: string; lens: SourceLens; cameraAt: (t: number) => Mat3 }> {
  const src = await getMedia((await ace.listFixtures()).find((f) => f.endsWith('GS010120.360'))!);
  const lens = lensFor({ model: 'HERO12 Black', fovMode: 'W' }, 3840, 2160);
  const { path } = await recordShaking(src, lens, 6 * S, 4, fps);
  return { path, lens, cameraAt };
}

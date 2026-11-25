// Milestone 4, colour and finishing: colour wheels, curves, the HSL qualifier, power windows, film
// looks, noise reduction, the new effects and transitions, the scopes, and stabilising clips
// without motion data from their picture (checked against the camera's true motion). The
// preview and the export agree; grading keeps up with 4K playback.

import {
  addClip, emptyTimeline, newClip, newMask, NEUTRAL_WHEELS, NO_EFFECTS, NEUTRAL_CURVES, DEFAULT_QUALIFIER, qualifierMatte, rgbToHsv, TRANSITIONS, transitionLook, updateClip,
  type Mask, type Qualifier, type Timeline, type TimelineClip, type TransitionKind, type Wheels,
} from '@ace/project';
import { quatToMat, mulMat, transpose, ReframeRenderer, ScopeRenderer, type Mat3 } from '@ace/media360';
import { DEFAULT_AXIS_MAP, orientationAt } from '@ace/telemetry';
import { ace } from './api';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { analysed, canAnalyse, forgetPictureMotion, measureMotion, motionFromPicture } from './flowStab';
import { gradeView } from './gradeView';
import { forgetMedia, getMedia, type Media } from './media';
import { compositeLayers, type CompLayer } from './overlayRender';
import type { EditorApi } from './selftest';
import { shakingClip } from './selftestFlat';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6, DEG = 180 / Math.PI;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

interface Pic { w: number; h: number; d: Uint8ClampedArray }
async function readPicture(path: string, crop?: { x: number; y: number; w: number; h: number }, size?: { w: number; h: number }): Promise<Pic> {
  const bmp = await createImageBitmap(new Blob([(await ace.readAll(path)) as Uint8Array<ArrayBuffer>]));
  const c = crop ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const w = size?.w ?? c.w, h = size?.h ?? c.h;
  const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return { w, h, d: x.getImageData(0, 0, w, h).data };
}
async function canvasPicture(c: OffscreenCanvas): Promise<Pic> {
  const bmp = await createImageBitmap(c);
  const cv = new OffscreenCanvas(c.width, c.height), x = cv.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0);
  return { w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data };
}
const px = (p: Pic, fx: number, fy: number) => { const i = (Math.round(fy * (p.h - 1)) * p.w + Math.round(fx * (p.w - 1))) * 4; return [p.d[i]!, p.d[i + 1]!, p.d[i + 2]!]; };
/** Mean of each channel in a region (frame fractions). */
function mean(p: Pic, x0 = 0, y0 = 0, x1 = 1, y1 = 1): [number, number, number] {
  const s: [number, number, number] = [0, 0, 0]; let n = 0;
  for (let y = Math.round(y0 * p.h); y < Math.round(y1 * p.h); y++) for (let x = Math.round(x0 * p.w); x < Math.round(x1 * p.w); x++) { const i = (y * p.w + x) * 4; s[0] += p.d[i]!; s[1] += p.d[i + 1]!; s[2] += p.d[i + 2]!; n++; }
  return s.map((v) => v / Math.max(1, n)) as [number, number, number];
}
function diff(a: Pic, b: Pic, x0 = 0, y0 = 0, x1 = 1, y1 = 1): number {
  let s = 0, n = 0;
  for (let y = Math.round(y0 * a.h); y < Math.round(y1 * a.h); y++) for (let x = Math.round(x0 * a.w); x < Math.round(x1 * a.w); x++) {
    const i = (y * a.w + x) * 4;
    for (let k = 0; k < 3; k++) s += Math.abs(a.d[i + k]! - b.d[i + k]!);
    n += 3;
  }
  return n ? s / n : 0;
}
/** Mean saturation (max − min) of the picture. */
function saturation(p: Pic): number {
  let s = 0;
  for (let i = 0; i < p.d.length; i += 4) s += Math.max(p.d[i]!, p.d[i + 1]!, p.d[i + 2]!) - Math.min(p.d[i]!, p.d[i + 1]!, p.d[i + 2]!);
  return s / (p.d.length / 4);
}
const angleOf = (m: Mat3) => Math.acos(Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2))) * DEG;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? NaN; };
const P: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, 1];
const toOurs = (q: [number, number, number, number]) => mulMat(mulMat(P, quatToMat(q)), P);

/** A picture made in code, as a video frame. */
function frameOf(draw: (x: OffscreenCanvasRenderingContext2D, w: number, h: number) => void, w = 320, h = 180, t = 0): VideoFrame {
  const c = new OffscreenCanvas(w, h);
  draw(c.getContext('2d')!, w, h);
  return new VideoFrame(c, { timestamp: t });
}

export async function finishCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const gpuErrors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { const s = a.map(String).join(' '); if (/GPU|WGSL|shader/i.test(s)) gpuErrors.push(s.slice(0, 300)); origError(...a); };

  const all = await ace.listFixtures();
  const m: Media = await getMedia(all.find((f) => f.endsWith('GX010133.MP4'))!);
  await api.importPaths([m.path]);
  const T = 2 * S;
  const base = (): TimelineClip => ({ ...newClip(m.path, m.durationUs, false), inUs: 0, outUs: 8 * S });
  const tlOf = (patch: Partial<TimelineClip> = {}): Timeline => addClip(emptyTimeline(), { ...base(), ...patch });
  const grab = async (tl: Timeline, name: string, at = T) => {
    const clip = tl.clips[0]!;
    const f = await framesAt(m, clip.inUs + at);
    const layers: LayerFrame[] = [{ clip, index: 0, track: 0, media: m, layout: m.layout, level: 1, mediaUs: clip.inUs + at, frames: f.frames }];
    const p = await ace.selftestOut(`finish-${name}.png`);
    await grabFrame(tl, at, layers, p, 720);
    f.close();
    return readPicture(p, undefined, { w: 320, h: 180 });
  };
  const plainClip = base();
  const plain = await grab(tlOf(), 'plain');
  const look = plainClip.look;

  // --- Colour wheels ------------------------------------------------------------------------------
  {
    const warm: Wheels = { ...NEUTRAL_WHEELS, gain: { x: 0, y: 0.7, master: 0 } };
    const g = await grab(tlOf({ look: { ...look, wheels: warm } }), 'wheels-gain');
    const [r0, , b0] = mean(plain), [r1, , b1] = mean(g);
    // (Up is red: red rises, green falls a little; blue isn't part of red's push.)
    ok('gain wheel towards red warms the picture', r1 - r0 > 6 && mean(plain)[1] - mean(g)[1] > 2 && Math.abs(b1 - b0) < 3, { before: mean(plain).map(Math.round), after: mean(g).map(Math.round) });
    const lift = await grab(tlOf({ look: { ...look, wheels: { ...NEUTRAL_WHEELS, lift: { x: 0, y: 0, master: 0.6 } } } }), 'wheels-lift');
    const dark = (p: Pic) => { const v: number[] = []; for (let i = 0; i < p.d.length; i += 4) v.push(p.d[i + 1]!); v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.03)]!; };
    ok('lift raises the blacks', dark(lift) - dark(plain) > 15, { before: dark(plain), after: dark(lift) });
  }

  // --- Curves -------------------------------------------------------------------------------------
  {
    const darker = await grab(tlOf({ curves: { ...NEUTRAL_CURVES, master: [[0, 0], [0.5, 0.3], [1, 1]] } }), 'curve-master');
    const lum = (p: Pic) => { const [r, g, b] = mean(p); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    ok('a lowered luma curve darkens the mid-tones', lum(plain) - lum(darker) > 10, { before: Math.round(lum(plain)), after: Math.round(lum(darker)) });
    const grey = await grab(tlOf({ curves: { ...NEUTRAL_CURVES, hueSat: [[0, 0], [0.5, 0]] } }), 'curve-huesat');
    ok('hue vs sat at the bottom takes the colour out', saturation(grey) < saturation(plain) * 0.15, { before: +saturation(plain).toFixed(1), after: +saturation(grey).toFixed(1) });
    const blue = await grab(tlOf({ curves: { ...NEUTRAL_CURVES, b: [[0, 0.15], [1, 1]] } }), 'curve-blue');
    ok('the blue curve changes only blue', mean(blue)[2] - mean(plain)[2] > 10 && Math.abs(mean(blue)[1] - mean(plain)[1]) < 2, { before: mean(plain).map(Math.round), after: mean(blue).map(Math.round) });
  }

  // --- HSL qualifier: picks exactly what the same sums on the CPU pick -------------------------------
  {
    // The picture's most common saturated hue.
    const bins = new Array(36).fill(0);
    for (let i = 0; i < plain.d.length; i += 4) { const [h, s] = rgbToHsv(plain.d[i]! / 255, plain.d[i + 1]! / 255, plain.d[i + 2]! / 255); if (s > 0.2) bins[Math.floor(h * 36) % 36]++; }
    const hue = bins.indexOf(Math.max(...bins)) * 10 + 5;
    const q: Qualifier = { ...DEFAULT_QUALIFIER, hue, hueWidth: 25, sat: [0.2, 1], lum: [0.05, 1], soft: 0.2, exposure: 0, saturation: -1, hueShift: 0 };
    const picked = await grab(tlOf({ qualifier: q }), 'qualifier');
    let inside = 0, insideN = 0, outside = 0, outsideN = 0;
    for (let i = 0; i < plain.d.length; i += 4) {
      const rgb: [number, number, number] = [plain.d[i]! / 255, plain.d[i + 1]! / 255, plain.d[i + 2]! / 255];
      const w = qualifierMatte(rgb, q);
      const sat0 = Math.max(...rgb) - Math.min(...rgb);
      const sat1 = (Math.max(picked.d[i]!, picked.d[i + 1]!, picked.d[i + 2]!) - Math.min(picked.d[i]!, picked.d[i + 1]!, picked.d[i + 2]!)) / 255;
      if (w > 0.95) { inside += sat1 / Math.max(0.01, sat0); insideN++; }
      else if (w < 0.02) { outside += Math.abs(sat1 - sat0); outsideN++; }
    }
    out.qualifierHue = hue;
    ok('the qualifier takes the colour out of what it picks', insideN > 300 && inside / insideN < 0.25, { pixels: insideN, kept: +(inside / Math.max(1, insideN)).toFixed(3) });
    ok('and leaves the other colours alone', outsideN > 300 && outside / outsideN < 0.02, { pixels: outsideN, change: +(outside / Math.max(1, outsideN)).toFixed(4) });
  }

  // --- Power window: a colour mask ---------------------------------------------------------------------
  {
    const win: Mask = { ...newMask('rect', 'grade'), x: 0.5, y: 0.5, w: 0.3, h: 0.3, feather: 0, amount: 1, grade: { exposure: 2, contrast: 0, saturation: 0, temperature: 0 } };
    const lit = await grab(tlOf({ masks: [win] }), 'window');
    const inL = mean(lit, 0.4, 0.4, 0.6, 0.6)[1], inP = mean(plain, 0.4, 0.4, 0.6, 0.6)[1];
    ok('a power window brightens inside its shape', inL - inP > 25, { before: Math.round(inP), after: Math.round(inL) });
    ok('and nowhere else', diff(lit, plain, 0.02, 0.02, 0.3, 0.3) < 1.5, +diff(lit, plain, 0.02, 0.02, 0.3, 0.3).toFixed(2));
  }

  // --- Film looks ---------------------------------------------------------------------------------------
  {
    const mono = await grab(tlOf({ film: { look: 'Silver mono', mix: 1 } }), 'film-mono');
    ok('a black and white film look takes the colour out', saturation(mono) < 3, +saturation(mono).toFixed(2));
    const half = await grab(tlOf({ film: { look: 'Silver mono', mix: 0.5 } }), 'film-half');
    ok('its strength mixes it with the grade', saturation(half) > saturation(plain) * 0.3 && saturation(half) < saturation(plain) * 0.7, { plain: +saturation(plain).toFixed(1), half: +saturation(half).toFixed(1) });
    const teal = await grab(tlOf({ film: { look: 'Teal and orange', mix: 1 } }), 'film-teal');
    const warm = await grab(tlOf({ film: { look: 'Warm print', mix: 1 } }), 'film-warm');
    ok('looks differ from each other', diff(teal, warm) > 2 && diff(teal, plain) > 3 && diff(warm, plain) > 3, { teal: +diff(teal, plain).toFixed(1), warm: +diff(warm, plain).toFixed(1), apart: +diff(teal, warm).toFixed(1) });
  }

  // --- New effects: each changes the picture ---------------------------------------------------------------
  // (This ride is dim, so halation, which only lights round bright edges, is checked below.)
  for (const k of ['bloom', 'vhs', 'shake', 'rgbSplit'] as const) {
    const p = await grab(tlOf({ look: { ...look, fx: { ...NO_EFFECTS, [k]: 0.9 } } }), `fx-${k}`);
    ok(`${k} changes the picture`, diff(p, plain) > 1.2, +diff(p, plain).toFixed(2));
  }
  {
    // A still picture made in code: a white bar on dark grey.
    const W = 320, H = 180;
    const canvas = new OffscreenCanvas(W, H);
    const r = await ReframeRenderer.create(canvas);
    const f = frameOf((x, w, h) => { x.fillStyle = '#202020'; x.fillRect(0, 0, w, h); x.fillStyle = '#ffffff'; x.fillRect(w * 0.45, h * 0.2, w * 0.1, h * 0.6); }, W, H);
    r.pushFrame({ frames: [f], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true });
    f.close();
    r.present({ blendFrames: 1 });
    const still = await canvasPicture(canvas);
    r.present({ blendFrames: 1, fx2: { halation: 1 } });
    const hal = await canvasPicture(canvas);
    const near = px(hal, 0.44, 0.5), was = px(still, 0.44, 0.5);
    ok('halation glows red round bright edges', near[0]! - was[0]! > 12 && near[0]! - near[2]! > 10, { before: was, after: near });
    r.present({ blendFrames: 1, fx2: { shake: 1 }, time: 1.0 });
    const s1 = await canvasPicture(canvas);
    r.present({ blendFrames: 1, fx2: { shake: 1 }, time: 1.25 });
    const s2 = await canvasPicture(canvas);
    ok('shake moves a still picture over time', diff(s1, s2) > 1.5 && diff(s1, still) > 1.5, { apart: +diff(s1, s2).toFixed(2) });
    r.destroy();
  }

  // --- Noise reduction (pictures made in code, so the clean picture is known) -------------------------------
  {
    const W = 320, H = 180;
    let seed = 1;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const clean = (x: OffscreenCanvasRenderingContext2D, w: number, h: number) => {
      const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#4a6078'); g.addColorStop(1, '#b89a70');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.fillStyle = '#101010'; x.fillRect(w / 2, 0, w / 2, h * 0.3);
      x.fillStyle = '#f0f0f0'; x.fillRect(w / 2, h * 0.3, w / 2, h * 0.15);
    };
    const noisy = (t: number, square?: number) => frameOf((x, w, h) => {
      clean(x, w, h);
      if (square !== undefined) { x.fillStyle = '#ffffff'; x.fillRect(square, h * 0.65, 24, 24); }
      const img = x.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) { const n = gauss() * 14, c = gauss() * 6; d[i] = d[i]! + n + c; d[i + 1] = d[i + 1]! + n; d[i + 2] = d[i + 2]! + n - c; }
      x.putImageData(img, 0, 0);
    }, W, H, t);
    const ref = new OffscreenCanvas(W, H); clean(ref.getContext('2d')!, W, H);
    const refPic: Pic = { w: W, h: H, d: ref.getContext('2d')!.getImageData(0, 0, W, H).data };
    const canvas = new OffscreenCanvas(W, H);
    const r = await ReframeRenderer.create(canvas);
    const push = (f: VideoFrame) => { r.pushFrame({ frames: [f], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true }); f.close(); };
    // (Only the part away from the moving square is compared.)
    const err = (p: Pic) => diff(p, refPic, 0, 0, 1, 0.6);
    r.resetHistory();
    for (let i = 0; i < 6; i++) push(noisy(i * 33_000));
    r.present({ blendFrames: 1 });
    const one = await canvasPicture(canvas);
    r.present({ blendFrames: 1, denoise: { spatial: 0, temporal: 1, frames: 6 } });
    const tnr = await canvasPicture(canvas);
    r.present({ blendFrames: 1, denoise: { spatial: 1, temporal: 0, frames: 1 } });
    const snr = await canvasPicture(canvas);
    out.noise = { single: +err(one).toFixed(2), temporal: +err(tnr).toFixed(2), spatial: +err(snr).toFixed(2) };
    ok('noise reduction across frames removes most of the noise', err(tnr) < err(one) * 0.65, out.noise);
    ok('noise reduction in a frame removes noise too', err(snr) < err(one) * 0.75, out.noise);
    // The hard edge between the dark and light blocks stays sharp (10–90% within 3 pixels).
    const col = (p: Pic, x: number) => { let s = 0; for (let y = Math.round(H * 0.33); y < Math.round(H * 0.42); y++) s += p.d[(y * W + x) * 4 + 1]!; return s / Math.round(H * 0.09); };
    const width = (p: Pic) => { const row = Array.from({ length: 24 }, (_, i) => col(p, W / 2 - 12 + i)); const lo = Math.min(...row), hi = Math.max(...row); const a = row.findIndex((v) => v > lo + 0.1 * (hi - lo)), b = row.findIndex((v) => v > lo + 0.9 * (hi - lo)); return b - a; };
    // (The edge here is between the gradient and the white block.)
    ok('and keeps edges sharp', width(snr) <= 3, { edge: width(snr) });
    // Something moving isn't smeared: a white square 12 px further on each frame.
    r.resetHistory();
    for (let i = 0; i < 6; i++) push(noisy(i * 33_000, 40 + i * 16));
    r.present({ blendFrames: 1, denoise: { spatial: 0, temporal: 1, frames: 6 } });
    const moved = await canvasPicture(canvas);
    const now = mean(moved, (40 + 5 * 16 + 4) / W, 0.67, (40 + 5 * 16 + 20) / W, 0.76)[1], before = mean(moved, (40 + 4 * 16 + 2) / W, 0.67, (40 + 4 * 16 + 12) / W, 0.76)[1];
    ok('what moves keeps its place (no ghosts)', now > 200 && before < 190, { now: Math.round(now), whereItWas: Math.round(before) });
    r.destroy();
  }

  // --- Scopes: counts of a picture made in code --------------------------------------------------------------
  {
    const W = 320, H = 180;
    const canvas = new OffscreenCanvas(W, H);
    const r = await ReframeRenderer.create(canvas);
    const scope = await ScopeRenderer.create(new OffscreenCanvas(256, 256));
    const f = frameOf((x, w, h) => { x.fillStyle = 'rgb(200,0,0)'; x.fillRect(0, 0, w / 2, h); x.fillStyle = 'rgb(128,128,128)'; x.fillRect(w / 2, 0, w / 2, h); }, W, H);
    r.pushFrame({ frames: [f], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true });
    f.close();
    r.tap = (t, e) => scope.analyse(t, e);
    r.present({ blendFrames: 1 });
    scope.draw('vector');
    const b = await scope.read();
    const total = 512 * 288;
    const hist = (lv: number, ch = 0) => b.hist[ch * 256 + lv]! + b.hist[ch * 256 + lv - 1]! + b.hist[ch * 256 + lv + 1]!;
    out.scopeCounts = { greyLuma: hist(128), redLuma: hist(43), redChannel: hist(200, 1), peak: b.peak };
    ok('histogram: half the picture is mid grey', Math.abs(hist(128) / total - 0.5) < 0.02, out.scopeCounts);
    ok('histogram: the red half shows in the red channel', Math.abs(hist(200, 1) / total - 0.5) < 0.02 && Math.abs(hist(43) / total - 0.5) < 0.02, out.scopeCounts);
    // Waveform: the left half of the columns has red's brightness, the right half grey's.
    const wave = (lv: number, col: number) => b.wave[lv * 256 + col]! + b.wave[(lv - 1) * 256 + col]! + b.wave[(lv + 1) * 256 + col]!;
    // (Each of the 256 columns gathers two columns of the 512 sampled.)
    ok('waveform: each column at its brightness', wave(43, 30) === 576 && wave(128, 220) === 576, { left: wave(43, 30), right: wave(128, 220) });
    // Vectorscope: grey in the middle, red up and to the left.
    let red = 0, mid = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const n = b.vector[y * 256 + x]!; if (Math.hypot(x - 127.5, y - 127.5) < 3) mid += n; else if (y < 60 && x > 80 && x < 127) red += n; }
    ok('vectorscope: grey in the middle, red towards red', Math.abs(mid / total - 0.5) < 0.02 && Math.abs(red / total - 0.5) < 0.02, { mid, red });
    scope.destroy();
    r.destroy();
  }

  // --- New transitions draw as described ------------------------------------------------------------------------
  {
    const W = 160, H = 90;
    const solid = (c: string) => { const o = new OffscreenCanvas(W, H); const x = o.getContext('2d')!; x.fillStyle = c; x.fillRect(0, 0, W, H); return o; };
    const A = solid('#ff0000'), B = solid('#0000ff');
    const c = new OffscreenCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true })!;
    const shot = (k: TransitionKind, p: number) => { const layers: CompLayer[] = [{ src: A, role: 'out', track: 0 }, { src: B, role: 'in', track: 0 }]; compositeLayers(x, W, H, layers, transitionLook(k, p)); return { w: W, h: H, d: x.getImageData(0, 0, W, H).data } as Pic; };
    const share = (p: Pic, want: 'A' | 'B') => { let n = 0; for (let i = 0; i < p.d.length; i += 4) { const isB = p.d[i + 2]! > 150 && p.d[i]! < 100, isA = p.d[i]! > 150 && p.d[i + 2]! < 100; if (want === 'B' ? isB : isA) n++; } return n / (p.d.length / 4); };
    const kinds = TRANSITIONS.map(([k]) => k);
    const bad: string[] = [];
    for (const k of kinds) {
      const start = shot(k, 0), end = shot(k, 1);
      if (share(end, 'B') < 0.97) bad.push(`${k}: end ${share(end, 'B').toFixed(2)}`);
      if (share(start, 'A') < 0.9 && !['zoom', 'glitch'].includes(k)) bad.push(`${k}: start ${share(start, 'A').toFixed(2)}`);
    }
    ok(`all ${kinds.length} transitions start on the outgoing clip and end on the incoming one`, !bad.length, bad);
    const mids = ['blinds', 'checker', 'diamond', 'star', 'fan', 'split-h', 'corner'] as TransitionKind[];
    const midBad = mids.filter((k) => { const s = share(shot(k, 0.5), 'B'); return s < 0.15 || s > 0.85; });
    ok('the new wipes show both clips half way', !midBad.length, midBad);
    const un = shot('uncover-left', 0.5);
    ok('uncover slides the outgoing clip away over the incoming one', px(un, 0.25, 0.5)[0]! > 200 && px(un, 0.75, 0.5)[2]! > 200, [px(un, 0.25, 0.5), px(un, 0.75, 0.5)]);
  }

  // --- Preview against export, with everything on ---------------------------------------------------------------
  const graded = tlOf({
    look: { ...look, wheels: { ...NEUTRAL_WHEELS, gain: { x: 0.2, y: 0.3, master: 0.1 }, lift: { x: -0.2, y: 0, master: 0.05 } }, fx: { ...NO_EFFECTS, halation: 0.4 } },
    curves: { ...NEUTRAL_CURVES, master: [[0, 0], [0.3, 0.25], [0.7, 0.78], [1, 1]], hueSat: [[0.1, 0.7], [0.6, 0.5]] },
    qualifier: { ...DEFAULT_QUALIFIER, hue: Number(out.qualifierHue) || 200, saturation: 0.4 },
    film: { look: 'Warm print', mix: 0.7 },
    masks: [{ ...newMask('ellipse', 'grade'), x: 0.3, y: 0.6, w: 0.25, h: 0.3, amount: 1, feather: 0.03, grade: { exposure: 1, contrast: 0.2, saturation: 0.3, temperature: 0.3 } }],
  });
  {
    api.setTimeline(graded);
    api.player.seek(T);
    for (let i = 0; i < 8; i++) await Promise.race([api.nextRender(), sleep(1500)]);
    await sleep(400);
    const frame = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect();
    const shotPath = await ace.capture('finish-preview');
    const sx = (await createImageBitmap(new Blob([(await ace.readAll(shotPath)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
    const shown = await readPicture(shotPath, { x: frame.left * sx, y: frame.top * sx, w: frame.width * sx, h: frame.height * sx }, { w: 160, h: 90 });
    await grab(graded, 'preview-ref');
    const small = await readPicture(await ace.selftestOut('finish-preview-ref.png'), undefined, { w: 160, h: 90 });
    const d = diff(shown, small);
    ok('preview and export look the same with every grading tool on', d < 8, +d.toFixed(2));
    ok('and it isn’t just the plain picture', diff(small, await readPicture(await ace.selftestOut('finish-plain.png'), undefined, { w: 160, h: 90 })) > 4);
  }

  // --- Saving ------------------------------------------------------------------------------------------------
  {
    const text = api.saveText!();
    await api.restore!(text);
    await sleep(800);
    const c = api.getTimeline().clips[0]!;
    ok('grading is saved and opened again', !!c.look.wheels && c.curves?.master.length === 4 && !!c.qualifier && c.film?.look === 'Warm print' && c.masks?.[0]?.effect === 'grade' && c.masks[0].grade?.exposure === 1 && c.look.fx.halation === 0.4,
      { wheels: !!c.look.wheels, curves: c.curves?.master.length, q: !!c.qualifier, film: c.film?.look, mask: c.masks?.[0]?.grade });
  }

  // --- The Color panel and the Scopes panel ---------------------------------------------------------------------
  {
    const clickAt = async (el: Element) => { const r = el.getBoundingClientRect(), p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; await ace.selftestInput({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 }); await ace.selftestInput({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 }); };
    api.setTimeline(tlOf());
    api.player.seek(T);
    await sleep(300);
    const tab = document.querySelector('.dock-tab[data-panel="color"]');
    if (tab) { await clickAt(tab); await sleep(400); }
    const open = async (id: string) => { const h = document.querySelector<HTMLElement>(`[data-section="${id}"] .section-toggle`); if (h && h.getAttribute('aria-expanded') !== 'true') { h.click(); await sleep(250); } return !!h; };
    const have = await Promise.all(['Color wheels', 'Color curves', 'Qualifier', 'Noise reduction', 'Film looks'].map(open));
    ok('the Color panel has wheels, curves, qualifier, noise reduction and film looks', have.every(Boolean), have);
    // Drag the gain wheel's dot up (towards red).
    const disc = document.querySelector('[data-wheel="gain"] .wheel-disc');
    disc?.scrollIntoView({ block: 'center' });
    await sleep(200);
    if (disc) {
      const r = disc.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      await ace.selftestInput({ type: 'mouseMove', x, y });
      await ace.selftestInput({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      for (let k = 1; k <= 5; k++) { await ace.selftestInput({ type: 'mouseMove', x, y: y - k * 6, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(20); }
      await ace.selftestInput({ type: 'mouseUp', x, y: y - 30, button: 'left', clickCount: 1 });
      await sleep(300);
    }
    const w = api.getTimeline().clips[0]!.look.wheels;
    ok('dragging a wheel pushes its colour', !!w && w.gain.y > 0.2 && Math.abs(w.gain.x) < 0.1, w?.gain);
    const chip = $$('.film-chip').find((b) => /Slide film/.test(b.textContent ?? ''));
    chip?.click();
    await sleep(300);
    ok('a film look chip sets the look', api.getTimeline().clips[0]!.film?.look === 'Slide film');
    $$('[data-section="Qualifier"] button').find((b) => b.textContent === 'Sky')?.click();
    await sleep(300);
    ok('a qualifier preset starts the qualifier', api.getTimeline().clips[0]!.qualifier?.hue === 210);
    await ace.capture('finish-color-panel');

    api.run!('scopesPanel');
    await sleep(800);
    for (let i = 0; i < 10 && !(gradeView.scopes && gradeView.last); i++) await Promise.race([api.nextRender(), sleep(400)]);
    ok('the Scopes panel reads the preview', !!gradeView.scopes && gradeView.last > 0 && !!document.querySelector('.scopes-panel canvas'));
    for (const k of ['Waveform', 'Parade', 'Vectorscope', 'Histogram']) {
      $$('.scopes-panel .seg button').find((b) => b.textContent === k)?.click();
      await sleep(250);
      await ace.capture(`finish-scope-${k.toLowerCase()}`);
    }
    // Light and dark.
    for (const mode of ['light', 'dark'] as const) {
      document.documentElement.dataset.mode = mode;
      await sleep(250);
      await ace.capture(`finish-panels-${mode}`);
    }
    api.run!('scopesPanel');
    await sleep(300);
  }

  // --- Stabilising a clip without motion data, from its picture -------------------------------------------------
  {
    const shake = await shakingClip(60);
    forgetMedia(shake.path);
    const sm = await getMedia(shake.path);
    Object.assign(sm, { lens: shake.lens });
    await forgetPictureMotion(sm);
    ok('a clip without motion data can be stabilized from its picture', canAnalyse(sm) && !sm.stabilizer.hasOrientation);
    // Through the Stabilize panel, as a rider would.
    await api.importPaths([sm.path]);
    api.setTimeline(addClip(emptyTimeline(), newClip(sm.path, sm.durationUs, false)));
    api.player.seek(1 * S);
    await sleep(500);
    const tab = document.querySelector<HTMLElement>('.dock-tab[data-panel="stabilize"]');
    tab?.click();
    await sleep(400);
    const btn = $$('.picture-motion button').find((b) => /Stabilize from the picture/.test(b.textContent ?? ''));
    ok('the Stabilize panel offers it', !!btn);
    const t0 = performance.now();
    btn?.click();
    for (let i = 0; i < 240 && !analysed(sm, 0, sm.durationUs); i++) await sleep(250);
    const secs = (performance.now() - t0) / 1000;
    await sleep(500);
    const c = api.getTimeline().clips[0]!;
    out.flowTime = { seconds: +secs.toFixed(1), clip: +(sm.durationUs / 1e6).toFixed(1) };
    ok('it works out the motion, then turns stabilization on', motionFromPicture(sm) && sm.stabilizer.hasOrientation && c.stabilize.smoothing === 'medium' && !!c.lensMode, { smoothing: c.stabilize.smoothing, lensMode: c.lensMode, ...out.flowTime as object });
    ok('in about the time the clip lasts, or less', secs < 3 * sm.durationUs / 1e6 + 5, out.flowTime);
    await ace.capture('finish-stabilize-panel');

    // Against how the camera really turned.
    const data = sm.stabilizer.data!;
    const R = (t: number) => toOurs(orientationAt(data, t)!);
    const errs: number[] = [], mags: number[] = [], flips: number[] = [];
    for (let t = 0.2; t <= 3.7; t += 0.05) {
      const a = t * S, b = (t + 0.1) * S;
      const df = mulMat(transpose(R(a)), R(b)), dt = mulMat(transpose(shake.cameraAt(t)), shake.cameraAt(t + 0.1));
      errs.push(angleOf(mulMat(transpose(df), dt)));
      flips.push(angleOf(mulMat(df, dt)));
      mags.push(angleOf(dt));
    }
    const drift = angleOf(mulMat(transpose(mulMat(transpose(R(0.1 * S)), R(3.8 * S))), mulMat(transpose(shake.cameraAt(0.1)), shake.cameraAt(3.8))));
    out.flowAccuracy = { medianErrDeg: +median(errs).toFixed(3), worstErrDeg: +Math.max(...errs).toFixed(3), medianTurnDeg: +median(mags).toFixed(2), ifFlipped: +median(flips).toFixed(2), driftDeg: +drift.toFixed(2) };
    ok('turns from the picture match the camera’s (per 0.1 s)', median(errs) < Math.max(0.15, median(mags) * 0.12), out.flowAccuracy);
    ok('and drift little over the clip', drift < 2.5, out.flowAccuracy);
    // The picture it gives: frame-to-frame turning before and after stabilization.
    const steps = (f: (t: number) => Mat3) => { const v: number[] = []; for (let t = 0.3; t < 3.6; t += 1 / 60) v.push(angleOf(mulMat(transpose(f(t)), f(t + 1 / 60)))); return v.reduce((a, b) => a + b, 0) / v.length; };
    const view = (t: number) => mulMat(shake.cameraAt(t), transpose(sm.stabilizer.correctionAt(t * S, { smoothing: 'medium', horizon: false, axisMap: DEFAULT_AXIS_MAP })));
    const raw = steps(shake.cameraAt), steady = steps(view);
    out.flowSteadiness = { rawDegPerFrame: +raw.toFixed(3), stabilizedDegPerFrame: +steady.toFixed(3) };
    ok('stabilized from the picture, the view turns far less', steady < raw * 0.45, out.flowSteadiness);
    // Kept for next time.
    forgetMedia(sm.path);
    const again = await getMedia(sm.path);
    ok('the worked-out motion is kept for next time', again.stabilizer.hasOrientation && motionFromPicture(again));

    // Real footage with the camera's own motion data: the picture and the gyro agree.
    if (m.stabilizer.hasOrientation) {
      const seg = await measureMotion(m, 1 * S, 3 * S, () => {});
      const Rf = (i: number) => quatToMat([seg.q[i * 4]!, seg.q[i * 4 + 1]!, seg.q[i * 4 + 2]!, seg.q[i * 4 + 3]!]);
      // (Locked: the camera's own turns, in the picture's axes, as stabilization uses them.)
      const Rg = (t: number) => m.stabilizer.correctionAt(t, { smoothing: 'locked', horizon: false, axisMap: DEFAULT_AXIS_MAP });
      const e: number[] = [], mg: number[] = [];
      for (let i = 0; i + 6 < seg.t.length; i += 3) {
        const df = mulMat(transpose(Rf(i)), Rf(i + 6)), dg = mulMat(transpose(Rg(seg.t[i]!)), Rg(seg.t[i + 6]!));
        e.push(angleOf(mulMat(transpose(df), dg)));
        mg.push(angleOf(dg));
      }
      out.flowVsGyro = { camera: m.camera.model, inCamera: m.camera.stabilizedInCamera ?? null, medianErrDeg: +median(e).toFixed(3), medianTurnDeg: +median(mg).toFixed(3), lost: seg.lost, frames: seg.t.length };
      ok('on a real ride, the picture’s turns agree with the gyro', median(e) < median(mg) * 0.25, out.flowVsGyro);
    }
  }

  // --- 4K playback with grading on keeps up ---------------------------------------------------------------------
  const play = async (tl: Timeline, name: string) => {
    api.setTimeline(tl);
    api.player.seek(0.5 * S);
    for (let i = 0; i < 8; i++) await Promise.race([api.nextRender(), sleep(1500)]);
    const st0 = api.player.stalls, seen = new Set<number>();
    api.player.play();
    await sleep(500);
    const t0 = performance.now(), p0 = api.player.time;
    while (performance.now() - t0 < 4000) { await api.nextRender(); const ts = api.lastResult()?.layers?.[0]?.frames[0]?.timestamp; if (ts !== undefined) seen.add(ts); }
    const wall = (performance.now() - t0) / 1000, adv = (api.player.time - p0) / S;
    api.player.pause();
    const r = { source: `${m.width}×${m.height}@${m.fps.toFixed(0)}`, speed: +(adv / wall).toFixed(3), pictures: +(seen.size / wall).toFixed(1), stalls: api.player.stalls - st0 };
    out[`perf${name}`] = r;
    return r;
  };
  {
    const r = await play(graded, 'Grading');
    ok('4K with wheels, curves, qualifier, film look and a power window plays in real time', r.speed > 0.95 && r.pictures > m.fps * 0.85, r);
    const n = await play(tlOf({ denoise: { spatial: 0.6, temporal: 0.6 } }), 'Denoise');
    ok('4K with noise reduction still plays smoothly', n.speed > 0.95 && n.pictures > m.fps * 0.6, n);
  }

  console.error = origError;
  ok('no GPU or shader errors', !gpuErrors.length, gpuErrors.slice(0, 5));
  return { fails, ...out };
}

// Milestone 5, AI tools: smart reframe (and, as they land, auto subtitles, smooth slow motion and
// sharper pictures). Runs hidden; generates its own footage where the right answer is known.

import { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';
import { addClip, emptyTimeline, lookAt, newClip, type Timeline } from '@ace/project';
import { ace } from './api';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { lastShifts, plannedAt, smartReframe } from './smartReframe';
import { openSection } from './ui';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(api: EditorApi, renders = 6) {
  const deadline = performance.now() + 8000;
  for (let i = 0; i < renders; i++) await Promise.race([api.nextRender(), sleep(Math.max(0, deadline - performance.now()))]);
  await sleep(250);
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
/** Where the red subject is in a picture, across (0–1), or null when it isn't there. */
function redAt(p: Pic): number | null {
  let sx = 0, n = 0;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const i = (y * p.w + x) * 4;
    if (p.d[i]! > 180 && p.d[i + 1]! < 90 && p.d[i + 2]! < 90) { sx += x; n++; }
  }
  return n > 3 ? sx / n / p.w : null;
}

/** Where the subject is in the test clip at time t (seconds), across the picture (0–1). */
const subjectX = (t: number) => (t < 1 ? 0.2 : t > 5 ? 0.8 : 0.2 + 0.6 * ((t - 1) / 4));

/**
 * A 6 s 16:9 clip: a textured background the camera pans slowly across, and a red ball that
 * moves from the left to the right between 1 s and 5 s.
 */
async function subjectClip(): Promise<string> {
  const { fixtures } = await ace.info();
  const path = `${fixtures}/synthetic/ai-subject.mp4`;
  if ((await ace.listFixtures()).some((f) => f.endsWith('synthetic/ai-subject.mp4'))) return path;
  const W = 1280, H = 720, fps = 30;
  const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d')!;
  // Background: soft blobs, wider than the picture so the camera can pan.
  const bg = new OffscreenCanvas(W + 400, H), b = bg.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  b.fillStyle = '#6a7a5a';
  b.fillRect(0, 0, bg.width, H);
  for (let i = 0; i < 900; i++) {
    const g = 60 + rnd() * 120;
    b.fillStyle = `rgb(${g * 0.8 | 0},${g | 0},${g * 0.7 | 0})`;
    b.beginPath(); b.arc(rnd() * bg.width, rnd() * H, 4 + rnd() * 22, 0, Math.PI * 2); b.fill();
  }
  const codec = (await canEncodeVideo('avc', { width: W, height: H })) ? 'avc' : 'vp9';
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const src = new CanvasSource(cv, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(src, { frameRate: fps });
  await output.start();
  for (let f = 0; f < fps * 6; f++) {
    const t = f / fps;
    ctx.drawImage(bg, -60 * t, 0);
    ctx.fillStyle = '#e8251c';
    ctx.beginPath(); ctx.arc(subjectX(t) * W, H * 0.55, 46, 0, Math.PI * 2); ctx.fill();
    await src.add(t, 1 / fps);
  }
  await output.finalize();
  return ace.writeFile(path, new Uint8Array((output.target as BufferTarget).buffer!));
}

export async function aiCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };

  // --- Smart reframe: a regular clip into 9:16 -------------------------------------------------
  const path = await subjectClip();
  const m = await getMedia(path);
  const clip0 = { ...newClip(path, m.durationUs, false), fit: 'fit' as const };
  const t0 = performance.now();
  const r = await smartReframe(clip0, m, 9 / 16, () => {}, new AbortController().signal);
  const took = (performance.now() - t0) / 1000;
  out['measured (every 0.5 s: across, sure)'] = (r.raw ?? []).filter((_, i) => i % 5 === 0).map((p) => `${p.v.toFixed(2)},${(p.w ?? 1).toFixed(2)}`).join(' ');
  out['camera shift measured'] = lastShifts.filter((_, i) => i % 5 === 0).join(' ');
  ok('smart reframe follows what moves', r.how === 'motion', r.how);
  ok('and takes less time than the clip lasts', took < 6, +took.toFixed(1));
  // The frame shows 9/16 ÷ 16/9 of the picture's width; the subject must stay inside it.
  const seen = (9 / 16) / (16 / 9), room = 1 - seen;
  const misses: string[] = [];
  for (let t = 0.3; t <= 5.8; t += 0.1) {
    const centre = plannedAt(r, t * S), want = subjectX(t) * 2 - 1;
    if (Math.abs(centre - want) > seen * 0.85) misses.push(`${t.toFixed(1)}s: ${centre.toFixed(2)} vs ${want.toFixed(2)}`);
  }
  ok('the subject stays in the 9:16 frame all the way', !misses.length, misses.slice(0, 6));
  ok('the move is a handful of keyframes', r.keys >= 2 && r.keys <= 16, r.keys);
  ok('nothing outside the picture is shown', (r.planned ?? []).every((p) => Math.abs(p.v) <= room + 1e-6));
  ok('the clip fills the frame', r.patch.fit === 'fill');

  // Through the app: frame shape 9:16, the Inspector button.
  api.setTimeline({ ...addClip(emptyTimeline(), clip0), framing: '9:16' });
  api.player.seek(3 * S);
  await settle(api);
  document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
  openSection('Smart reframe');
  await sleep(300);
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === 'Smart reframe this clip');
  ok('the Reframe panel offers smart reframe', !!button);
  button?.click();
  for (let i = 0; i < 300 && !api.getTimeline().clips[0]!.keyframes.length; i++) await sleep(100);
  const tl: Timeline = api.getTimeline();
  const c = tl.clips[0]!;
  ok('it writes pan keyframes on the clip', c.keyframes.length >= 2 && c.fit === 'fill' && c.keyframes.every((k) => k.look.pan && Math.abs(k.look.pan.x) <= 1), c.keyframes.map((k) => k.look.pan?.x.toFixed(2)));
  ok('the note says what it followed', document.body.textContent?.includes('the frame follows what moves') ?? false);

  // Preview and export both show the ball, in the same place.
  for (const T of [0.5, 3, 5.5]) {
    api.player.seek(T * S);
    await settle(api, 8);
    const frame = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect();
    const shot = await ace.capture(`ai-reframe-preview-${T}`);
    const sx = (await createImageBitmap(new Blob([(await ace.readAll(shot)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
    const prev = redAt(await readPicture(shot, { x: frame.left * sx, y: frame.top * sx, w: frame.width * sx, h: frame.height * sx }));
    const f = await framesAt(m, T * S);
    const layers: LayerFrame[] = [{ clip: c, index: 0, track: 0, media: m, layout: m.layout, level: 1, mediaUs: T * S, frames: f.frames }];
    const png = await ace.selftestOut(`ai-reframe-export-${T}.png`);
    await grabFrame(tl, T * S, layers, png, 720);
    f.close();
    const exp = redAt(await readPicture(png));
    // Where it should be: the pan puts the frame's middle at pan × room on the picture.
    const pan = lookAt(c.keyframes, c.look, T * S).pan?.x ?? 0;
    const want = ((subjectX(T) * 2 - 1 - pan * room) / seen + 1) / 2;
    ok(`at ${T}s the ball is in the frame, where the pan puts it (preview and export)`, exp !== null && prev !== null && Math.abs(exp - want) < 0.05 && Math.abs(prev - exp) < 0.03, { preview: prev?.toFixed(3), export: exp?.toFixed(3), want: want.toFixed(3) });
  }

  // A clip that already has the frame's shape has nothing to pan across.
  const same = await smartReframe(clip0, m, 16 / 9, () => {}, new AbortController().signal);
  ok('a clip already the frame’s shape is left whole', same.how === 'whole' && !same.patch.keyframes, same.how);

  // --- Smart reframe: a 360 clip follows the way it travels -------------------------------------
  const all = await ace.listFixtures();
  const ride = all.find((f) => f.endsWith('max2/GS010004.360'));
  if (ride) {
    const rm = await getMedia(ride);
    const rc = { ...newClip(ride, rm.durationUs, true), inUs: 60 * S, outUs: 90 * S };
    const rr = await smartReframe(rc, rm, 9 / 16, () => {}, new AbortController().signal);
    ok('a 360 ride follows its direction of travel from GPS', rr.how === 'gps', rr.how);
    ok('kept steady and level', rr.patch.stabilize?.smoothing === 'locked' && rr.patch.stabilize.horizon === true);
    // The view turns no faster than about 90° a second (a calm camera).
    const ks = rr.patch.keyframes ?? [];
    let fastest = 0;
    for (let i = 1; i < ks.length; i++) { let d = ks[i]!.look.yaw - ks[i - 1]!.look.yaw; d = ((d + 540) % 360) - 180; fastest = Math.max(fastest, Math.abs(d) / ((ks[i]!.t - ks[i - 1]!.t) / S)); }
    ok('and turns calmly', ks.length >= 2 && fastest < 90, { keys: ks.length, fastest: +fastest.toFixed(1) });
  } else out['360 ride'] = 'skipped (no GS010004.360)';
  return { fails, ...out };
}

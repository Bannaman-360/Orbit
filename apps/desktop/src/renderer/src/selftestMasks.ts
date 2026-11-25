// Masks: blur, pixelate and hide inside (or outside) a shape, soft edges, keyframes, following a
// tracked subject; the preview and the export agree; playing with masks keeps up.

import { addClip, addMaskKey, emptyTimeline, newClip, newMask, setMaskPose, type Mask, type Timeline, type TimelineClip } from '@ace/project';
import { ace } from './api';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { clipLookAt, flatDirection } from './frameRender';
import { subjectInFrame } from './masksRender';
import { getMedia, type Media } from './media';
import type { EditorApi } from './selftest';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6;
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
const px = (p: Pic, fx: number, fy: number) => { const i = (Math.round(fy * (p.h - 1)) * p.w + Math.round(fx * (p.w - 1))) * 4; return [p.d[i]!, p.d[i + 1]!, p.d[i + 2]!]; };
/** Detail in a region (mean difference between neighbouring pixels), frame fractions. */
function detail(p: Pic, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0, n = 0;
  for (let y = Math.round(y0 * p.h); y < Math.round(y1 * p.h) - 1; y++) for (let x = Math.round(x0 * p.w); x < Math.round(x1 * p.w) - 1; x++) {
    const i = (y * p.w + x) * 4;
    s += Math.abs(p.d[i + 1]! - p.d[i + 5]!) + Math.abs(p.d[i + 1]! - p.d[i + 1 + p.w * 4]!);
    n += 2;
  }
  return n ? s / n : 0;
}
/** Mean difference between two pictures in a region. */
function diff(a: Pic, b: Pic, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0, n = 0;
  for (let y = Math.round(y0 * a.h); y < Math.round(y1 * a.h); y += 2) for (let x = Math.round(x0 * a.w); x < Math.round(x1 * a.w); x += 2) {
    const i = (y * a.w + x) * 4;
    for (let k = 0; k < 3; k++) s += Math.abs(a.d[i + k]! - b.d[i + k]!);
    n += 3;
  }
  return n ? s / n : 0;
}
const red = (c: number[]) => c[0]! > 200 && c[1]! < 60 && c[2]! < 60;

export async function masksCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const m: Media = await getMedia(all.find((f) => f.endsWith('GX010133.MP4'))!);
  await api.importPaths([m.path]);
  const T = 2 * S;
  const base = (): TimelineClip => ({ ...newClip(m.path, m.durationUs, false), inUs: 0, outUs: 8 * S });
  const withMasks = (masks: Mask[], c: TimelineClip = base()): Timeline => addClip(emptyTimeline(), { ...c, masks });
  /** The frame at T, as exported (720p), from the file itself. */
  const grab = async (tl: Timeline, name: string, at = T) => {
    const clip = tl.clips[0]!;
    const f = await framesAt(m, clip.inUs + at);
    const layers: LayerFrame[] = [{ clip, index: 0, track: 0, media: m, layout: m.layout, level: 1, mediaUs: clip.inUs + at, frames: f.frames }];
    const p = await ace.selftestOut(`masks-${name}.png`);
    await grabFrame(tl, at, layers, p, 720);
    f.close();
    return readPicture(p);
  };
  const box = (effect: Mask['effect'], extra: Partial<Mask> = {}) => ({ ...newMask('rect', effect), x: 0.5, y: 0.5, w: 0.3, h: 0.3, feather: 0, amount: 1, ...extra });

  const plain = await grab(withMasks([]), 'none');
  // Inside the box: 0.35–0.65 both ways. Measure well inside and well outside it.
  const IN = [0.4, 0.4, 0.6, 0.6] as const, OUT = [0.05, 0.05, 0.3, 0.3] as const;

  const blurred = await grab(withMasks([box('blur')]), 'blur');
  // (Measured on a 4× smaller copy: what counts is the picture's detail, not the blur's fine grain.)
  const quarter = async (n: string) => readPicture(await ace.selftestOut(`masks-${n}.png`), undefined, { w: 320, h: 180 });
  const [pq, bq] = [await quarter('none'), await quarter('blur')];
  ok('blur takes the detail out of the shape', detail(bq, ...IN) < detail(pq, ...IN) * 0.35, { before: +detail(pq, ...IN).toFixed(2), after: +detail(bq, ...IN).toFixed(2) });
  ok('and leaves the rest alone', diff(blurred, plain, ...OUT) < 1.5, +diff(blurred, plain, ...OUT).toFixed(2));

  const pix = await grab(withMasks([box('pixelate')]), 'pixelate');
  ok('pixelate makes blocks in the shape', detail(pix, ...IN) < detail(plain, ...IN) * 0.6 && diff(pix, plain, ...IN) > 2, { detail: +detail(pix, ...IN).toFixed(2), change: +diff(pix, plain, ...IN).toFixed(2) });

  const hidden = await grab(withMasks([box('hide', { color: '#ff0000' })]), 'hide');
  ok('hide fills the shape with its colour', red(px(hidden, 0.5, 0.5)) && !red(px(hidden, 0.2, 0.2)), [px(hidden, 0.5, 0.5), px(hidden, 0.2, 0.2)]);

  const inv = await grab(withMasks([box('hide', { color: '#ff0000', invert: true })]), 'invert');
  ok('inverted, it covers everything outside', red(px(inv, 0.1, 0.1)) && !red(px(inv, 0.5, 0.5)), [px(inv, 0.1, 0.1), px(inv, 0.5, 0.5)]);

  const soft = await grab(withMasks([box('hide', { color: '#ff0000', feather: 0.08 })]), 'feather');
  const edge = px(soft, 0.65, 0.5), core = px(soft, 0.5, 0.5);
  ok('a soft edge blends in gradually', red(core) && edge[0]! < 245 && edge[0]! > 60 && edge[1]! > 20, { edge, core });

  const grown = await grab(withMasks([box('hide', { color: '#ff0000', expand: 0.05 })]), 'expand');
  ok('grow makes the shape bigger', red(px(grown, 0.5, 0.67)) && !red(px(hidden, 0.5, 0.67)), [px(grown, 0.5, 0.67), px(hidden, 0.5, 0.67)]);

  const ell = await grab(withMasks([{ ...box('hide', { color: '#ff0000' }), shape: 'ellipse' }]), 'ellipse');
  ok('an ellipse leaves its corners', red(px(ell, 0.5, 0.5)) && !red(px(ell, 0.37, 0.37)), [px(ell, 0.5, 0.5), px(ell, 0.37, 0.37)]);

  // Keyframes: from the left at 1 s to the right at 3 s → middle at 2 s.
  let moving = { ...box('hide', { color: '#ff0000', w: 0.1, h: 0.1 }), x: 0.2 };
  moving = addMaskKey(moving, 1 * S);
  moving = setMaskPose(moving, 3 * S, { x: 0.8 });
  const mid = await grab(withMasks([moving]), 'keyed');
  ok('keyframes move it', red(px(mid, 0.5, 0.5)) && !red(px(mid, 0.2, 0.5)) && !red(px(mid, 0.8, 0.5)), [px(mid, 0.2, 0.5), px(mid, 0.5, 0.5), px(mid, 0.8, 0.5)]);

  // Follow subject: a track pinned to what is at (70%, 40%) of the picture, not moving the view.
  {
    const c0 = { ...base(), lensMode: 'source' as const, look: { ...base().look, fov: m.lens!.hfov } };
    const t0 = c0.inUs + T;
    const dir = flatDirection(c0, m, clipLookAt(c0, t0), t0, 16 / 9, 0.7 * 2 - 1, 1 - 0.4 * 2)!.world;
    const points = [0, 1, 2, 3, 4, 5, 6].map((s) => ({ t: s * S, yaw: dir.yaw, pitch: dir.pitch }));
    const tracked: TimelineClip = { ...c0, track: { space: 'world', points, smoothing: 0, offsetYaw: 0, offsetPitch: 0, steer: false } };
    const at = subjectInFrame(tracked, m, clipLookAt(tracked, t0), t0, 16 / 9);
    ok('finds the tracked subject in the picture', !!at && Math.abs(at.x - 0.7) < 0.01 && Math.abs(at.y - 0.4) < 0.01, at);
    ok('a track for masks only leaves the view alone', JSON.stringify(clipLookAt(tracked, t0)) === JSON.stringify(clipLookAt(c0, t0)));
    const follows = await grab(withMasks([{ ...box('hide', { color: '#ff0000', w: 0.08, h: 0.08 }), follow: true }], tracked), 'follow');
    ok('a following mask sits on the subject', red(px(follows, 0.7, 0.4)) && !red(px(follows, 0.5, 0.5)), [px(follows, 0.7, 0.4), px(follows, 0.5, 0.5)]);
  }

  // --- Preview against export ------------------------------------------------------------------
  const shownTl = withMasks([box('hide', { color: '#ff0000', x: 0.3, y: 0.6, w: 0.2, h: 0.2 }), box('blur', { x: 0.7, y: 0.4 })]);
  api.setTimeline(shownTl);
  api.player.seek(T);
  for (let i = 0; i < 8; i++) await Promise.race([api.nextRender(), sleep(1500)]);
  await sleep(300);
  const frame = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect();
  const shot = await ace.capture('masks-preview');
  const sx = (await createImageBitmap(new Blob([(await ace.readAll(shot)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
  const shown = await readPicture(shot, { x: frame.left * sx, y: frame.top * sx, w: frame.width * sx, h: frame.height * sx }, { w: 160, h: 90 });
  const exported = await grab(shownTl, 'preview-ref');
  const small = await readPicture(await ace.selftestOut('masks-preview-ref.png'), undefined, { w: 160, h: 90 });
  void exported;
  ok('the preview hides the same place', red(px(shown, 0.3, 0.6)) && !red(px(shown, 0.5, 0.2)), [px(shown, 0.3, 0.6), px(shown, 0.5, 0.2)]);
  const d = diff(shown, small, 0, 0, 1, 1);
  ok('preview and export look the same', d < 8, +d.toFixed(2));

  // --- The Inspector -----------------------------------------------------------------------------
  api.setTimeline(withMasks([]));
  api.player.seek(T);
  await sleep(300);
  const tab = document.querySelector<HTMLElement>('.dock-tab[data-panel="effects"]');
  if (tab) {
    const r = tab.getBoundingClientRect(), p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    await ace.selftestInput({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    await ace.selftestInput({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
    await sleep(400);
  }
  // (The Masks section starts closed: open it.)
  const head = document.querySelector<HTMLElement>('[data-section="Masks"] .section-toggle');
  if (head?.getAttribute('aria-expanded') !== 'true') head?.click();
  await sleep(300);
  $$('[data-section="Masks"] button').find((b) => /Rectangle/.test(b.textContent ?? ''))?.click();
  await sleep(400);
  ok('+ Rectangle adds a mask to the clip', api.getTimeline().clips[0]!.masks?.length === 1 && $$('.mask-row').length === 1, { masks: api.getTimeline().clips[0]!.masks?.length, rows: $$('.mask-row').length });
  ok('and outlines it on the preview', document.querySelector<HTMLElement>('.overlay-layer')?.dataset.drawn === '1');
  await ace.capture('masks-inspector');

  // --- Saving --------------------------------------------------------------------------------------
  api.setTimeline(withMasks([moving, box('pixelate', { invert: true })]));
  await sleep(200);
  const text = api.saveText!();
  await api.restore!(text);
  await sleep(800);
  const back = api.getTimeline().clips[0]!.masks;
  ok('masks are saved and opened again', back?.length === 2 && back[0]!.keys.length === 2 && back[1]!.invert && back[1]!.effect === 'pixelate', back?.map((x) => [x.effect, x.keys.length]));

  // --- Playing with two masks on 4K keeps up ---------------------------------------------------------
  api.setTimeline(withMasks([box('blur', { x: 0.3 }), { ...box('pixelate', { x: 0.7 }), shape: 'ellipse' }]));
  api.player.seek(0.5 * S);
  for (let i = 0; i < 8; i++) await Promise.race([api.nextRender(), sleep(1500)]);
  const st0 = api.player.stalls, seen = new Set<number>();
  api.player.play();
  await sleep(500);
  const t0 = performance.now(), p0 = api.player.time;
  while (performance.now() - t0 < 4000) { await api.nextRender(); const ts = api.lastResult()?.layers?.[0]?.frames[0]?.timestamp; if (ts !== undefined) seen.add(ts); }
  const wall = (performance.now() - t0) / 1000, adv = (api.player.time - p0) / S;
  api.player.pause();
  out.perfMasks = { source: `${m.width}×${m.height}@${m.fps.toFixed(0)}`, speed: +(adv / wall).toFixed(3), pictures: +(seen.size / wall).toFixed(1), stalls: api.player.stalls - st0 };
  ok('two masks on 4K play in real time at Full', adv / wall > 0.95 && seen.size / wall > m.fps * 0.85, out.perfMasks);

  return { fails, ...out };
}

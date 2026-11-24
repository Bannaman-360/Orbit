// Video tracks above the main row: picture in picture and split screen. The preview (CSS) and
// the export (2D canvas) must place every picture the same way; tracks can be shown, locked and
// muted; projects keep them; two 4K layers play in real time.

import {
  addClip, applyLayout, emptyTimeline, LAYOUT_TEMPLATES, loadTimeline, newClip, placeConnected, shownRect, stackAt,
  updateClip, updateTrack, type Timeline, type Transform,
} from '@ace/project';
import { ace } from './api';
import { mixTimeline } from './audioEngine';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { getMedia, type Media } from './media';
import type { EditorApi } from './selftest';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

async function settle(api: EditorApi, renders = 6) {
  const deadline = performance.now() + 8000;
  for (let i = 0; i < renders; i++) await Promise.race([api.nextRender(), sleep(Math.max(0, deadline - performance.now()))]);
  await sleep(200);
}

/** What is on screen at T, decoded straight from the files (for grabbing a frame). */
async function stackFrames(tl: Timeline, T: number): Promise<{ layers: LayerFrame[]; close: () => void }> {
  const st = stackAt(tl, T)!;
  const layers: LayerFrame[] = [], closers: (() => void)[] = [];
  for (const l of st.layers) {
    const m = await getMedia(l.clip.mediaPath);
    const f = await framesAt(m, l.mediaUs);
    closers.push(f.close);
    layers.push({ clip: l.clip, index: l.index, track: l.track, role: l.role, media: m, layout: m.layout, level: 1, mediaUs: l.mediaUs, frames: f.frames });
  }
  return { layers, close: () => closers.forEach((c) => c()) };
}

interface Pic { w: number; h: number; d: Uint8ClampedArray }
async function readPicture(path: string, crop?: { x: number; y: number; w: number; h: number }, size?: { w: number; h: number }): Promise<Pic> {
  const bmp = await createImageBitmap(new Blob([(await ace.readAll(path)) as Uint8Array<ArrayBuffer>]));
  const c = crop ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const w = size?.w ?? c.w, h = size?.h ?? c.h;
  const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return { w, h, d: x.getImageData(0, 0, w, h).data };
}
const px = (p: Pic, x: number, y: number) => { const i = (Math.round(y) * p.w + Math.round(x)) * 4; return [p.d[i]!, p.d[i + 1]!, p.d[i + 2]!]; };
/** Mean difference (0–255) between part of `a` and all of `b` (scaled to that part). */
function regionDiff(a: Pic, r: { x: number; y: number; w: number; h: number }, b: Pic): number {
  let s = 0, n = 0;
  const x0 = Math.round(r.x), y0 = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  // Leave out a margin: edges are blended differently when scaled.
  for (let y = 3; y < h - 3; y += 2) for (let x = 3; x < w - 3; x += 2) {
    const i = ((y0 + y) * a.w + x0 + x) * 4, j = (Math.floor((y / h) * b.h) * b.w + Math.floor((x / w) * b.w)) * 4;
    for (let k = 0; k < 3; k++) s += Math.abs(a.d[i + k]! - b.d[j + k]!);
    n += 3;
  }
  return n ? s / n : 255;
}

export async function layersCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end));
  const paths = ['GX010133.MP4', 'virtual-ride.mp4', 'virtual-standing.mp4', 'slow-4k120.mp4'].map(fix).filter((p): p is string => !!p);
  const media: Media[] = [];
  for (const p of paths) media.push(await getMedia(p));
  await api.importPaths(paths);
  const [main, b, c, d] = media as [Media, Media, Media, Media];
  out.sources = media.map((m) => `${m.name} ${m.width}×${m.height}`);
  const clipOf = (m: Media, len = 8 * S, from = 0) => ({ ...newClip(m.path, m.durationUs, false), inUs: from, outUs: Math.min(m.durationUs, from + len) });

  // --- Model through the app: E puts the main-row clip's copy on V2 at the playhead. -----------
  api.setTimeline(addClip(emptyTimeline(), clipOf(main, 10 * S)));
  await settle(api);
  api.player.seek(2 * S);
  await sleep(100);
  api.run!('connect');
  await sleep(400);
  let tl = api.getTimeline();
  ok('E adds a copy over the main row on V2', tl.tracks.length === 1 && tl.connected.length === 1 && Math.abs(tl.connected[0]!.startUs - 2 * S) < 1000, { tracks: tl.tracks.length, connected: tl.connected.map((x) => x.startUs) });
  ok('the timeline shows the track with show, lock and mute', $$('.vtrack').length === 1 && $$('.vtrack-head button').length === 3 && /V2/.test($$('.vtrack-head')[0]?.textContent ?? ''), $$('.vtrack-head').map((h) => h.textContent));
  ok('and the new clip is selected', !!document.querySelector('.vclip.selected'));

  // --- Grid of four: preview boxes and export cells in the same places ----------------------
  tl = addClip(emptyTimeline(), clipOf(main, 10 * S));
  for (const [m, from] of [[b, 1 * S], [c, 2 * S], [d, 0]] as [Media, number][]) tl = placeConnected(tl, clipOf(m, 6 * S, from), 1 * S)!.tl;
  const T = 3 * S;
  tl = applyLayout(tl, T, 'grid-4');
  api.setTimeline(tl);
  api.player.seek(T);
  await settle(api, 10);
  const frame = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect();
  const cells = LAYOUT_TEMPLATES.find((l) => l.id === 'grid-4')!.cells;
  const res = api.lastResult();
  ok('the preview shows four layers', res?.layers?.length === 4, res?.layers?.length);
  const boxes = $$('.layer-slot').filter((s) => s.style.visibility === 'visible').map((s) => ({ z: +s.style.zIndex, r: s.querySelector<HTMLElement>('.layer-box')!.getBoundingClientRect() })).sort((x, y) => x.z - y.z);
  const off = boxes.map((bx, i) => {
    const [l, t, w, h] = cells[i]!;
    return Math.max(Math.abs(bx.r.left - frame.left - l * frame.width), Math.abs(bx.r.top - frame.top - t * frame.height), Math.abs(bx.r.width - w * frame.width), Math.abs(bx.r.height - h * frame.height));
  });
  ok('preview places each clip in its cell (within 1 px)', boxes.length === 4 && off.every((o) => o <= 1.01), off.map((o) => +o.toFixed(2)));
  await ace.capture('layers-grid-preview');

  // The export, cell by cell, against each clip grabbed on its own.
  const grid = await stackFrames(tl, T);
  const gridPath = await ace.selftestOut('layers-grid.png');
  await grabFrame(tl, T, grid.layers, gridPath, 720);
  grid.close();
  const g = await readPicture(gridPath);
  const diffs: number[] = [];
  const st = stackAt(tl, T)!;
  for (const [i, l] of st.layers.entries()) {
    const { startUs: _s, trackId: _t, ...plainClip } = l.clip as typeof l.clip & { startUs?: number; trackId?: string };
    const alone = { ...addClip(emptyTimeline(), { ...plainClip, look: { ...l.clip.look, xf: undefined }, keyframes: [] }), framing: tl.framing };
    const f = await stackFrames(alone, l.mediaUs - l.clip.inUs);
    const p = await ace.selftestOut(`layers-alone-${i}.png`);
    await grabFrame(alone, l.mediaUs - l.clip.inUs, f.layers, p, 720);
    f.close();
    const [x, y, w, h] = cells[i]!;
    diffs.push(+regionDiff(g, { x: x * g.w, y: y * g.h, w: w * g.w, h: h * g.h }, await readPicture(p)).toFixed(2));
  }
  ok('export draws each clip in its cell', diffs.length === 4 && diffs.every((x) => x < 6), diffs);

  // The preview as shown on screen against the export (small, so scaling doesn't count).
  const shot = await ace.capture('layers-grid-shown');
  const sx = (await createImageBitmap(new Blob([(await ace.readAll(shot)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
  const shown = await readPicture(shot, { x: frame.left * sx, y: frame.top * sx, w: frame.width * sx, h: frame.height * sx }, { w: 64, h: 36 });
  const exported = await readPicture(gridPath, undefined, { w: 64, h: 36 });
  const pe = regionDiff(shown, { x: 0, y: 0, w: 64, h: 36 }, exported);
  ok('preview and export look the same', pe < 8, +pe.toFixed(2));

  // --- Picture in picture: border, shadow, corners ------------------------------------------
  const pipXf = (xf: Partial<Transform>): Transform => ({ ...applyCell('pip-br'), ...xf });
  const one = (xf: Transform) => {
    let t = addClip(emptyTimeline(), clipOf(main, 10 * S));
    t = placeConnected(t, clipOf(b, 6 * S, S), 1 * S)!.tl;
    return updateClip(t, t.connected[0]!.id, { look: { ...t.connected[0]!.look, xf } });
  };
  const grabOne = async (t: Timeline, name: string) => {
    const f = await stackFrames(t, T);
    const p = await ace.selftestOut(`${name}.png`);
    await grabFrame(t, T, f.layers, p, 720);
    f.close();
    return readPicture(p);
  };
  const bordered = pipXf({ border: 0.012, borderColor: '#ff0000' });
  const bp = await grabOne(one(bordered), 'layers-pip-border');
  const r = shownRect(bordered), bw = 0.012 * bp.h;
  const edge = px(bp, r.x * bp.w - bw / 2, (r.y + r.h / 2) * bp.h);
  ok('a border is drawn round the picture', edge[0]! > 200 && edge[1]! < 70 && edge[2]! < 70, edge);
  const plain = await grabOne(one(pipXf({})), 'layers-pip-plain');
  const shadowed = await grabOne(one(pipXf({ shadow: 1 })), 'layers-pip-shadow');
  const below = [(r.x + r.w / 2) * plain.w, (r.y + r.h) * plain.h + 0.012 * plain.h] as const;
  const lum = (v: number[]) => v[0]! + v[1]! + v[2]!;
  ok('a shadow darkens what is under it', lum(px(shadowed, ...below)) < lum(px(plain, ...below)) - 25, [px(plain, ...below), px(shadowed, ...below)]);
  const round = await grabOne(one(pipXf({ radius: 0.25 })), 'layers-pip-round');
  const behind = await grabOne(addClip(emptyTimeline(), clipOf(main, 10 * S)), 'layers-main-alone');
  const corner = [r.x * round.w + 2, r.y * round.h + 2] as const;
  const near = (a: number[], b2: number[]) => Math.abs(lum(a) - lum(b2)) < 24;
  ok('rounded corners show what is behind', near(px(round, ...corner), px(behind, ...corner)) && !near(px(plain, ...corner), px(behind, ...corner)), [px(behind, ...corner), px(plain, ...corner), px(round, ...corner)]);
  // Same picture in the preview: the box has the same corners, border and shadow as CSS.
  api.setTimeline(one({ ...bordered, radius: 0.1, shadow: 0.6 }));
  api.player.seek(T);
  await settle(api, 8);
  const box = $$('.layer-slot').filter((s) => s.style.visibility === 'visible').sort((x, y) => +y.style.zIndex - +x.style.zIndex)[0]?.querySelector<HTMLElement>('.layer-box');
  ok('the preview draws the same frame', !!box && /255, 0, 0|#ff0000/.test(box.style.boxShadow) && parseFloat(box.style.borderRadius) > 0, box && { shadow: box.style.boxShadow, radius: box.style.borderRadius });
  await ace.capture('layers-pip-preview');

  // --- Hidden, locked, muted ------------------------------------------------------------------
  const pip = one(pipXf({}));
  const hidden = updateTrack(pip, pip.tracks[0]!.id, { hidden: true });
  api.setTimeline(hidden);
  api.player.seek(T);
  await settle(api, 6);
  ok('a hidden track is not drawn', api.lastResult()?.layers?.length === 1, api.lastResult()?.layers?.length);
  // Sound: main row silent, so only the track clip (from a file with sound) is heard.
  let quiet = addClip(emptyTimeline(), { ...clipOf(main, 10 * S), volume: 0 });
  quiet = placeConnected(quiet, clipOf(main, 6 * S, 2 * S), 1 * S)!.tl;
  const rms = (buf: AudioBuffer | null) => { if (!buf) return 0; const ch = buf.getChannelData(0); let s = 0; for (let i = 0; i < ch.length; i += 7) s += ch[i]! * ch[i]!; return Math.sqrt(s / (ch.length / 7)); };
  const heard = rms(await mixTimeline(quiet, 8 * S)), muted = rms(await mixTimeline(updateTrack(quiet, quiet.tracks[0]!.id, { muted: true }), 8 * S));
  ok('a track clip is heard, and not when its track is muted', heard > 0.001 && muted < 1e-5, { heard: +heard.toFixed(5), muted, hasSound: main.info.audioTracks.length > 0 });
  api.setTimeline(updateTrack(pip, pip.tracks[0]!.id, { locked: true }));
  await sleep(300);
  const vclip = document.querySelector<HTMLElement>('.vclip');
  ok('a locked track’s clips can’t be trimmed', !!vclip && !vclip.querySelector('.trim') && vclip.classList.contains('locked'));

  // --- Saving ----------------------------------------------------------------------------------
  api.setTimeline(applyLayout(tl, T, 'split-3'));
  await sleep(200);
  const text = api.saveText!();
  const saved = JSON.parse(text);
  ok('saves tracks and their clips', saved.timeline.version === 3 && saved.timeline.tracks.length === 3 && saved.timeline.connected.length === 3, { version: saved.timeline.version, tracks: saved.timeline.tracks.length });
  await api.restore!(text);
  await sleep(800);
  const back = api.getTimeline();
  ok('and opens them again', back.connected.length === 3 && JSON.stringify(back.connected.map((x) => x.look.xf)) === JSON.stringify(loadTimeline(saved.timeline).connected.map((x) => x.look.xf)), back.connected.length);

  // --- Layout buttons in the Inspector ----------------------------------------------------------
  // (Two clips, full frame, so the button has something to change.)
  let two = addClip(emptyTimeline(), clipOf(main, 10 * S));
  two = placeConnected(two, clipOf(b, 6 * S, S), 1 * S)!.tl;
  api.setTimeline(two);
  api.player.seek(T);
  await sleep(300);
  const tab = document.querySelector<HTMLElement>('.dock-tab[data-panel="clip"]');
  if (tab) {
    const r = tab.getBoundingClientRect(), at = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    await ace.selftestInput({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
    await ace.selftestInput({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
    await sleep(400);
  }
  const picks = $$('.layout-pick');
  ok('the Inspector offers the layouts', picks.length === LAYOUT_TEMPLATES.length, picks.length);
  picks.find((p) => p.getAttribute('aria-label') === 'Side by side')?.click();
  await sleep(300);
  const sbs = api.getTimeline();
  ok('a layout button places what is on screen', !!sbs.clips[0]!.look.xf && Math.abs(shownRect(sbs.clips[0]!.look.xf).w - 0.5) < 1e-6 && Math.abs(shownRect(sbs.connected[0]!.look.xf!).x - 0.5) < 1e-6 && Math.abs(shownRect(sbs.connected[0]!.look.xf!).y) < 1e-6);
  await ace.capture('layers-inspector');

  // --- Performance: two 4K layers at Full ------------------------------------------------------
  const big = media.filter((m) => m.width >= 3800);
  if (big.length) {
    const m1 = big[0]!, m2 = big[1] ?? big[0]!;
    let pt = addClip(emptyTimeline(), clipOf(m1, 10 * S));
    pt = placeConnected(pt, clipOf(m2, 8 * S, m2 === m1 ? 1 * S : 0), 0)!.tl;
    pt = applyLayout(pt, 1 * S, 'pip-tr');
    api.setTimeline(pt);
    api.player.seek(0.5 * S);
    await settle(api, 8);
    const st0 = api.player.stalls, shownTs = new Set<number>();
    api.player.play();
    await sleep(500);
    const t0 = performance.now(), p0 = api.player.time;
    while (performance.now() - t0 < 4000) {
      await api.nextRender();
      const ts = api.lastResult()?.layers?.[1]?.frames[0]?.timestamp;
      if (ts !== undefined) shownTs.add(ts);
    }
    const wall = (performance.now() - t0) / 1000, adv = (api.player.time - p0) / S;
    api.player.pause();
    const fps = Math.min(m1.fps, m2.fps);
    out.perf2x4k = { sources: [`${m1.width}×${m1.height}@${m1.fps.toFixed(0)}`, `${m2.width}×${m2.height}@${m2.fps.toFixed(0)}`], speed: +(adv / wall).toFixed(3), topLayerPictures: +(shownTs.size / wall).toFixed(1), stalls: api.player.stalls - st0 };
    ok('two 4K layers play in real time at Full', adv / wall > 0.95 && shownTs.size / wall > Math.min(fps, 60) * 0.85, out.perf2x4k);
  } else out.perf2x4k = 'skipped: no 4K footage';

  return { fails, ...out };
}

/** The picture-in-picture transform of a layout's second cell. */
function applyCell(id: string): Transform {
  const withClip = placeConnected(addClip(emptyTimeline(), newClip('/x', 10 * S, false)), newClip('/y', 10 * S, false), 0)!.tl;
  return applyLayout(withClip, 0, id).connected[0]!.look.xf!;
}

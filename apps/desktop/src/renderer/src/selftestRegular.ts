// Regular (not 360) videos are edited as in any video editor: the app tells them apart from 360
// ones, shows them whole, gives a new project their shape, and moves, sizes and crops them as a
// picture (on the preview and in the inspector), with the preview and the export alike.

import { addClip, emptyTimeline, newClip, shownRect, stackAt, type Transform } from '@ace/project';
import { ace } from './api';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { shownXf } from './frameRender';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(api: EditorApi, renders = 6) {
  const deadline = performance.now() + 8000;
  for (let i = 0; i < renders; i++) await Promise.race([api.nextRender(), sleep(Math.max(0, deadline - performance.now()))]);
  await sleep(200);
}

/** A section shows in the inspector (its slot isn't empty). */
const shows = (id: string) => !!document.querySelector(`[data-section="${id}"]`)?.childElementCount;

export async function regularCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end));
  const phonePath = fix('odd/portrait-phone.mp4')!, widePath = fix('virtual-wide.mp4')!, sphere = fix('synthetic-4096x1344-hevc.360')!;

  // --- Telling 360 and regular videos apart. ------------------------------------------------
  const phone = await getMedia(phonePath), wide = await getMedia(widePath), round = await getMedia(sphere);
  ok('a phone video is regular', !phone.is360 && phone.height > phone.width, [phone.is360, phone.width, phone.height]);
  ok('a GoPro-style regular video is regular', !wide.is360, wide.is360);
  ok('a 360 video is 360', round.is360);

  // --- A new project takes the first video's shape; regular videos start whole. --------------
  api.setTimeline(emptyTimeline());
  await settle(api, 2);
  await api.dropPaths!([phonePath], 0);
  for (let i = 0; i < 100 && !api.getTimeline().clips.length; i++) await sleep(100);
  let tl = api.getTimeline();
  ok('a portrait video makes a 9:16 project', tl.framing === '9:16', tl.framing);
  ok('and is shown whole (Fit)', tl.clips[0]?.fit === 'fit', tl.clips[0]?.fit);
  // Adding to a project that has clips leaves its shape alone.
  await api.dropPaths!([widePath], 999 * S);
  for (let i = 0; i < 100 && api.getTimeline().clips.length < 2; i++) await sleep(100);
  ok('a later clip keeps the project shape', api.getTimeline().framing === '9:16' && api.getTimeline().clips.length === 2, [api.getTimeline().framing, api.getTimeline().clips.length]);

  // --- The inspector: position, size and crop; no 360 view. -----------------------------------
  const T = 0.5 * S;
  tl = { ...addClip(emptyTimeline(), { ...newClip(phonePath, phone.durationUs, false), fit: 'fit' }), framing: '16:9' };
  api.setTimeline(tl);
  api.player.seek(T);
  await settle(api);
  document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
  await sleep(300);
  const sections = { View: shows('View'), Lens: shows('Lens'), 'Lens details': shows('Lens details'), Framing: shows('Framing'), Transform: shows('Transform') };
  ok('a phone video gets Framing and Transform, not the 360 view or lens tools', !sections.View && !sections.Lens && !sections['Lens details'] && sections.Framing && sections.Transform, sections);

  // --- The preview shows the picture alone, where the export puts it. --------------------------
  const frame = document.querySelector<HTMLElement>('.frame')!;
  const fr = frame.getBoundingClientRect();
  const box = () => document.querySelector<HTMLElement>('.layer-slot[style*="visible"] .layer-box')!.getBoundingClientRect();
  const across = (phone.width / phone.height) / (16 / 9);
  const b0 = box();
  ok('the preview box is the picture, not the frame', Math.abs(b0.width - across * fr.width) <= 1.5 && Math.abs(b0.height - fr.height) <= 1.5, { box: [b0.width, b0.height].map((v) => +v.toFixed(1)), want: [+(across * fr.width).toFixed(1), +fr.height.toFixed(1)] });

  // Dragging moves it; scrolling sizes it.
  const cx = fr.left + fr.width / 2, cy = fr.top + fr.height / 2;
  await ace.selftestInput({ type: 'mouseMove', x: Math.round(cx), y: Math.round(cy) });
  await ace.selftestInput({ type: 'mouseDown', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) { await ace.selftestInput({ type: 'mouseMove', x: Math.round(cx + (fr.width * 0.2 * i) / 6), y: Math.round(cy), button: 'left', modifiers: ['leftButtonDown'] }); await sleep(20); }
  await ace.selftestInput({ type: 'mouseUp', x: Math.round(cx + fr.width * 0.2), y: Math.round(cy), button: 'left', clickCount: 1 });
  await sleep(250);
  const xf1 = api.getTimeline().clips[0]!.look.xf;
  ok('dragging the preview moves the picture', !!xf1 && Math.abs(xf1.x - 0.2) < 0.03 && Math.abs(xf1.y) < 0.02 && api.getTimeline().clips[0]!.look.yaw === 0, xf1 && [xf1.x, xf1.y]);
  for (let k = 0; k < 4; k++) { frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 })); await sleep(30); }
  await sleep(200);
  const s1 = api.getTimeline().clips[0]!.look.xf?.scale ?? 1;
  ok('scrolling makes it smaller', Math.abs(s1 - Math.exp(-0.36)) < 0.02, s1);

  // Crop a share of the picture, then compare the preview box and the export.
  const xf: Transform = { ...api.getTimeline().clips[0]!.look.xf!, crop: [0.1, 0, 0, 0.2] };
  tl = api.getTimeline();
  tl = { ...tl, clips: tl.clips.map((c, i) => (i ? c : { ...c, look: { ...c.look, xf } })) };
  api.setTimeline(tl);
  api.player.seek(T);
  await settle(api);
  const clip = tl.clips[0]!;
  const want = shownRect(shownXf(clip, phone, clip.look, 16 / 9)!);
  const b1 = box(), f1 = frame.getBoundingClientRect();
  const got = { x: (b1.left - f1.left) / f1.width, y: (b1.top - f1.top) / f1.height, w: b1.width / f1.width, h: b1.height / f1.height };
  ok('cropping cuts the picture itself', Math.abs(want.w - across * 0.9 * xf.scale) < 1e-3 && Math.abs(want.h - 0.8 * xf.scale) < 1e-3, want);
  ok('the preview places it there (within 1.5 px)', ['x', 'y', 'w', 'h'].every((k) => Math.abs(got[k as 'x'] - want[k as 'x']) * f1.width <= 1.5), { got, want });
  await ace.capture('regular-preview');

  const st = stackAt(tl, T)!;
  const layers: LayerFrame[] = [], closers: (() => void)[] = [];
  for (const l of st.layers) {
    const m = await getMedia(l.clip.mediaPath);
    const f = await framesAt(m, l.mediaUs);
    closers.push(f.close);
    layers.push({ clip: l.clip, index: l.index, track: l.track, role: l.role, media: m, layout: m.layout, level: 1, mediaUs: l.mediaUs, frames: f.frames });
  }
  const png = await ace.selftestOut('regular-export.png');
  await grabFrame(tl, T, layers, png, 720);
  closers.forEach((c) => c());
  const bmp = await createImageBitmap(new Blob([(await ace.readAll(png)) as Uint8Array<ArrayBuffer>]));
  const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
  /** Mean brightness of a frame-fraction box. */
  const mean = (x0: number, y0: number, x1: number, y1: number) => {
    let s = 0, n = 0;
    for (let y = Math.round(y0 * bmp.height); y < Math.round(y1 * bmp.height); y += 2) for (let xx = Math.round(x0 * bmp.width); xx < Math.round(x1 * bmp.width); xx += 2) { const i = (y * bmp.width + xx) * 4; s += d[i]! + d[i + 1]! + d[i + 2]!; n += 3; }
    return n ? s / n : 0;
  };
  const m = 0.01;
  const inside = mean(want.x + m, want.y + m, want.x + want.w - m, want.y + want.h - m);
  const left = mean(0, 0, Math.max(0.001, want.x - m), 1), below = mean(want.x + m, Math.min(0.999, want.y + want.h + m), want.x + want.w - m, 1);
  ok('the export shows the picture in the same place, black around it', inside > 10 && left < 2 && below < 2, { inside: +inside.toFixed(1), left: +left.toFixed(1), below: +below.toFixed(1) });

  // --- 360 videos keep their own view. ---------------------------------------------------------
  api.setTimeline(addClip(emptyTimeline(), newClip(sphere, round.durationUs, true)));
  api.player.seek(T);
  await settle(api);
  await sleep(200);
  ok('a 360 video keeps its view controls', shows('View') && shows('Lens') && !shows('Framing'), { View: shows('View'), Lens: shows('Lens'), Framing: shows('Framing') });
  const yaw0 = api.getTimeline().clips[0]!.look.yaw;
  frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }));
  await sleep(200);
  const c360 = api.getTimeline().clips[0]!;
  ok('and scrolling still zooms its view', c360.look.fov < 100 && !c360.look.xf && c360.look.yaw === yaw0, [c360.look.fov, c360.look.xf]);
  return { fails, ...out };
}


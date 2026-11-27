// Footage of the real editor for the tutorial videos (marketing/tutorials). The app is driven with
// real mouse events (moves, clicks, drags, scrolls) as a user would, and the window is captured
// after each step into selftest-out/tutshots/<take>-NNNN.jpg. Where the pointer was on every frame,
// and when it clicked, goes to selftest-out/tutshots/<take>.json so the video can draw the cursor
// and put sounds on the clicks. Not a check: it only fails when the footage can't be made.

import { addClip, emptyTimeline, newClip, type TimelineClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { BUILTIN_THEMES, setPrefs } from './ui/prefs';
import { openSection } from './ui';

const S = 1_000_000, FPS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(q: string) => document.querySelector<T>(q);
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

type Pt = { x: number; y: number };
type Frame = { img: number; x: number; y: number; down: boolean };
type Ev = { f: number; type: string; label?: string };

/** Middle (or a point inside) of an element, in window pixels. */
const at = (el: Element | null | undefined, fx = 0.5, fy = 0.5): Pt => {
  if (!el) throw new Error('element not found');
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) };
};
const byText = (q: string, re: RegExp) => $$(q).find((e) => re.test(e.textContent ?? '') && e.getBoundingClientRect().width > 0) ?? null;

export async function tutorialShots(api: EditorApi) {
  const fails: string[] = [];
  const out: Record<string, unknown> = {};
  const info = await ace.info();

  // The look: Sunset, help notes off (as in the launch ad).
  const sunset = BUILTIN_THEMES.find(([n]) => n === 'Sunset')![1];
  setPrefs(() => ({ theme: { ...sunset, hints: false } }));
  const quiet = document.createElement('style');
  quiet.textContent = '.vtrack-add, .track-empty { color: transparent !important; } .vtrack-add svg, .track-empty svg { display: none !important; }';
  document.head.appendChild(quiet);
  await sleep(400);

  // --- The recorder -------------------------------------------------------------------------------
  let take = '', frames: Frame[] = [], events: Ev[] = [], img = 0, rec = true;
  let cur: Pt = { x: 1640, y: 560 }, down = false;
  const input = (type: string, p: Pt, extra: Record<string, unknown> = {}) =>
    ace.selftestInput({ type, x: Math.round(p.x), y: Math.round(p.y), ...(down ? { button: 'left', modifiers: ['leftbuttondown'] } : {}), ...extra });
  /** Waits for the preview to draw (when something changed) and the UI to paint. */
  const settle = async (renders: number, ms: number) => {
    for (let i = 0; i < renders; i++) await Promise.race([api.nextRender(), sleep(ms)]);
    await raf(); await raf();
    await sleep(30);
  };
  const shot = async (renders = 1, ms = 140) => {
    if (!rec) { await settle(renders, ms); return; }
    await settle(renders, ms);
    await ace.capture(`tutshots/${take}-${String(img).padStart(4, '0')}.jpg`);
    frames.push({ img, x: cur.x, y: cur.y, down });
    img++;
  };
  /** The same picture again (nothing on screen changes). */
  const hold = (n: number) => { if (!rec) return; for (let i = 0; i < n; i++) frames.push({ img: img - 1, x: cur.x, y: cur.y, down }); };
  const mark = (type: string, label?: string) => { if (rec) events.push({ f: frames.length, type, label }); };
  const begin = (name: string) => { take = name; frames = []; events = []; img = 0; };
  const finish = async () => {
    await ace.selftestFiles('write', `tutshots/${take}.json`, JSON.stringify({ take, fps: FPS, window: [window.innerWidth, window.innerHeight], frames, events, images: img }));
    out[take] = { frames: frames.length, images: img, events: events.length };
  };
  /** Moves the pointer there over n frames, with real mouse moves (hover states show). */
  const move = async (to: Pt, n = 18, renders = 0) => {
    const from = cur;
    if (!rec) n = Math.min(n, 8);
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      cur = { x: from.x + (to.x - from.x) * k + Math.sin(k * Math.PI) * (to.y - from.y) * 0.06, y: from.y + (to.y - from.y) * k - Math.sin(k * Math.PI) * (to.x - from.x) * 0.04 };
      await input('mouseMove', cur);
      await shot(renders, 60);
    }
    cur = to;
  };
  const click = async (label?: string, wait = 6) => {
    await input('mouseDown', cur, { button: 'left', clickCount: 1 });
    down = true; mark('click', label);
    await shot(1, 60);
    down = false;
    await input('mouseUp', cur, { button: 'left', clickCount: 1 });
    for (let i = 0; i < wait; i++) await shot(1, 90);
  };
  /** Press, drag to `to` over n frames (the preview redraws each step), release. */
  const drag = async (to: Pt, n = 30, label?: string) => {
    const from = cur;
    await input('mouseDown', cur, { button: 'left', clickCount: 1 });
    down = true; mark('down', label);
    await shot(1, 80); hold(3);
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      cur = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      await input('mouseMove', cur);
      await shot(2, 250);
    }
    hold(3);
    down = false;
    await input('mouseUp', cur, { button: 'left', clickCount: 1 });
    mark('up', label);
    await shot(1, 120);
  };
  const scroll = async (ticks: number, dy = 40) => {
    for (let i = 0; i < Math.abs(ticks); i++) {
      await input('mouseWheel', cur, { deltaX: 0, deltaY: Math.sign(ticks) * -dy, canScroll: true });
      if (i % 2 === 0) mark('scroll');
      await shot(2, 250);
    }
  };
  const key = async (k: string) => {
    await ace.selftestInput({ type: 'keyDown', keyCode: k });
    await ace.selftestInput({ type: 'keyUp', keyCode: k });
    mark('key', k);
    await shot(1, 60); hold(2);
  };
  const typeText = async (text: string) => {
    for (const ch of text) {
      await ace.selftestInput({ type: 'keyDown', keyCode: ch });
      await ace.selftestInput({ type: 'char', keyCode: ch });
      await ace.selftestInput({ type: 'keyUp', keyCode: ch });
      mark('type', ch);
      await shot(0, 0); hold(4);
    }
  };
  /** Plays from `fromUs` for `secs`, one real frame at a time (the pointer rests). */
  const playback = async (fromUs: number, secs: number, step = 1) => {
    mark('play');
    for (let i = 0; i < Math.round(secs * FPS); i += step) {
      api.player.seek(fromUs + (i / FPS) * S);
      await shot(4, 1200);
      hold(step - 1);
    }
  };
  const playButton = () => $$('.transport button, .transport [role="button"]').find((b) => /^Play/i.test(b.getAttribute('aria-label') ?? b.getAttribute('title') ?? '')) ?? null;
  /** The x of a timeline time on the ruler, from its tick labels. */
  const rulerAt = (secs: number): Pt => {
    const ruler = $('.ruler')!;
    const r = ruler.getBoundingClientRect();
    const ticks = [...ruler.querySelectorAll<HTMLElement>('*')].filter((e) => /^\d+:\d+(\.\d+)?$/.test((e.textContent ?? '').trim()) && !e.children.length);
    const xs = ticks.map((e) => { const [m, s] = (e.textContent ?? '').trim().split(':'); return [Number(m) * 60 + Number(s), e.getBoundingClientRect().left] as const; });
    const [a, b] = [xs[0]!, xs[xs.length - 1]!];
    const x = a[1] + ((b[1] - a[1]) * (secs - a[0])) / (b[0] - a[0]) - 4;
    return { x, y: r.top + r.height / 2 };
  };
  const tab = async (panel: string) => { $(`.dock-tab[data-panel="${panel}"]`)?.click(); await sleep(350); };
  const sectionOpen = (id: string) => $(`[data-section="${id}"] .section-toggle`)?.getAttribute('aria-expanded') === 'true';
  const setSections = async (open: string[], closed: string[]) => {
    for (const id of [...open, ...closed]) {
      const want = open.includes(id);
      if (sectionOpen(id) !== want) { $(`[data-section="${id}"] .section-toggle`)?.click(); await sleep(200); }
    }
    if (open[0]) openSection(open[0]);
    await sleep(250);
  };
  const clipOf = async (file: string, inS: number, lenS: number, patch: Partial<TimelineClip> = {}) => {
    const m = await getMedia(file);
    const c = newClip(file, m.durationUs, true);
    return { ...c, inUs: inS * S, outUs: (inS + lenS) * S, ...patch, look: { ...c.look, ...(patch.look ?? {}) } } as TimelineClip;
  };

  const ride = `${info.fixtures}/max2/GS010004.360`;
  const rider = `${info.fixtures}/max2/GS010120.360`;
  await api.importPaths([ride, rider]);
  // Mode tutshots makes every take; tut-tr (or tut-kf+cv) makes only those.
  const takes = api.mode === 'tutshots' ? ['kf', 'cv', 'tr'] : (api.mode ?? '').replace(/^tut-/, '').split('+');

  try {
    // ================= 1. Keyframes: add one, move the playhead, move the view, play ==============
    if (takes.includes('kf')) {
      const a = await clipOf(ride, 340, 6, { look: { pitch: -6 } as never });
      api.setTimeline(addClip(emptyTimeline(), a));
      api.player.seek(0.3 * S);
      await tab('reframe');
      await setSections(['Keyframes', 'View'], ['Curves', 'Subject tracking', 'Lens', 'Framing', 'Transform', 'Lens details', 'Smart reframe']);
      // select the clip so the panel shows it
      await settle(4, 1500);
      begin('kf');
      cur = { x: 1180, y: 640 };
      await input('mouseMove', cur);
      await shot(4, 1500); hold(14);
      // 1. Add a keyframe at the start.
      await move(at(byText('.keybar button', /Add keyframe/)), 22);
      hold(4);
      await click('Add keyframe', 10);
      hold(10);
      // 2. Move the playhead to 0:04.
      await move(rulerAt(4.3), 24);
      await click('playhead', 8);
      hold(6);
      // 3. Drag the preview to turn the view; scroll to go wider.
      const pv = $('.frame')!;
      await move(at(pv, 0.7, 0.5), 22);
      hold(4);
      await drag(at(pv, 0.22, 0.54), 40, 'pan');
      hold(6);
      await scroll(-5);
      hold(16);
      // 4. Play it from the start.
      await move(at(playButton()), 20);
      await click('play', 0);
      api.player.pause();
      await move(at($('.frame'), 0.98, 1.08), 10);
      await playback(0.3 * S, 4.6);
      hold(20);
      await finish();
    }

    // ================= 2. Curves: before (linear), pick a curve, drag a handle, after ===============
    if (takes.includes('cv')) {
      const a = await clipOf(ride, 340, 6, { look: { pitch: -6 } as never });
      api.setTimeline(addClip(emptyTimeline(), a));
      api.player.seek(0.3 * S);
      await tab('reframe');
      await setSections(['Keyframes', 'View'], ['Curves', 'Subject tracking', 'Lens', 'Framing', 'Transform', 'Lens details', 'Smart reframe']);
      await settle(4, 1500);
      // The same two keyframes, made the same way but not recorded.
      rec = false;
      await move(at(byText('.keybar button', /Add keyframe/)));
      await click();
      await move(rulerAt(4.3)); await click();
      const pv = $('.frame')!;
      await move(at(pv, 0.7, 0.5));
      await drag(at(pv, 0.22, 0.54), 12);
      await scroll(-5);
      // Make the move plain (Linear) to start from.
      $('.keybar')?.querySelector<HTMLElement>('button[title="Previous keyframe"]')?.click(); await sleep(300);
      const sel = $<HTMLSelectElement>('.keybar select');
      if (sel) { const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!; set.call(sel, 'linear'); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      await sleep(300);
      rec = true;
      out.cvKeys = (api.getTimeline().clips[0] as TimelineClip).keyframes.map((k) => +(k.t / S).toFixed(2));
      await setSections(['Curves'], ['Keyframes', 'View', 'Subject tracking', 'Lens', 'Framing', 'Transform']);
      api.player.seek(2.2 * S);
      await settle(4, 1500);

      begin('cv');
      cur = { x: 1180, y: 640 };
      await input('mouseMove', cur);
      await shot(4, 1500); hold(6);
      // Before: a plain linear move.
      mark('before');
      await playback(0.3 * S, 4.3, 1);
      api.player.seek(2.2 * S);
      await shot(4, 1500); hold(8);
      // Pick a named curve.
      await move(at(byText('.curves-presets button', /^Ease in and out$/)), 22);
      hold(3);
      await click('Ease in and out', 8);
      // Then shape it by hand: pull the end handle up for a punchy arrival.
      const h2 = $('.curve-handle[data-handle="2"]');
      await move(at(h2), 20);
      hold(4);
      const g = $('.curve-graph')!.getBoundingClientRect();
      await drag({ x: g.left + g.width * 0.62, y: g.top + g.height * 0.14 }, 26, 'handle');
      hold(6);
      const h1 = $('.curve-handle[data-handle="1"]');
      await move(at(h1), 16);
      await drag({ x: g.left + g.width * 0.55, y: g.top + g.height * 0.7 }, 22, 'handle');
      hold(12);
      // After.
      await move(at(playButton()), 22);
      await click('play', 0);
      api.player.pause();
      await move(at($('.frame'), 0.98, 1.08), 10);
      mark('after');
      await playback(0.3 * S, 4.3, 1);
      hold(20);
      await finish();
    }

    // ================= 3. Subject tracking: pick the rider, track, play, auto zoom ==================
    if (takes.includes('tr')) {
      const START = 4.55;
      const a = await clipOf(rider, 3.9, 7.2, { look: { yaw: 6, pitch: 4, fov: 82 } as never, stabilize: { smoothing: 'medium', horizon: true } as never });
      api.setTimeline(addClip(emptyTimeline(), a));
      api.player.seek((START - 3.9) * S);
      await tab('reframe');
      await setSections(['Subject tracking'], ['Keyframes', 'Curves', 'View', 'Lens', 'Framing', 'Transform', 'Lens details', 'Smart reframe']);
      await settle(4, 1500);
      await ace.capture('tutshots/tr-aim.jpg');

      begin('tr');
      cur = { x: 1180, y: 640 };
      await input('mouseMove', cur);
      await shot(4, 1500); hold(14);
      await move(at(byText('[data-section="Subject tracking"] button', /Track subject/)), 22);
      hold(4);
      await click('Track subject', 10);
      hold(6);
      // A box around the rider (where the preview shows them at this view; see tutshots/tr-aim.jpg).
      const pv = $('.frame')!.getBoundingClientRect();
      const box = (window as unknown as { __tutBox?: number[] }).__tutBox ?? TR_BOX;
      await move({ x: pv.left + pv.width * box[0]!, y: pv.top + pv.height * box[1]! }, 22);
      hold(4);
      await drag({ x: pv.left + pv.width * box[2]!, y: pv.top + pv.height * box[3]! }, 22, 'box');
      // Tracking runs: its progress shows.
      mark('tracking');
      for (let i = 0; i < 400; i++) {
        await shot(0, 0);
        const c = api.getTimeline().clips[0] as TimelineClip | undefined;
        if (c?.track && !$('.track-progress, [class*="track-job"]')) break;
        await sleep(40);
      }
      mark('tracked');
      hold(10);
      out.tracked = !!(api.getTimeline().clips[0] as TimelineClip | undefined)?.track;
      await move(at($('.frame'), 0.98, 1.08), 16);
      await playback(0.68 * S, 6.4, 1);
      hold(8);
      // Auto zoom keeps the rider the same size.
      api.player.seek(2.2 * S);
      await shot(4, 1500);
      // Type a value for Subject size: click its number, type 38, Enter.
      const zoom = $$('[data-section="Subject tracking"] .slider').find((e) => /Subject size/.test(e.querySelector('.slider-name')?.textContent ?? ''));
      out.zoomFound = !!zoom;
      await move(at(zoom?.querySelector('.num')), 24);
      hold(4);
      await click('Subject size', 3);
      await move({ x: cur.x - 70, y: cur.y + 46 }, 8);
      for (let i = 0; i < 4; i++) await key('Backspace');
      await typeText('38');
      hold(4);
      await key('Return');
      await shot(4, 1500);
      hold(14);
      await move(at($('.frame'), 0.98, 1.08), 14);
      await playback(0.68 * S, 6.4, 1);
      hold(20);
      await finish();
    }
  } catch (e) {
    fails.push(`footage: ${String((e as Error)?.stack ?? e)}`);
    try { await finish(); } catch { /* */ }
  }
  return { fails, ...out };
}

/** The rider at the start of the tracking take, as fractions of the preview: x0, y0, x1, y1. */
const TR_BOX = [0.405, 0.27, 0.485, 0.53];

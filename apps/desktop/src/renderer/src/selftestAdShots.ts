// Footage of the real editor for the launch ad (marketing/ad): the Sunset theme with help notes off,
// a clean edit, and real changes made frame by frame (colour wheels and curves, a picture in picture,
// a mask, a title, the frame shape, an export running). Each frame is the hidden window, captured to
// selftest-out/adshots/<take>-NNNN.jpg after the preview has drawn it. Not a check: it only fails
// when the footage can't be made.

import {
  addClip, addTrack, cellTransform, emptyTimeline, LAYOUT_TEMPLATES, newClip, newMask, newTitleOverlay, placeConnected, updateClip,
  NEUTRAL_CURVES, NEUTRAL_WHEELS, type Timeline, type TimelineClip, type Wheels,
} from '@ace/project';
import { ace } from './api';
import { enqueue, queueJobs } from './exportQueue';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { BUILTIN_THEMES, setPrefs } from './ui/prefs';

const S = 1_000_000, FPS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (k: number, a: number, b: number) => clamp((k - a) / (b - a));
const smooth = (k: number) => k * k * (3 - 2 * k);
const expoOut = (k: number) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k));

export async function adShots(api: EditorApi) {
  const fails: string[] = [];
  const out: Record<string, unknown> = {};
  const info = await ace.info();
  const file = `${info.fixtures}/max2/GS010004.360`;

  // The look: Sunset, help notes off.
  const sunset = BUILTIN_THEMES.find(([n]) => n === 'Sunset')![1];
  setPrefs((p) => ({
    theme: { ...sunset, hints: false },
    // The Queue button, next to Export (Customize > Toolbars, as a user would add it).
    bars: { ...p.bars, main: { ...p.bars.main, items: p.bars.main.items.includes('queue') ? p.bars.main.items : p.bars.main.items.flatMap((x) => (x === 'export' ? ['queue', 'export'] : [x])) } },
  }));
  // For the recording only: hide the empty-row placeholder texts on the timeline (the app itself is unchanged).
  const quiet = document.createElement('style');
  quiet.textContent = '.vtrack-add, .track-empty { color: transparent !important; } .vtrack-add svg, .track-empty svg { display: none !important; }';
  document.head.appendChild(quiet);
  await sleep(400);

  await api.importPaths([file]);
  const m = await getMedia(file);
  const part = (inS: number, lenS: number, patch: Partial<TimelineClip> = {}): TimelineClip => {
    const c = newClip(file, m.durationUs, true);
    return { ...c, inUs: inS * S, outUs: (inS + lenS) * S, ...patch, look: { ...c.look, ...(patch.look ?? {}) } };
  };
  // A clean three-clip edit with a lower third.
  const a = part(340, 4), b = part(386, 4.5), c = part(98, 4);
  let base = [a, b, c].reduce((t, x) => addClip(t, x), emptyTimeline());
  base = { ...base, overlays: [{ ...newTitleOverlay('lt-line', 0.4 * S, 3.6 * S), text: 'Golden hour', subtitle: 'Day three' }] };

  const settle = async () => {
    for (let i = 0; i < 3; i++) await Promise.race([api.nextRender(), sleep(1500)]);
    await sleep(60);
  };
  let shots = 0;
  const take = async (name: string, frames: number, step: (i: number, k: number) => Promise<void> | void) => {
    for (let i = 0; i < frames; i++) {
      await step(i, frames > 1 ? i / (frames - 1) : 0);
      await settle();
      await ace.capture(`adshots/${name}-${String(i).padStart(4, '0')}.jpg`);
      shots++;
    }
  };
  const clickEl = async (el: Element | null | undefined) => {
    if (!el) return false;
    const r = el.getBoundingClientRect(), p = { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) };
    await ace.selftestInput({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    await ace.selftestInput({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
    await sleep(300);
    return true;
  };
  const tab = async (panel: string) => {
    const t = document.querySelector<HTMLElement>(`.dock-tab[data-panel="${panel}"]`);
    t?.click(); await sleep(350);
    return !!t;
  };
  const openSection = async (id: string) => {
    const h = document.querySelector<HTMLElement>(`[data-section="${id}"] .section-toggle`);
    if (h && h.getAttribute('aria-expanded') !== 'true') { h.click(); await sleep(250); }
    document.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: 'start' });
    return !!h;
  };

  try {
    // --- 1. Editing: the edit plays, the title comes in ------------------------------------------------
    api.setTimeline(base);
    await tab('reframe');
    await take('edit', 4 * FPS, (i) => { api.player.seek(0.2 * S + (i / FPS) * S); });

    // --- 2. Colour: wheels and the luma curve move, the picture grades -----------------------------------
    {
      const T0 = 4 * S + 0.5 * S;   // inside the second clip
      api.setTimeline(base);
      api.player.seek(T0);
      await sleep(300);
      out.colorTab = await tab('color');
      out.sections = [await openSection('Color wheels')];
      document.querySelector('[data-section="Color wheels"]')?.scrollIntoView({ block: 'start' });
      await take('colour', 4 * FPS, (i, k) => {
        const g = smooth(seg(k, 0.12, 0.8));
        const wheels: Wheels = {
          ...NEUTRAL_WHEELS,
          lift: { x: -0.2 * g, y: -0.28 * g, master: -0.06 * g },     // shadows towards teal
          gain: { x: 0.22 * g, y: 0.32 * g, master: 0.06 * g },       // highlights towards warm
        };
        const curves = { ...NEUTRAL_CURVES, master: [[0, 0], [0.25, 0.25 - 0.1 * g], [0.75, 0.75 + 0.08 * g], [1, 1]] as [number, number][] };
        api.setTimeline(updateClip(base, b.id, { curves, look: { ...b.look, wheels, grade: { ...b.look.grade, saturation: 0.3 * g } } }));
        api.player.seek(T0 + (i / FPS) * 0.5 * S);
      });
    }

    // --- 3. Tools: a picture in picture slides in, a blur mask opens, a title card plays ----------------
    {
      // Picture in picture: a second angle on a layer above.
      const cell = LAYOUT_TEMPLATES.find((t) => t.id === 'pip-br')!.cells[1]!;
      const pipXf = cellTransform(cell, 'fit');
      const added = addTrack(base);
      const pipClip = part(356, 6, { look: { ...part(356, 6).look, xf: pipXf } });
      const placed = placeConnected(added.tl, pipClip, 0, added.id ?? undefined)!;
      const withPip = (dx: number) => updateClip(placed.tl, placed.id, { look: { ...pipClip.look, xf: { ...pipXf, x: pipXf.x + dx, radius: 0.08, shadow: 1 } } } as Partial<TimelineClip>);
      // Select the layer's clip so the Transform panel follows it.
      api.setTimeline(withPip(0.6)); api.player.seek(1 * S); await settle();
      out.pipSelected = await clickEl(document.querySelector('.clip.vclip'));
      await tab('reframe');
      await openSection('Transform');
      await take('layers', Math.round(1.6 * FPS), (i, k) => {
        api.setTimeline(withPip(0.6 * (1 - expoOut(seg(k, 0.1, 0.75)))));
        api.player.seek(1 * S + (i / FPS) * S);
      });

      // A blur mask that opens over part of the picture (a face, a number plate…).
      await tab('effects');
      await openSection('Masks');
      await take('masks', Math.round(1.6 * FPS), (i, k) => {
        const g = expoOut(seg(k, 0.05, 0.7));
        const mask = { ...newMask('ellipse', 'blur', { x: 0.62, y: 0.42, w: 0.05 + 0.2 * g, h: 0.08 + 0.3 * g, feather: 0.06, amount: 1 }), id: 'k-ad' };
        api.setTimeline(updateClip(base, a.id, { masks: [mask] } as Partial<TimelineClip>));
        api.player.seek(1.2 * S + (i / FPS) * S);
      });

      // A title card playing in.
      const card = { ...newTitleOverlay('tc-split', 0, 4 * S), text: 'DAY ONE', subtitle: 'Trail season' };
      api.setTimeline({ ...base, overlays: [card] }); api.player.seek(0.1 * S); await settle();
      out.titleSelected = await clickEl(document.querySelector('.ov-item.is-text'));
      await take('titles', Math.round(1.6 * FPS), (i) => {
        api.setTimeline({ ...base, overlays: [card] });
        api.player.seek(0.1 * S + (i / FPS) * S);
      });
    }

    // --- 4. Frame shape: 16:9, then 9:16, then 1:1, while it plays ---------------------------------------
    {
      await tab('reframe');
      await take('reframe', 4 * FPS, (i, k) => {
        const framing = k < 0.3 ? '16:9' : k < 0.62 ? '9:16' : '1:1';
        // first clip, looking a little down the trail so a tall frame isn't all sky and helmet
        api.setTimeline({ ...updateClip(base, a.id, { look: { ...a.look, pitch: -8, fov: 84 } }), overlays: [], framing } as Timeline);
        api.player.seek(0.2 * S + (i / FPS) * S);
      });
    }

    // --- 5. Export: a real export in the queue, its progress as it runs ----------------------------------
    {
      api.setTimeline(base);
      api.player.seek(2 * S);
      await sleep(300);
      const path = await ace.selftestOut('adshots-export.mp4');
      const id = enqueue('Golden hour', base, { path, resolution: 2160, fps: 30, codec: 'hevc', quality: 'high', loudness: -14 });
      // The toolbar's Queue button opens the list.
      out.queueButton = await clickEl($$('[aria-label]').find((x) => /^Queue/.test(x.getAttribute('aria-label') ?? '')));
      await sleep(300);
      let i = 0, done = false;
      while (i < 20 * FPS && !done) {
        await sleep(30);
        await ace.capture(`adshots/export-${String(i).padStart(4, '0')}.jpg`);
        shots++; i++;
        const j = queueJobs().find((x) => x.id === id);
        done = !j || j.status === 'done' || j.status === 'failed' || j.status === 'cancelled';
        out.exportStatus = j?.status;
      }
      // Hold on the finished state for a moment.
      for (let k = 0; k < 20; k++) { await ace.capture(`adshots/export-${String(i).padStart(4, '0')}.jpg`); i++; shots++; }
      out.exportFrames = i;
    }
  } catch (e) {
    fails.push(`footage: ${String((e as Error)?.stack ?? e)}`);
  }
  out.shots = shots;
  return { fails, ...out };
}

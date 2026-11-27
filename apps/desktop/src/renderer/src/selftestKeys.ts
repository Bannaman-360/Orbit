// Keyframes: changing a setting while on one keyframe changes that keyframe only. Two keyframes
// on a 360 clip and on a regular clip; the playhead goes to the second (as clicking it in the
// list does), then every slider in every panel is moved in turn: the first keyframe must stay as
// it was. Runs hidden.

import { addClip, emptyTimeline, newClip, type Keyframe, type TimelineClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { openSection } from './ui';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = <T extends HTMLElement = HTMLElement>(q: string, root: ParentNode = document) => [...root.querySelectorAll<T>(q)];
const setRange = (el: HTMLInputElement, v: number) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
/** Settings of the recording itself, which rightly change every keyframe. */
const WHOLE_CLIP = ['Lens details ▸ Recorded width'];
const PANELS = ['reframe', 'stabilize', 'color', 'effects', 'clip'];

export async function keysCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();

  for (const name of ['GS010113.360', 'GX010133.MP4']) {
    const path = all.find((f) => f.endsWith(`max2/${name}`));
    if (!path) { out[name] = 'skipped (missing)'; continue; }
    const m = await getMedia(path);
    await api.importPaths([m.path]);
    // (Set up as the app sets up a new clip: regular clips start reframable, through their lens.)
    const made = { ...newClip(m.path, m.durationUs, m.is360), ...(m.is360 ? {} : { fit: 'fit' as const }) };
    const base = m.lens ? { ...made, lensMode: 'source' as const, look: { ...made.look, fov: m.lens.hfov } } : made;
    const k1: Keyframe = { id: 'kA', t: 1 * S, look: { ...base.look }, easing: 'smooth' };
    const k2: Keyframe = { id: 'kB', t: 3 * S, look: { ...base.look }, easing: 'smooth' };
    api.setTimeline(addClip(emptyTimeline(), { ...base, keyframes: [k1, k2] }));
    await sleep(500);
    const clip = (): TimelineClip => api.getTimeline().clips[0]!;
    const leaks: string[] = [], missed: string[] = [], added: string[] = [];
    let tried = 0;
    for (const panel of PANELS) {
      document.querySelector<HTMLElement>(`.dock-tab[data-panel="${panel}"]`)?.click();
      await sleep(250);
      const body = document.querySelector(`[data-panel-body="${panel}"]`);
      if (!body) continue;
      for (const s of $$('[data-section]', body)) openSection(s.dataset.section!);
      await sleep(300);
      const sliders = $$<HTMLInputElement>('input[type="range"]', body).filter((x) => !x.disabled);
      for (const el of sliders) {
        const label = `${panel} ▸ ${el.closest('[data-section]')?.getAttribute('data-section')} ▸ ${el.getAttribute('aria-label')}`;
        // On the second keyframe, as clicking it in the list (Reframe ▸ Keyframes) does.
        const row = $$<HTMLButtonElement>('.kf-row button[title="Go to this keyframe"]')[1];
        if (row) row.click(); else api.player.seek(3 * S);
        await sleep(150);
        if (Math.abs(api.player.time - 3 * S) > 1000) (out[`${name} playhead off the keyframe`] ??= [] as unknown[]) && (out[`${name} playhead off the keyframe`] as unknown[]).push([label, api.player.time, !!row]);
        const before = clip();
        const a0 = JSON.stringify(before.keyframes.find((k) => k.id === 'kA')?.look);
        const b0 = JSON.stringify(before.keyframes.find((k) => k.id === 'kB')?.look);
        const min = +el.min, max = +el.max, v = +el.value;
        const to = v + (max - min) * 0.23 <= max ? v + (max - min) * 0.23 : v - (max - min) * 0.23;
        setRange(el, to);
        await sleep(120);
        tried++;
        const after = clip();
        if (after === before) continue; // not a clip setting (or nothing changed)
        const a1 = JSON.stringify(after.keyframes.find((k) => k.id === 'kA')?.look);
        const b1 = JSON.stringify(after.keyframes.find((k) => k.id === 'kB')?.look);
        if (after.keyframes.length !== before.keyframes.length) added.push(`${label} (${before.keyframes.length}→${after.keyframes.length})`);
        if (a1 !== a0 && !WHOLE_CLIP.some((w) => label.endsWith(w))) leaks.push(label);
        else if (b1 === b0 && after.keyframes.length === before.keyframes.length) missed.push(label);
        // Back to the two plain keyframes for the next one.
        api.setTimeline(addClip(emptyTimeline(), { ...base, keyframes: [k1, k2] }));
        await sleep(150);
      }
    }
    // The choice buttons and switches too.
    const seen = new Set<string>();
    const labelOf = (panel: string, x: HTMLElement) => `${panel} ▸ ${x.closest('[data-section]')?.getAttribute('data-section')} ▸ ${x.textContent?.trim() || x.closest('label')?.textContent?.trim()}`;
    for (const panel of PANELS) {
      document.querySelector<HTMLElement>(`.dock-tab[data-panel="${panel}"]`)?.click();
      await sleep(250);
      const body = document.querySelector(`[data-panel-body="${panel}"]`);
      if (!body) continue;
      for (const s of $$('[data-section]', body)) openSection(s.dataset.section!);
      await sleep(300);
      const labels = [...$$<HTMLElement>('.seg button:not(.on):not(:disabled), label.check input[type="checkbox"]:not(:disabled)', body)].map((x) => labelOf(panel, x));
      for (const label of labels) {
        if (seen.has(label)) continue;
        seen.add(label);
        const row = $$<HTMLButtonElement>('.kf-row button[title="Go to this keyframe"]')[1];
        if (row) row.click(); else api.player.seek(3 * S);
        await sleep(150);
        const before = clip();
        const a0 = JSON.stringify(before.keyframes.find((k) => k.id === 'kA')?.look);
        const b0 = JSON.stringify(before.keyframes.find((k) => k.id === 'kB')?.look);
        // (Found again: resetting the timeline draws the controls anew.)
        const live = $$<HTMLElement>('.seg button, label.check input[type="checkbox"]', document.querySelector(`[data-panel-body="${panel}"]`) ?? document).find((x) => labelOf(panel, x) === label);
        if (!live) continue;
        live.click();
        await sleep(150);
        tried++;
        const after = clip();
        if (after !== before) {
          const a1 = JSON.stringify(after.keyframes.find((k) => k.id === 'kA')?.look);
          const b1 = JSON.stringify(after.keyframes.find((k) => k.id === 'kB')?.look);
          if (a1 !== a0 && !WHOLE_CLIP.some((w) => label.endsWith(w))) leaks.push(label);
          else if (b1 === b0) missed.push(label);
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        api.setTimeline(addClip(emptyTimeline(), { ...base, keyframes: [k1, k2] }));
        await sleep(150);
      }
    }
    out[`${name} sliders tried`] = tried;
    out[`${name} clip-wide (not keyframed)`] = missed;
    ok(`${name}: on the second keyframe, no slider changes the first`, !leaks.length, leaks);
    ok(`${name}: and none adds a keyframe`, !added.length, added);
  }
  await variants(api, ok, out);
  await typedThenDiamond(api, ok, out);
  return { fails, ...out };
}

/**
 * The same with the clip sped up, slowed down, trimmed and second on the timeline, reaching the
 * keyframe by the list, by "next keyframe", and with the playhead between keyframes.
 */
async function variants(api: EditorApi, ok: (n: string, pass: boolean, info?: unknown) => void, out: Record<string, unknown>) {
  const all = await ace.listFixtures();
  const path = all.find((f) => f.endsWith('max2/GS010113.360'))!;
  const m = await getMedia(path);
  const plain = newClip(m.path, m.durationUs, true);
  const k = (id: string, t: number): Keyframe => ({ id, t, look: { ...plain.look }, easing: 'smooth' });
  const cases: [string, Partial<TimelineClip>, boolean][] = [
    ['plain', {}, false], ['speed 2×', { speed: 2 }, false], ['speed 0.5×', { speed: 0.5 }, false], ['speed 0.37×', { speed: 0.37 }, false],
    ['ramp', { speedKeys: [{ id: 's1', t: 0, speed: 1 }, { id: 's2', t: 2 * S, speed: 0.3 }] as TimelineClip['speedKeys'] }, false],
    ['trimmed', { inUs: 0.4 * S }, false], ['second on the timeline', {}, true], ['second, trimmed, 1.5×', { inUs: 0.55 * S, speed: 1.5 }, true],
  ];
  const report: string[] = [];
  for (const [name, patch, second] of cases) {
    for (const how of ['list', 'next', 'between', 'on first'] as const) {
      const clip = { ...plain, id: 'cX', ...patch, keyframes: [k('kA', 1 * S), k('kB', 3 * S)] };
      const tl = second ? addClip(addClip(emptyTimeline(), { ...plain, id: 'c0', outUs: 1.7 * S }), clip) : addClip(emptyTimeline(), clip);
      api.setTimeline(tl);
      await sleep(250);
      document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
      await sleep(150);
      const startUs = second ? 1.7 * S : 0;
      api.player.seek(startUs + 1000);
      await sleep(150);
      if (how === 'list' || how === 'on first') {
        openSection('Keyframes');
        await sleep(150);
        $$<HTMLButtonElement>('.kf-row button[title="Go to this keyframe"]')[how === 'list' ? 1 : 0]?.click();
      } else if (how === 'next') { api.run!('nextKey'); await sleep(100); api.run!('nextKey'); }
      else {
        // Half way between the keyframes, in the clip's own time.
        const c = api.getTimeline().clips.find((x) => x.id === 'cX')!;
        const { localAt } = await import('@ace/project');
        api.player.seek(startUs + localAt(c, 2 * S));
      }
      await sleep(200);
      openSection('View');
      await sleep(150);
      const pan = $$<HTMLInputElement>('[data-panel-body="reframe"] input[type="range"][aria-label="Pan"]')[0];
      if (!pan) { report.push(`${name} / ${how}: no Pan slider`); continue; }
      setRange(pan, 77);
      await sleep(200);
      const c = api.getTimeline().clips.find((x) => x.id === 'cX')!;
      const yaw = (id: string) => c.keyframes.find((x) => x.id === id)?.look.yaw;
      const fresh = c.keyframes.filter((x) => x.id !== 'kA' && x.id !== 'kB');
      const want = how === 'list' || how === 'next' ? 'kB' : how === 'on first' ? 'kA' : 'new';
      const got = fresh.length ? `new at ${(fresh[0]!.t / S).toFixed(3)}s` : yaw('kA') === 77 && yaw('kB') === 77 ? 'both' : yaw('kA') === 77 ? 'kA' : yaw('kB') === 77 ? 'kB' : 'none';
      const good = want === 'new' ? got.startsWith('new') && yaw('kA') !== 77 && yaw('kB') !== 77 : got === want;
      report.push(`${good ? 'ok  ' : 'BAD '} ${name} / ${how}: changed ${got} (want ${want}), playhead ${(api.player.time / S).toFixed(4)}s`);
    }
  }
  out.variants = report;
  ok('each case changes the right keyframe', report.every((r) => r.startsWith('ok')), report.filter((r) => !r.startsWith('ok')));
}

/**
 * A value typed in a slider's box and then a click on another keyframe's ◆: the value belongs to
 * the keyframe it was typed on (the box saves when it loses focus, which the click causes only
 * after the playhead has moved). A box opened and left unchanged changes nothing.
 */
async function typedThenDiamond(api: EditorApi, ok: (n: string, pass: boolean, info?: unknown) => void, out: Record<string, unknown>) {
  const all = await ace.listFixtures();
  const m = await getMedia(all.find((f) => f.endsWith('max2/GS010113.360'))!);
  const plain = newClip(m.path, m.durationUs, true);
  const k = (id: string, t: number): Keyframe => ({ id, t, look: { ...plain.look }, easing: 'smooth' });
  const reset = async () => { api.setTimeline(addClip(emptyTimeline(), { ...plain, id: 'cT', keyframes: [k('kA', 1 * S), k('kB', 3 * S)] })); await sleep(250); api.player.seek(1 * S); await sleep(200); };
  const yaw = (id: string) => api.getTimeline().clips[0]!.keyframes.find((x) => x.id === id)?.look.yaw;
  const keys = () => api.getTimeline().clips[0]!.keyframes.map((x) => `${x.id}@${(x.t / S).toFixed(2)} yaw ${x.look.yaw}`);
  const panBox = () => document.querySelector<HTMLElement>('[data-panel-body="reframe"] [data-section="View"] .slider:first-of-type .num');
  /** A real click on a ◆: pointer down (where the app acts), then focus moves, as in a browser. */
  const clickDiamond = (i: number) => {
    const d = $$<HTMLButtonElement>('.clip-kf')[i]!;
    const r = d.getBoundingClientRect(), at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1 };
    d.dispatchEvent(new PointerEvent('pointerdown', at));
    // (What the browser then does on mouse down: the box loses focus. A hidden window has no
    // focus of its own, so this is done by hand.)
    const box = document.querySelector<HTMLInputElement>('input.num-edit');
    if (box) { if (document.activeElement === box) box.blur(); else box.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }
    d.focus();
    d.dispatchEvent(new PointerEvent('pointerup', at));
    d.dispatchEvent(new MouseEvent('click', at));
  };
  document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
  await reset();
  openSection('View');
  await sleep(200);
  panBox()?.click();
  await sleep(100);
  const field = document.querySelector<HTMLInputElement>('input.num-edit');
  ok('a slider’s value box opens for typing', !!field);
  if (!field) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '33');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);
  clickDiamond(1);
  await sleep(300);
  out['typed, then ◆'] = keys();
  ok('a value typed on one keyframe stays on it when another ◆ is clicked', yaw('kA') === 33 && yaw('kB') === 0 && api.getTimeline().clips[0]!.keyframes.length === 2, keys());
  ok('and the playhead goes to the clicked ◆', Math.abs(api.player.time - 3 * S) < 1000, api.player.time);

  await reset();
  openSection('View');
  await sleep(200);
  api.player.seek(2 * S); // between the keyframes
  await sleep(200);
  panBox()?.click();
  await sleep(100);
  clickDiamond(1);
  await sleep(300);
  out['opened, unchanged, then ◆'] = keys();
  ok('a value box opened and left as it was changes nothing', JSON.stringify(keys()) === JSON.stringify(['kA@1.00 yaw 0', 'kB@3.00 yaw 0']), keys());
}

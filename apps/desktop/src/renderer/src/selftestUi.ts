// Interface self-test: uses real mouse and key input to move, restyle and rebind everything, and
// checks that the preview survives it all. Screenshots go to selftest-out/ui-*.png.

import { addClip, emptyTimeline, newClip, newGaugeOverlay, newTextOverlay, timelineDuration } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { groupsOf, groupWith, openPanels } from './ui/dockModel';
import { BUILTIN_THEMES, defaultPrefs, getPrefs, sectionList, setPrefs, setTheme } from './ui/prefs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const S = 1_000_000;
type Pt = { x: number; y: number };
const $ = (s: string) => document.querySelector<HTMLElement>(s);
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const mid = (el: Element | null | undefined): Pt => { if (!el) throw new Error('element not found'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };

async function mouse(type: 'mouseDown' | 'mouseUp' | 'mouseMove', p: Pt, mods: string[] = [], button = 'left') {
  await ace.selftestInput({ type, x: Math.round(p.x), y: Math.round(p.y), button, clickCount: 1, modifiers: [...mods, ...(type === 'mouseMove' ? [] : [])] });
}
async function drag(a: Pt, b: Pt, mods: string[] = []) {
  await mouse('mouseMove', a, mods);
  await mouse('mouseDown', a, mods);
  for (let i = 1; i <= 8; i++) { await ace.selftestInput({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * i) / 8), y: Math.round(a.y + ((b.y - a.y) * i) / 8), button: 'left', modifiers: [...mods, 'leftButtonDown'] }); await sleep(16); }
  await sleep(120);
  await mouse('mouseUp', b, mods);
  await sleep(250);
}
async function click(p: Pt, button = 'left') {
  await mouse('mouseMove', p);
  await ace.selftestInput({ type: 'mouseDown', x: p.x, y: p.y, button, clickCount: 1 });
  await ace.selftestInput({ type: 'mouseUp', x: p.x, y: p.y, button, clickCount: 1 });
  await sleep(220);
}
async function press(key: string, modifiers: string[] = []) {
  await ace.selftestInput({ type: 'keyDown', keyCode: key, modifiers });
  await ace.selftestInput({ type: 'keyUp', keyCode: key, modifiers });
  await sleep(200);
}

export async function uiCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (name: string, pass: boolean, info: unknown = undefined) => { out[name] = pass ? 'ok' : { FAILED: info ?? true }; if (!pass) fails.push(name); };
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

  setPrefs(defaultPrefs());
  const files = (await ace.listFixtures()).filter((f) => /\.360$/i.test(f) && !/[\\/]synthetic[\\/]/.test(f));
  const media = await getMedia(files[0]!);
  await api.importPaths(files.slice(0, 5));
  let tl = addClip(emptyTimeline(), { ...newClip(media.path, media.durationUs, true), outUs: 6 * S }, 0);
  tl = addClip(tl, { ...newClip(media.path, media.durationUs, true), inUs: 8 * S, outUs: 12 * S }, 1);
  const total = timelineDuration(tl);
  const title = newTextOverlay(0, 4 * S, 'Title');
  api.setTimeline({ ...tl, overlays: [title, newGaugeOverlay('speed', 0, total)] });
  api.player.seek(2 * S);
  await sleep(1500);

  const canvas = $('.frame canvas.layer') as HTMLCanvasElement;
  /** The preview is the same element, is showing, and still draws. */
  const alive = async () => {
    if ($('.frame canvas.layer') !== canvas || canvas.clientWidth < 40) return `gone or tiny (${canvas.clientWidth})`;
    let n = 0, on = true;
    void (async () => { while (on) { await api.nextRender(); n++; } })();
    await sleep(300);
    on = false;
    return n > 5 ? '' : `only ${n} frames drawn`;
  };
  const tab = (id: string) => $(`.dock-tab[data-panel="${id}"]`);
  const rect = (id: string) => $(`[data-panel-body="${id}"]`)!.getBoundingClientRect();

  // --- Panels ----------------------------------------------------------------------------------
  await ace.capture('ui-default');
  {
    const v = rect('viewer');
    await drag(mid(tab('color')), { x: v.left + 30, y: v.top + v.height / 2 });
    ok('drag a tab beside the preview', groupWith(getPrefs().layout, 'color')!.panels.length === 1 && rect('color').right <= rect('viewer').left + 1, groupsOf(getPrefs().layout).map((g) => g.panels));
    ok('preview survives that', !(await alive()), await alive());
  }
  {
    const before = rect('viewer').left;
    const g = mid($('.dock-group.bare .dock-grabber'));
    const media0 = rect('media');
    await drag(g, { x: media0.left + 12, y: media0.top + media0.height / 2 });
    ok('move the preview by its handle', rect('viewer').left < before, [before, rect('viewer').left]);
    ok('preview survives moving', !(await alive()), await alive());
    await ace.capture('ui-moved');
  }
  {
    const t = mid(tab('media')), d = $('.dock')!.getBoundingClientRect();
    await drag(t, { x: d.right - 5, y: d.top + d.height / 2 });
    ok('dock a panel to the window edge', Math.abs(rect('media').right - d.right) < 4, rect('media').right);
    await drag(mid(tab('media')), { x: 700, y: 400 }, ['alt']);
    const f0 = getPrefs().layout.floats.length;
    ok('float a panel with Option', f0 === 1, f0);
    const bar = $('.dock-group.floating .dock-bar .dock-grow');
    const r0 = $('.dock-group.floating')!.getBoundingClientRect();
    if (bar) await drag(mid(bar), { x: mid(bar).x - 160, y: mid(bar).y - 60 });
    ok('move a floating panel', Math.abs($('.dock-group.floating')!.getBoundingClientRect().left - (r0.left - 160)) < 6, [$('.dock-group.floating')!.getBoundingClientRect().left, r0.left]);
    await drag(mid($('.dock-resize')), { x: mid($('.dock-resize')).x + 70, y: mid($('.dock-resize')).y + 40 });
    ok('resize a floating panel', Math.abs($('.dock-group.floating')!.getBoundingClientRect().width - r0.width - 70) < 6);
    await ace.capture('ui-floating');
    const v = rect('timeline');
    await drag(mid(tab('media')), { x: v.left + v.width / 2, y: v.top + v.height / 2 });
    ok('drop a panel into another as a tab', groupWith(getPrefs().layout, 'media') === groupWith(getPrefs().layout, 'timeline'));
    await click(mid(tab('timeline')));
    ok('switch tabs', !!$('.timeline .clip'));
  }
  {
    const w0 = rect('color').width;
    const gutter = $$('.dock-gutter.row').find((g) => Math.abs(g.getBoundingClientRect().left - rect('color').right) < 14) ?? $('.dock-gutter.row');
    const g = mid(gutter);
    await drag(g, { x: g.x + 60, y: g.y });
    ok('resize panels', Math.abs(rect('color').width - w0) > 30, [w0, rect('color').width]);
    await click(mid(tab('color')), 'right');
    const close = $$('.menu button').find((b) => b.textContent?.includes('Close panel'));
    await click(mid(close));
    ok('close a panel from its menu', !openPanels(getPrefs().layout).includes('color'));
  }
  setPrefs({ layout: defaultPrefs().layout });
  await sleep(300);
  ok('preview survives resetting', !(await alive()), await alive());

  // --- Toolbars --------------------------------------------------------------------------------
  {
    const t = $('.bar-timeline')!.getBoundingClientRect();
    await drag(mid($('.bar-main [data-item="grab"]')), { x: t.left + 14, y: t.top + t.height / 2 }, ['meta']);
    ok('Cmd-drag an item to another toolbar', getPrefs().bars.timeline.items[0] === 'grab' && !getPrefs().bars.main.items.includes('grab'), getPrefs().bars);
    api.run!('arrange');
    await sleep(400);
    await ace.capture('ui-arrange');
    await drag(mid($('.bar-timeline [data-item="grab"]')), { x: 700, y: 300 });
    ok('drag an item off to remove it', !Object.values(getPrefs().bars).some((b) => b.items.includes('grab')));
    const pal = $$('.pal-item').find((p) => p.textContent?.includes('Keyframe') && !p.textContent.includes('Previous') && !p.textContent.includes('Next'));
    const m = $('.bar-main')!.getBoundingClientRect();
    await drag(mid(pal), { x: mid($('.bar-main [data-item="undo"]')).x - 12, y: m.top + m.height / 2 });
    ok('add an item from the palette', getPrefs().bars.main.items.includes('keyframe'), getPrefs().bars.main.items);
    const tbefore = api.getTimeline();
    await click(mid($('.bar-main [data-item="undo"]')));
    ok('buttons do nothing while arranging', api.getTimeline() === tbefore);

    // --- Sections and rows -----------------------------------------------------------------------
    await click(mid($('[data-section="View"] .section-toggle')));
    if (!$('[data-section="View"] .panel-section.open')) await click(mid($('[data-section="View"] .section-toggle')));
    const rows = () => $$('[data-rows="View"] > [data-row]').map((r) => r.dataset.row);
    const r0 = rows();
    await drag(mid($('[data-rows="View"] > [data-row]:nth-child(3) .grip')), { x: mid($('[data-rows="View"] > [data-row]:first-child')).x, y: mid($('[data-rows="View"] > [data-row]:first-child')).y - 8 });
    ok('reorder controls in a section', rows()[0] === r0[2], [r0, rows()]);
    await click(mid($('[data-rows="View"] > [data-row]:nth-child(2) > .ghost:last-child')));
    await ace.capture('ui-arrange-rows');
    await press('Escape');
    ok('Escape leaves arrange mode', document.documentElement.dataset.arrange === 'off');
    const labels = $$('[data-section="View"] .slider-label').map((e) => e.textContent);
    ok('order and hidden control apply', labels.length === 2 && labels[0] === 'Roll', labels);
  }
  {
    const wasOpen = !!$('[data-section="Lens"] .panel-section.open');
    const lens = mid($('[data-section="Lens"] .section-toggle')), kf = $('[data-section="Keyframes"]')!.getBoundingClientRect();
    await drag(lens, { x: lens.x, y: kf.top + 3 });
    ok('reorder sections', sectionList(getPrefs(), 'reframe')[0] === 'Lens', sectionList(getPrefs(), 'reframe'));
    ok('dragging a section does not toggle it', !!$('[data-section="Lens"] .panel-section.open') === wasOpen);
    // Two panels side by side: move a section across.
    const v = rect('viewer');
    await drag(mid(tab('color')), { x: v.right - 30, y: v.top + v.height / 2 });
    const target = $('[data-section-list="color"]')!.getBoundingClientRect();
    await drag(mid($('[data-section="Lens"] .section-toggle')), { x: target.left + target.width / 2, y: target.top + 5 });
    ok('move a section to another panel', sectionList(getPrefs(), 'color')[0] === 'Lens' && !sectionList(getPrefs(), 'reframe').includes('Lens'), sectionList(getPrefs(), 'color'));
    const toggle = $('[data-section="Lens"] .section-toggle')!;
    if (!$('[data-section="Lens"] .panel-section.open')) await click(mid(toggle));
    const fov = $('[data-section-list="color"] input[aria-label="Field of view"]');
    ok('a moved section still works', !!fov);
    if (fov) {
      const r = fov.getBoundingClientRect(), f0 = api.getTimeline().clips[0]!.look.fov;
      await click({ x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height / 2) });
      ok('its slider edits the clip', api.getTimeline().clips[0]!.look.fov !== f0, f0);
    }
    await ace.capture('ui-sections-moved');
  }
  setPrefs(defaultPrefs());
  await sleep(300);

  // --- Selecting brings up its settings -------------------------------------------------------------
  {
    await click(mid($('.ov-item.is-text')));
    ok('selecting text shows its settings', !!$('[data-panel-body="selection"] textarea') && !!$('.dock-tab.on[data-panel="selection"]'));
    await ace.capture('ui-selection');
    await click(mid(tab('color')));
    ok('another tab can still be opened', !!$('[data-section-list="color"]'));
    await press('Escape');
    await sleep(150);
    ok('the tab goes away when nothing is selected', !tab('selection'));
  }

  // --- Shortcuts --------------------------------------------------------------------------------------
  {
    await click(mid(tab('reframe')));
    const n0 = api.getTimeline().clips.length;
    setPrefs({ shortcuts: { split: 'X' } });
    await press('s');
    const afterS = api.getTimeline().clips.length;
    await press('x');
    ok('changed shortcut works, old one does not', afterS === n0 && api.getTimeline().clips.length === n0 + 1, [n0, afterS, api.getTimeline().clips.length]);
    await press('z', ['meta']);
    ok('undo', api.getTimeline().clips.length === n0);
    await press('Space');
    const playing = api.player.playing;
    await press('Space');
    ok('Space plays and pauses', playing && !api.player.playing);
    const b = $('.bar-transport [data-item="start"]');
    b?.focus();
    const t = api.player.time;
    await press('Space');
    ok('Space never presses a focused button', api.player.playing, [t, api.player.time]);
    await press('Space');
    setPrefs({ shortcuts: {} });
  }

  // --- Frame rate and locks --------------------------------------------------------------------------------
  {
    await press('Escape');
    const slow = await getMedia(files.find((f) => f.endsWith('GS010120.360'))!);
    const keep = api.getTimeline();
    const pts = Array.from({ length: 61 }, (_, i) => ({ t: 2 * S + (i * S) / 20, yaw: i * 0.5, pitch: 0, size: 12 }));
    api.setTimeline(addClip(emptyTimeline(), { ...newClip(slow.path, slow.durationUs, true), track: { space: 'world', points: pts, smoothing: 0.2, offsetYaw: 0, offsetPitch: 0, autoZoom: 1, subjectFrac: 0.1 } }, 0));
    api.player.seek(1 * S);
    await sleep(900);
    const fps = () => $('.fps')!.textContent;
    ok('shows the clip’s own frame rate', fps() === '24 fps', fps());
    api.player.play();
    await sleep(2300);
    const playingFps = fps();
    api.player.pause();
    ok('also while playing', playingFps === '24 fps', playingFps);
    await click(mid(tab('reframe')));
    for (const id of ['View', 'Lens', 'Subject tracking']) if (!$(`[data-section="${id}"] .panel-section.open`)) { const el = $(`[data-section="${id}"] .section-toggle`)!; el.scrollIntoView({ block: 'center' }); await sleep(80); await click(mid(el)); }
    const lockOf = (label: string) => $$('.slider').find((x) => x.querySelector('.slider-name')?.textContent === label)?.querySelector<HTMLElement>('.lock');
    const inputOf = (label: string) => $(`input[aria-label="${label}"]`) as HTMLInputElement;
    api.player.seek(1 * S);
    await sleep(300);
    ok('nothing locked before the tracked part', ['Pan', 'Tilt', 'Roll', 'Field of view', 'Fisheye'].every((l) => !lockOf(l) && !inputOf(l).disabled));
    api.player.seek(3.5 * S);
    await sleep(300);
    ok('pan, tilt and zoom are locked while following', ['Pan', 'Tilt', 'Field of view'].every((l) => !!lockOf(l) && inputOf(l).disabled), ['Pan', 'Tilt', 'Field of view'].map((l) => !!lockOf(l)));
    ok('roll is not', !lockOf('Roll') && !inputOf('Roll').disabled);
    lockOf('Tilt')!.scrollIntoView({ block: 'center' });
    await sleep(150);
    await mouse('mouseMove', mid(lockOf('Tilt')));
    await sleep(250);
    ok('hovering the lock explains why', !!$('.tip')?.textContent?.includes('Subject tracking sets the tilt here'), $('.tip')?.textContent);
    await ace.capture('ui-lock');
    await mouse('mouseMove', { x: 500, y: 300 });
    await sleep(200);
    ok('and goes away again', !$('.tip'));
    const c0 = () => api.getTimeline().clips[0]!;
    const shift = inputOf('Shift up');
    shift.scrollIntoView({ block: 'center' });
    await sleep(120);
    const r = shift.getBoundingClientRect();
    await click({ x: Math.round(r.left + r.width * 0.7), y: Math.round(r.top + r.height / 2) });
    ok('Shift up moves the framing instead', c0().track!.offsetPitch > 5, c0().track!.offsetPitch);
    // Auto zoom off: zoom is free, and what depends on it is locked.
    api.setTimeline({ ...api.getTimeline(), clips: [{ ...c0(), track: { ...c0().track!, autoZoom: 0 } }] });
    await sleep(300);
    ok('zoom unlocks when auto zoom is off', !lockOf('Field of view') && !!lockOf('Subject size') && !!lockOf('Widest zoom'));
    api.setTimeline(keep);
    await sleep(300);
    // A toolbar button that can't be used says why.
    api.setTimeline(emptyTimeline());
    await sleep(300);
    const ex = $('.bar-main [data-item="export"]')!;
    const sp = $('.bar-timeline [data-item="split"]')!;
    for (let k = 0; k < 3; k++) { await mouse('mouseMove', { x: mid(sp).x + k, y: mid(sp).y }); await sleep(120); }
    ok('a locked toolbar button explains itself', !!sp.querySelector('.tool-lock') && !!$('.tip')?.textContent?.includes('Add a clip'), $('.tip')?.textContent);
    for (let k = 0; k < 4; k++) { await mouse('mouseMove', { x: mid(ex).x + k * 2, y: mid(ex).y }); await sleep(120); }
    ok('in the top toolbar too', !!ex.querySelector('.tool-lock') && !!$('.tip')?.textContent?.includes('Add a clip'), $$('.tip').length);
    await ace.capture('ui-lock-toolbar');
    await click(mid(ex));
    ok('and does nothing when clicked', !$('.modal'));
    await mouse('mouseMove', { x: 500, y: 300 });
    api.setTimeline(keep);
    api.player.seek(2 * S);
    await sleep(600);
  }

  // --- Before / after -----------------------------------------------------------------------------------
  {
    await press('Escape');
    const t0 = api.getTimeline();
    api.player.seek(2 * S);
    await sleep(300);
    const avg = async () => {
      await api.nextRender();
      await api.nextRender();
      const o = new OffscreenCanvas(16, 9), x = o.getContext('2d')!;
      const bmp = await createImageBitmap(canvas);
      x.drawImage(bmp, 0, 0, 16, 9);
      const d = x.getImageData(0, 0, 16, 9).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i]! + d[i + 1]! + d[i + 2]!;
      return s / (d.length / 4) / 3;
    };
    const look0 = t0.clips[0]!.look;
    const plain = await avg();
    api.setTimeline({ ...t0, clips: t0.clips.map((c, i) => (i ? c : { ...c, keyframes: [], look: { ...look0, grade: { ...look0.grade, exposure: -3, saturation: -1 }, fx: { ...look0.fx, bars: 1, grain: 1, glow: 1 }, motionBlur: 0 } })) });
    await sleep(300);
    const graded = await avg();
    const tl1 = api.getTimeline();
    const b = mid($('.bar-transport [data-item="compare"]'));
    await mouse('mouseMove', b);
    await mouse('mouseDown', b);
    await sleep(250);
    const held = await avg();
    ok('the Before label shows', !!$('.compare-tag'));
    await ace.capture('ui-compare');
    await mouse('mouseMove', { x: b.x - 200, y: b.y - 200 });
    await mouse('mouseUp', { x: b.x - 200, y: b.y - 200 }); // let go somewhere else
    await sleep(250);
    const after = await avg();
    ok('holding shows the untouched picture', Math.abs(held - plain) < 1.5 && Math.abs(graded - plain) > 8, { plain, graded, held, after });
    ok('letting go brings the effects back', Math.abs(after - graded) < 1.5 && !$('.compare-tag'), { graded, after });
    await ace.selftestInput({ type: 'keyDown', keyCode: 'b' });
    await sleep(250);
    const keyHeld = await avg();
    await ace.selftestInput({ type: 'keyUp', keyCode: 'b' });
    await sleep(250);
    ok('so does holding the key', Math.abs(keyHeld - plain) < 1.5 && Math.abs((await avg()) - graded) < 1.5, { plain, keyHeld, now: await avg() });
    ok('comparing never edits anything', api.getTimeline() === tl1);
    api.setTimeline(t0);
    await sleep(200);
  }

  // --- Customize window ---------------------------------------------------------------------------------
  {
    await press(',', ['meta']);
    ok('Cmd-comma opens Customize', !!$('.cz'));
    const pages = $$('.cz-nav').slice(0, 10);
    for (const p of pages) {
      await click(mid(p));
      await ace.capture(`ui-cz-${p.textContent!.toLowerCase().replace(/[^a-z]+/g, '-')}`);
    }
    ok('ten pages', pages.length === 10);
    await click(mid($$('.cz-nav')[2]));
    const radius0 = getPrefs().theme.sliders;
    await click(mid($$('.cz-sample')[4]));
    ok('choosing a slider style applies it', getPrefs().theme.sliders !== radius0 && document.documentElement.dataset.sliders === getPrefs().theme.sliders);
    await click(mid($$('.cz-nav').at(-1)));
    ok('undo a change', getPrefs().theme.sliders === radius0);
    // Recording a shortcut in the window.
    await click(mid($$('.cz-nav')[9]));
    const row = () => $$('.cz-row').find((r) => r.textContent?.startsWith('Split at the'))!;
    row().scrollIntoView({ block: 'center' });
    await sleep(100);
    await click(mid(row().querySelector('.cz-key')));
    await press('j', ['meta']);
    await sleep(100);
    ok('record a shortcut', getPrefs().shortcuts.split === 'Mod+J', getPrefs().shortcuts);
    // A combination of two ordinary keys, as a second shortcut.
    await click(mid(row().querySelector('.cz-add')));
    await ace.selftestInput({ type: 'keyDown', keyCode: 'g' });
    await sleep(80);
    await ace.selftestInput({ type: 'keyDown', keyCode: 'h' });
    await sleep(80);
    await ace.capture('ui-recording');
    await ace.selftestInput({ type: 'keyUp', keyCode: 'h' });
    await ace.selftestInput({ type: 'keyUp', keyCode: 'g' });
    await sleep(250);
    ok('record a combination', getPrefs().shortcuts.split === 'Mod+J G+H', getPrefs().shortcuts);
    await ace.capture('ui-combos');
    await click(mid($$('.cz-nav')[6]));
    const np = $$('.cz-body button').find((b) => b.textContent?.includes('New panel'));
    np?.scrollIntoView({ block: 'center' });
    await sleep(100);
    await click(mid(np));
    const custom = getPrefs().customPanels[0];
    ok('make your own panel', !!custom && openPanels(getPrefs().layout).includes(custom.id));
    await click(mid($('.cz-close')));
    ok('close Customize', !$('.cz'));
    // The recorded combination does its job; its keys alone do nothing.
    const n = api.getTimeline().clips.length;
    await press('g');
    await press('h');
    ok('one key of a combination does nothing', api.getTimeline().clips.length === n);
    await ace.selftestInput({ type: 'keyDown', keyCode: 'h' });
    await sleep(60);
    await ace.selftestInput({ type: 'keyDown', keyCode: 'g' });
    await sleep(60);
    await ace.selftestInput({ type: 'keyUp', keyCode: 'g' });
    await ace.selftestInput({ type: 'keyUp', keyCode: 'h' });
    await sleep(250);
    ok('the combination works (either order)', api.getTimeline().clips.length === n + 1, api.getTimeline().clips.length);
    api.run!('undo');
    await sleep(150);
  }
  // --- Keyframes on the timeline -----------------------------------------------------------------------------
  {
    setPrefs({ shortcuts: {} });
    const c0 = () => api.getTimeline().clips[0]!;
    for (const t of [1, 2, 3]) { api.player.seek(t * S); await sleep(250); await press('k'); }
    ok('K adds keyframes', c0().keyframes.length === 3, c0().keyframes.length);
    const dots = () => $$('.video-track .clip-kf');
    ok('a diamond for each', dots().length === 3);
    await click(mid(dots()[1]));
    ok('clicking a diamond goes there', Math.abs(api.player.time - 2 * S) < 60_000, api.player.time);
    ok('and picks it', !!$('.clip-kf.selected'));
    const d = mid(dots()[1]), t0 = c0().keyframes[1]!.t;
    await drag(d, { x: d.x + 40, y: d.y });
    ok('drag a keyframe', c0().keyframes[1]!.t > t0 + 100_000 && c0().keyframes.length === 3, [t0, c0().keyframes.map((k) => k.t)]);
    const clips = api.getTimeline().clips.length, order = api.getTimeline().clips.map((c) => c.id).join();
    ok('without moving the clip', api.getTimeline().clips.map((c) => c.id).join() === order);
    await ace.capture('ui-keyframes');
    await press('Backspace');
    ok('Backspace deletes the keyframe, not the clip', c0().keyframes.length === 2 && api.getTimeline().clips.length === clips, [c0().keyframes.length, api.getTimeline().clips.length]);
    await press('z', ['meta']);
    ok('undo brings it back', c0().keyframes.length === 3);
    await click(mid(dots()[0]), 'right');
    await ace.capture('ui-keyframe-menu');
    await click(mid($$('.menu button').find((b) => b.textContent?.includes('Delete keyframe'))));
    ok('delete from the right-click menu', c0().keyframes.length === 2);
    await click(mid(tab('reframe')));
    if (!$('[data-section="Keyframes"] .panel-section.open')) await click(mid($('[data-section="Keyframes"] .section-toggle')));
    await ace.capture('ui-keyframe-list');
    ok('the list shows them', $$('.kf-row').length === 2);
    await click(mid($('.kf-row [aria-label="Delete this keyframe"]')));
    ok('delete from the list', c0().keyframes.length === 1);
    api.player.seek(c0().keyframes[0]!.t);
    await sleep(250);
    await press('K', ['shift']);
    ok('Shift-K deletes the last one', c0().keyframes.length === 0, c0().keyframes.length);
    // Away from any keyframe, Backspace deletes the clip as before.
    api.player.seek(1.3 * S);
    await sleep(200);
    await press('k');
    api.player.seek(0.2 * S);
    await sleep(250);
    await press('Backspace');
    ok('Backspace elsewhere still deletes the clip', api.getTimeline().clips.length === clips - 1, api.getTimeline().clips.length);
    await press('z', ['meta']);
  }
  setPrefs(defaultPrefs());

  // --- Bars hidden or moved: nothing gets lost ------------------------------------------------------------
  setPrefs((p) => ({ bars: { ...p.bars, main: { ...p.bars.main, hidden: true }, transport: { ...p.bars.transport, position: 'top' }, timeline: { ...p.bars.timeline, position: 'bottom' } } }));
  await sleep(300);
  ok('window can still be dragged without a toolbar', !!$('.titlebar'));
  await ace.capture('ui-bars-moved');
  setPrefs(defaultPrefs());

  // --- A narrow preview: controls that don't fit go into the » menu -----------------------------------------
  {
    const l = defaultPrefs().layout;
    setPrefs({ layout: { ...l, root: { kind: 'split', id: 'r', dir: 'row', sizes: [0.2, 0.8], children: [groupWith(l, 'viewer')!, groupWith(l, 'reframe')!] } } });
    await sleep(400);
    const bar = $('.bar-transport')!;
    const inside = $$('.bar-transport > [data-slot]').filter((e) => e.offsetParent).every((e) => e.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1);
    ok('narrow toolbar keeps its items inside', inside);
    const moreBtn = $('.bar-transport .bar-more');
    ok('and offers the rest in a menu', !!moreBtn);
    if (moreBtn) {
      await click(mid(moreBtn));
      ok('the menu lists them', $$('.menu button').some((b) => b.textContent?.includes('Full screen')), $$('.menu button').map((b) => b.textContent));
      await ace.capture('ui-narrow');
      await press('Escape');
    }
    setPrefs(defaultPrefs());
    await sleep(300);
    ok('it goes away when there is room', !$('.bar-transport .bar-more'));
  }

  // --- Every theme, light and dark, in pictures, with no text cut off in the toolbars -----------------------
  await click(mid(tab('reframe')));
  const overflow: string[] = [];
  for (const [name, t] of BUILTIN_THEMES) {
    for (const mode of t.mode === 'auto' ? (['light', 'dark'] as const) : [t.mode]) {
      setPrefs({ theme: { ...t, mode } });
      await sleep(350);
      for (const b of $$('.bar')) if (b.querySelector('.bar-more') || b.scrollWidth > b.clientWidth + 2) overflow.push(`${name}: ${b.className}`);
      await ace.capture(`ui-theme-${name.toLowerCase().replace(/ /g, '-')}-${mode}`);
    }
  }
  ok('toolbars fit in every theme', !overflow.length, overflow);
  for (const labels of ['both', 'beside', 'text', 'icon'] as const) { setTheme({ ...defaultPrefs().theme, mode: 'dark', toolbarLabels: labels }); await sleep(200); await ace.capture(`ui-labels-${labels}`); }
  ok('preview still alive at the end', !(await alive()), await alive());
  setPrefs(defaultPrefs());
  // Saved and reloaded the same.
  await sleep(500);
  ok('preferences are saved', !!localStorage.getItem('ace.ui.v1'));
  localStorage.removeItem('ace.ui.v1');
  ok('no errors', !errors.length, errors);
  return { fails, ...out };
}

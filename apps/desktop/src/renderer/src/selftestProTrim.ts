// Pro editing: JKL shuttle, roll / slip / slide tools on the timeline, and the Source view
// (mark in and out on a Media clip, then insert or overwrite at the playhead).

import { addClip, clipStarts, emptyTimeline, newClip, timelineDuration } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

export async function proTrimCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const a = await getMedia(all.find((f) => f.endsWith('GX010133.MP4'))!);
  const b = await getMedia(all.find((f) => f.endsWith('GX010132.MP4'))!);
  await api.importPaths([a.path, b.path]);
  // Three 3 s pieces with media to spare either side.
  const piece = (m: typeof a, id: string, from: number) => ({ ...newClip(m.path, m.durationUs, false), id, inUs: from * S, outUs: (from + 3) * S });
  const base = addClip(addClip(addClip(emptyTimeline(), piece(a, 'p1', 2)), piece(b, 'p2', 4)), piece(a, 'p3', 6));
  api.setTimeline(base);
  await sleep(500);
  const total = () => timelineDuration(api.getTimeline());

  // --- JKL ---
  api.player.seek(1 * S);
  api.run!('shuttleFwd');
  await sleep(600);
  const t1 = api.player.time;
  api.run!('shuttleFwd');
  await sleep(600);
  const t2 = api.player.time;
  ok('L plays, L again plays faster', api.player.playing && api.player.rate === 2 && t2 - t1 > 0.9 * S, { rate: api.player.rate, firstS: +((t1 - 1 * S) / S).toFixed(2), thenS: +((t2 - t1) / S).toFixed(2) });
  api.run!('shuttleBack');
  const tb = api.player.time;
  await sleep(700);
  ok('J plays backward', !api.player.playing && api.player.time < tb - 0.4 * S, { from: tb / S, to: api.player.time / S });
  api.run!('keyframe'); // K
  await sleep(100);
  const tk = api.player.time;
  await sleep(300);
  ok('K stops', !api.player.playing && Math.abs(api.player.time - tk) < 1000 && api.player.rate === 1 && api.getTimeline().clips.every((c) => !c.keyframes.length));

  // --- Tools: drag with real pointer events ---
  const drag = async (el: HTMLElement, dxS: number) => {
    const r = el.getBoundingClientRect();
    const pps = $$('.clip')[0]!.getBoundingClientRect().width / 3;
    const x0 = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (type: string, x: number) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 3, metaKey: true }); // (⌘: no snapping)
    el.dispatchEvent(ev('pointerdown', x0));
    for (let i = 1; i <= 4; i++) { window.dispatchEvent(ev('pointermove', x0 + (dxS * pps * i) / 4)); await sleep(30); }
    window.dispatchEvent(ev('pointerup', x0 + dxS * pps));
    await sleep(150);
  };
  const ins = () => api.getTimeline().clips.map((c): [number, number] => [+(c.inUs / S).toFixed(2), +(c.outUs / S).toFixed(2)]);

  api.run!('toolRoll'); await sleep(100);
  await drag($$('.clip')[0]!.querySelector<HTMLElement>('.trim.right')!, 1);
  ok('Roll moves a cut, keeping the length', Math.abs(total() - 9 * S) < 2000 && Math.abs(ins()[0]![1] - 6) < 0.05 && Math.abs(ins()[1]![0] - 5) < 0.05, ins());

  api.setTimeline(base); await sleep(300);
  api.run!('toolSlip'); await sleep(100);
  await drag($$('.clip')[1]!, -1); // dragging left shows later media
  ok('Slip shows another part, same place', Math.abs(total() - 9 * S) < 2000 && Math.abs(ins()[1]![0] - 5) < 0.05 && Math.abs(ins()[1]![1] - 8) < 0.05 && clipStarts(api.getTimeline())[1] === 3 * S, ins());

  api.setTimeline(base); await sleep(300);
  api.run!('toolSlide'); await sleep(100);
  await drag($$('.clip')[1]!, 1);
  ok('Slide moves a clip between its neighbours', Math.abs(total() - 9 * S) < 2000 && Math.abs(clipStarts(api.getTimeline())[1]! - 4 * S) < 50_000 && ins()[1]!.join() === '4,7', { starts: clipStarts(api.getTimeline()).map((x) => x / S), ins: ins() });
  api.run!('toolSelect');
  await ace.capture('protrim-tools');

  // --- Source view: in, out, insert, overwrite ---
  api.setTimeline(base); await sleep(300);
  api.player.seek(3 * S); await sleep(150); // the cut between p1 and p2
  const viewBtn = $$('.bin-item').find((e) => /GX010132/.test(e.textContent ?? ''))?.querySelector<HTMLButtonElement>('.bin-actions button');
  viewBtn?.click();
  await sleep(600);
  ok('View opens a Media clip in the Source view', !!document.querySelector('.source-bar') && /GX010132/.test(document.querySelector('.source-bar')?.textContent ?? ''));
  ok('the timeline keeps its playhead meanwhile', /0:03/.test(document.querySelector('.playhead')?.getAttribute('data-time') ?? ''), document.querySelector('.playhead')?.getAttribute('data-time'));
  api.player.seek(1 * S); await sleep(100); api.run!('markIn');
  api.player.seek(3.5 * S); await sleep(100); api.run!('markOut');
  await sleep(100);
  api.run!('insertEdit');
  await sleep(300);
  const after = api.getTimeline();
  ok('Insert puts the marked piece in at the playhead', after.clips.length === 4 && after.clips[1]!.mediaPath === b.path && Math.abs(after.clips[1]!.inUs - 1 * S) < 1000 && Math.abs(after.clips[1]!.outUs - 3.5 * S) < 1000 && Math.abs(timelineDuration(after) - 11.5 * S) < 2000, { clips: after.clips.length, total: timelineDuration(after) / S });
  api.run!('overwriteEdit');
  await sleep(300);
  const after2 = api.getTimeline();
  ok('Overwrite covers what follows, keeping the length', Math.abs(timelineDuration(after2) - 11.5 * S) < 2000 && after2.clips[2]!.mediaPath === b.path && Math.abs(clipStarts(after2)[2]! - 5.5 * S) < 2000, { total: timelineDuration(after2) / S, starts: clipStarts(after2).map((x) => x / S) });
  await ace.capture('protrim-source');
  $$('.source-bar button.primary')[0]?.click();
  await sleep(400);
  ok('Done goes back to the timeline', !document.querySelector('.source-bar') && Math.abs(api.player.time - 8 * S) < 2000, api.player.time / S);
  return { fails, ...out };
}

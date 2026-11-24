// Markers, the version 2 project file, and clips whose files went missing.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const F = ace.selftestFiles;

export async function markersCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end))!;
  const a = await getMedia(fix('GX010133.MP4'));
  await api.importPaths([a.path]);
  api.setTimeline(addClip(emptyTimeline(), newClip(a.path, a.durationUs, false)));
  await sleep(300);

  // M at three places; they show on the ruler.
  for (const t of [0, 4.5, 9]) { api.player.seek(t * S); await sleep(80); api.run!('marker'); }
  await sleep(300);
  ok('M adds markers at the playhead', api.getTimeline().markers.map((m) => +(m.t / S).toFixed(2)).join() === '0,4.5,9', api.getTimeline().markers.map((m) => m.t));
  ok('they show on the ruler', $$('.marker-flag').length === 3);

  // Previous / next marker.
  api.player.seek(6 * S); await sleep(50);
  api.run!('prevMarker'); await sleep(50);
  const back = api.player.time;
  api.run!('nextMarker'); await sleep(50);
  ok('previous and next marker', Math.abs(back - 4.5 * S) < 1000 && Math.abs(api.player.time - 9 * S) < 1000, [back, api.player.time]);

  // The Markers panel: notes typed there are kept; chapters copy for YouTube.
  if (!document.querySelector('.markers')) api.run!('markersPanel');
  await sleep(500);
  const notes = $$('.marker-note') as HTMLInputElement[];
  ok('the Markers panel lists them', notes.length === 3, notes.length);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  for (const [i, n] of ['Drop in', 'First jump', 'Berm'].entries()) {
    setter.call(notes[i], n);
    notes[i]!.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(60);
  }
  ok('notes typed in the panel are kept', api.getTimeline().markers.map((m) => m.note).join('|') === 'Drop in|First jump|Berm', api.getTimeline().markers.map((m) => m.note));
  $$('.markers footer button')[0]?.click();
  await sleep(200);
  const copied = await ace.selftestCopied();
  ok('copies YouTube chapters', copied === '0:00 Drop in\n0:04 First jump\n0:09 Berm', copied);
  ok('and says what YouTube would reject', /10 seconds/.test($$('.markers footer .hint')[0]?.textContent ?? ''), $$('.markers footer .hint')[0]?.textContent);
  await ace.capture('markers-panel');

  // Saved as version 2, and opened again with the markers.
  const text = api.saveText!();
  const saved = JSON.parse(text);
  ok('saves as version 2', saved.version === 2 && saved.timeline.version === 2 && Array.isArray(saved.bins) && typeof saved.library[0] === 'object', { version: saved.version, library0: saved.library[0] });
  await api.restore!(text);
  await sleep(500);
  ok('opens again with its markers', api.getTimeline().markers.length === 3 && api.getTimeline().markers[1]!.note === 'First jump');

  // An old (version 1) project opens.
  const v1 = JSON.stringify({ version: 1, timeline: { version: 1, clips: [newClip(a.path, a.durationUs, false)], audio: [], framing: '16:9', lutPath: null, overlays: [] }, library: [a.path] });
  await api.restore!(v1);
  await sleep(500);
  ok('a version 1 project opens', api.getTimeline().clips.length === 1 && api.getTimeline().markers.length === 0 && !!$$('.bin-item').length);

  // A clip whose file is gone stays on the timeline, marked missing, and export waits for a relink.
  await F('remove', 'away/gone');
  await F('copy', fix('GX010132.MP4'), 'away/gone/GX010132.MP4');
  const goneDir = (await ace.selftestOut('away')) + '/gone';
  const b = await getMedia(`${goneDir}/GX010132.MP4`);
  const withGone = JSON.stringify({ version: 2, timeline: { ...addClip(addClip(emptyTimeline(), newClip(a.path, a.durationUs, false)), newClip(b.path, b.durationUs, false)) }, library: [{ path: a.path }, { path: b.path, rating: 4 }], bins: [] });
  await F('remove', 'away/gone');
  await api.restore!(withGone);
  await sleep(800);
  ok('a missing clip stays on the timeline', api.getTimeline().clips.length === 2 && $$('.clip.offline').length === 1, { clips: api.getTimeline().clips.length, offline: $$('.clip.offline').length });
  ok('the Media list says it is missing', /Missing: it was moved/.test($$('.bin-item.error').map((e) => e.textContent).join(' ')), $$('.bin-item.error').map((e) => e.textContent));
  ok('and the app says how to fix it', /missing.*Relink/.test($$('.notice').map((n) => n.textContent).join(' ')), $$('.notice').map((n) => n.textContent));
  api.player.seek(a.durationUs + 1 * S);
  await sleep(600);
  ok('the preview says it is missing', !!document.querySelector('.stage .empty.offline'));
  await ace.capture('markers-offline');
  api.run!('export');
  await sleep(300);
  ok('export waits for a relink', !document.querySelector('.modal-backdrop .modal') && /Relink/.test(document.body.textContent ?? ''));
  return { fails, ...out };
}

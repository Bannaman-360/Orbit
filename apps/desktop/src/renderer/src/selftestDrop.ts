// Importing by dragging files and folders in from the desktop.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const F = ace.selftestFiles;

export async function dropCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const until = async (f: () => boolean, ms: number) => { const t = performance.now(); while (!f() && performance.now() - t < ms) await sleep(50); return f(); };
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end))!;
  await F('remove', 'away');
  await F('copy', fix('GX010133.MP4'), 'away/ride/GX010133.MP4');
  await F('write', 'away/ride/GL010133.LRV', 'low res');
  await F('write', 'away/ride/notes.txt', 'hello');
  await F('copy', fix('GS010116.360'), 'away/ride/more/GS010116.360');
  const dir = (await ace.selftestOut('away')) + '/ride';
  api.setTimeline(emptyTimeline());
  await sleep(300);

  // A folder dropped anywhere: its videos (not the .LRV copy, not the notes) go to the media bin.
  await api.dropPaths!([dir]);
  await until(() => $$('.bin-item').length >= 2 && !$$('.bin-item.loading').length, 15000);
  const names = $$('.bin-item .name').map((e) => e.textContent);
  ok('a dropped folder imports its videos', names.length === 2 && names.some((n) => /GX010133/.test(n ?? '')) && names.some((n) => /GS010116/.test(n ?? '')), names);
  ok('nothing on the timeline from a drop outside it', api.getTimeline().clips.length === 0);

  // Dropped on the timeline: placed where it was let go.
  const a = await getMedia(fix('GX010132.MP4'));
  api.setTimeline(addClip(emptyTimeline(), { ...newClip(a.path, a.durationUs, false), id: 'first' }));
  await sleep(300);
  await api.dropPaths!([`${dir}/GX010133.MP4`], 0.5 * S);
  ok('dropped near the start of a clip: goes before it', api.getTimeline().clips.map((c) => c.id).indexOf('first') === 1 && /GX010133/.test(api.getTimeline().clips[0]!.mediaPath), api.getTimeline().clips.map((c) => c.mediaPath.split('/').pop()));
  await api.dropPaths!([`${dir}/more/GS010116.360`], 9999 * S);
  ok('dropped past the end: goes last', /GS010116/.test(api.getTimeline().clips.at(-1)!.mediaPath) && api.getTimeline().clips.length === 3);

  // Sound dropped on the timeline becomes music at that point.
  const tone = all.find((f) => f.endsWith('test-tone.wav'));
  if (tone) {
    await F('copy', tone, 'away/tone.wav');
    await api.dropPaths!([(await ace.selftestOut('away')) + '/tone.wav'], 2 * S);
    const mus = api.getTimeline().audio.at(-1);
    ok('music dropped on the timeline starts there', !!mus && Math.abs(mus.startUs - 2 * S) < 1000, mus?.startUs);
  } else out['music drop'] = 'skipped (no test tone)';

  // Something that isn't a video: said so, and the file stays unreadable.
  await api.dropPaths!(['/etc/hosts']);
  await sleep(200);
  ok('a non-video is refused with a reason', /wasn’t imported/.test(document.body.textContent ?? ''), $$('.notice').map((n) => n.textContent));
  const readable = await ace.read('/etc/hosts', 0, 10).then(() => true, () => false);
  ok('and gets no file access', !readable);

  // While dragging: the veil says what will happen, and goes away after.
  const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
  const drag = (type: string, el: Element) => { const dt = new DataTransfer(); dt.items.add(file); el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 10, clientY: 10 })); };
  const tlEl = document.querySelector('.timeline-wrap .timeline-scroll')!, stage = document.querySelector('.frame') ?? document.body;
  drag('dragenter', tlEl);
  drag('dragover', tlEl);
  await sleep(100);
  ok('over the timeline: "add to the timeline"', /add to the timeline/.test(document.querySelector('.drop-veil')?.textContent ?? ''));
  await ace.capture('drop-timeline');
  drag('dragover', stage);
  await sleep(100);
  ok('over the rest: "import"', /Drop to import/.test(document.querySelector('.drop-veil')?.textContent ?? ''));
  await ace.capture('drop-app');
  drag('drop', stage);
  await sleep(100);
  ok('the veil goes when dropped', !document.querySelector('.drop-veil'));
  return { fails, ...out };
}

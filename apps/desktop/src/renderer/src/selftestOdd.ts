// Hardening: broken and unusual files. Each one either opens and plays, or is turned away with a
// plain reason — never a crash, a hang or a blank window.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

/** What should happen to each file: open (and play), or be refused. */
const CASES: [string, 'open' | 'refuse' | 'either'][] = [
  ['odd/portrait-phone.mp4', 'open'],
  ['odd/no-audio.mp4', 'open'],
  ['odd/tiny-short.mp4', 'open'],
  ['odd/rotated-hevc.mp4', 'open'],
  ['odd/Name with spaces & ü (copy).MP4', 'open'],
  ['odd/audio-only.mp4', 'refuse'],
  ['odd/empty.MP4', 'refuse'],
  ['odd/text-renamed.MP4', 'refuse'],
  ['odd/truncated-GX.MP4', 'either'],
  ['odd/truncated-GS.360', 'either'],
];
/** The reason given for each refused file should say this. */
const SAYS: Record<string, RegExp> = {
  'odd/audio-only.mp4': /sound only.*Add Music/,
  'odd/empty.MP4': /empty/,
  'odd/text-renamed.MP4': /isn’t a video/,
  'odd/truncated-GX.MP4': /wasn’t finished/,
  'odd/truncated-GS.360': /wasn’t finished/,
};

/** A reason a person can read (not a raw exception). */
const plain = (why: string) => !!why && why.length < 300 && !/undefined|TypeError|RangeError|object Object|at \w+ \(/.test(why);

export async function oddCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const errors: string[] = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const all = await ace.listFixtures();
  for (const [name, want] of CASES) {
    const p = all.find((f) => f.endsWith(`/${name}`));
    if (!p) { ok(name, false, 'fixture missing'); continue; }
    const t0 = performance.now();
    const e0 = errors.length;
    await api.dropPaths!([p]);
    const base = name.split('/').pop();
    const item = () => $$('.bin-item').find((el) => el.querySelector('.name')?.textContent === base);
    while ((!item() || item()!.classList.contains('loading')) && performance.now() - t0 < 30_000) await sleep(100);
    const el = item();
    const secs = +((performance.now() - t0) / 1000).toFixed(1);
    const notice = $$('.notice').map((n) => n.textContent ?? '').join(' ').slice(0, 160);
    if (!el) {
      // Turned away before reaching the bin, with a notice.
      ok(name, want !== 'open' && /wasn’t imported/.test(notice), { result: 'not in bin', notice, secs });
      continue;
    }
    if (el.classList.contains('loading')) { ok(name, false, { result: 'still opening after 30 s' }); continue; }
    if (el.classList.contains('error')) {
      const why = el.getAttribute('title') ?? '';
      ok(name, want !== 'open' && plain(why) && (!SAYS[name] || SAYS[name]!.test(why)) && !!el.querySelector('.bin-why'), { result: 'refused', why, secs });
      continue;
    }
    // Opened: put it on the timeline, show the middle, play a second.
    const m = await getMedia(p);
    api.setTimeline(addClip(emptyTimeline(), newClip(m.path, m.durationUs, m.is360)));
    api.player.seek(m.durationUs / 2);
    for (let i = 0; i < 4; i++) await Promise.race([api.nextRender(), sleep(3000)]);
    const shown = !!api.lastResult()?.layers?.[0]?.frames?.length;
    api.player.seek(0);
    await sleep(200);
    api.player.play();
    await sleep(1200);
    const played = api.player.time;
    api.player.pause();
    const info = { result: 'opened', size: `${m.width}x${m.height}`, secsLong: +(m.durationUs / 1e6).toFixed(2), shown, playedTo: +(played / 1e6).toFixed(2), secs, newErrors: errors.slice(e0) };
    ok(name, want !== 'refuse' && shown && (played > 0.5e6 || m.durationUs < 1e6) && errors.length === e0, info);
    await ace.capture(`odd-${base!.replace(/[^\w.-]+/g, '_')}`);
  }
  ok('no uncaught errors', !errors.length, errors);
  api.setTimeline(emptyTimeline());
  return { fails, ...out };
}

// The film strip on timeline clips.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { filmstripPending } from './filmstrip';
import { getMedia } from './media';
import { defaultPrefs, setPrefs } from './ui/prefs';
import type { EditorApi } from './selftest';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

export async function stripCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  setPrefs(defaultPrefs());
  const all = await ace.listFixtures();
  const long = await getMedia(all.find((f) => f.endsWith('GS010004.360'))!), flat = await getMedia(all.find((f) => f.endsWith('GX010133.MP4'))!);
  await api.importPaths([long.path, flat.path]);
  api.setTimeline(addClip(addClip(emptyTimeline(), { ...newClip(long.path, long.durationUs, true), outUs: 120 * S }), newClip(flat.path, flat.durationUs, false)));
  await sleep(600);
  const until = async (f: () => boolean, ms: number) => { const t = performance.now(); while (!f() && performance.now() - t < ms) await sleep(50); return f(); };
  await until(() => filmstripPending() === 0, 20000);
  await sleep(300);
  const tiles = () => $$('.clip-strip .strip-tile');
  const urls = () => tiles().map((t) => t.style.backgroundImage).filter(Boolean);
  ok('clips show pictures along their length', tiles().length >= 6 && urls().length === tiles().length, [tiles().length, urls().length]);
  ok('different moments, different pictures', new Set(urls()).size >= Math.min(6, tiles().length) * 0.8, new Set(urls()).size);
  const keys = $$('.clip')[0]!.querySelectorAll<HTMLElement>('.strip-tile');
  const ks = [...keys].map((k) => Number(k.dataset.key));
  ok('in order, through the clip', ks.length > 3 && ks.every((k, i) => !i || k >= ks[i - 1]!), ks.slice(0, 12));
  // The pictures really differ (not one picture repeated).
  const look = async (url: string) => { const img = new Image(); img.src = /url\("?([^")]+)"?\)/.exec(url)![1]!; await img.decode(); const c = new OffscreenCanvas(32, 18), x = c.getContext('2d')!; x.drawImage(img, 0, 0, 32, 18); return x.getImageData(0, 0, 32, 18).data; };
  const u = urls();
  const a = await look(u[0]!), b = await look(u[Math.min(u.length - 1, 4)]!);
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  ok('the pictures are of different moments', d / a.length > 6, +(d / a.length).toFixed(1));
  await ace.capture('strip');
  // Zooming the timeline in: more pictures for the part in view, made in time.
  const before = new Set(ks).size;
  const scroll = document.querySelector('.timeline-scroll')!;
  for (let k = 0; k < 8; k++) { scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, metaKey: true })); await sleep(40); }
  await until(() => filmstripPending() === 0, 20000);
  await sleep(300);
  const ks2 = [...$$('.clip')[0]!.querySelectorAll<HTMLElement>('.strip-tile')].map((k) => Number(k.dataset.key));
  ok('zooming in shows closer moments', ks2.length > 0 && Math.max(...ks2) - Math.min(...ks2) < (Math.max(...ks) - Math.min(...ks)) && urls().length === tiles().length, { before, keysNow: ks2.slice(0, 8) });
  // Never in the way of playback.
  for (let k = 0; k < 8; k++) { scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, metaKey: true })); await sleep(40); }
  api.player.seek(30 * S);
  await sleep(800);
  const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
  api.player.play();
  await sleep(4000);
  api.player.pause();
  const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
  ok('playback keeps real time', speed > 0.95, { speed: +speed.toFixed(3), stalls: api.player.stalls - s0 });
  // A changed view redraws the strip.
  const before2 = urls()[0];
  api.setTimeline({ ...api.getTimeline(), clips: api.getTimeline().clips.map((c, i) => (i ? c : { ...c, look: { ...c.look, yaw: 150 } })) });
  await sleep(200);
  await until(() => filmstripPending() === 0, 20000);
  await sleep(300);
  ok('a changed view redraws its pictures', urls()[0] !== before2);
  document.documentElement.dataset.thumbs = 'off';
  await sleep(100);
  ok('the clip thumbnails switch hides them', getComputedStyle(document.querySelector('.clip-strip')!).display === 'none');
  setPrefs(defaultPrefs());
  return { fails, ...out };
}

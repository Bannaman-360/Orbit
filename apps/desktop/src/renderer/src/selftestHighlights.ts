// Highlights: found on the real ride (jumps, top speed, hard hits), listed in the Clip panel,
// marked on the timeline, and cut into a highlight reel. Runs hidden.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { clipHighlights } from './Highlights';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { openSection } from './ui';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = <T extends HTMLElement = HTMLElement>(q: string) => [...document.querySelectorAll<T>(q)];
const button = (text: string) => $$<HTMLButtonElement>('button').find((b) => b.textContent === text);

export async function highlightsCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const ridePath = all.find((f) => f.endsWith('max2/GS010004.360'));
  if (!ridePath) return { fails: ['needs fixtures/max2/GS010004.360'], ...out };

  // The real ride: 7.7 min with GPS and jumps.
  const m = await getMedia(ridePath);
  const t0 = performance.now();
  const hs = m.telemetry.highlights(m.durationUs, m.hilights);
  const ms = performance.now() - t0;
  out.found = hs.map((h) => `${(h.t / S).toFixed(1)}s ${h.kind}${h.also.length ? `+${h.also.join('+')}` : ''} ${(h.fromUs / S).toFixed(1)}–${(h.toUs / S).toFixed(1)} score ${h.score.toFixed(2)}${h.speedMs !== undefined ? ` ${(h.speedMs * 3.6).toFixed(0)}km/h` : ''}${h.g !== undefined ? ` ${h.g}G` : ''}`);
  ok('worked out quickly', ms < 500, Math.round(ms));
  ok('the camera’s HiLight tags are read (this ride has none)', Array.isArray(m.hilights) && m.hilights.length === 0, m.hilights);
  const jumps = m.telemetry.jumps();
  const kinds = new Set(hs.flatMap((h) => [h.kind, ...h.also]));
  ok('every jump is part of a highlight', jumps.every((j) => hs.some((h) => j.startUs >= h.fromUs && j.endUs <= h.toUs)), { jumps: jumps.length, highlights: hs.length });
  ok('the top speed is one', kinds.has('speed'), [...kinds]);
  const top = hs.filter((h) => h.speedMs !== undefined).reduce((a, h) => Math.max(a, h.speedMs!), 0);
  ok('at about the ride’s top speed', top > 0 && Math.abs(top - m.telemetry.maxSpeed) < 0.5, { top, max: m.telemetry.maxSpeed });
  ok('in time order, inside the file, none overlapping', hs.every((h, i) => h.fromUs >= 0 && h.toUs <= m.durationUs && h.fromUs <= h.t && h.t <= h.toUs && (!i || hs[i - 1]!.toUs <= h.fromUs)));
  ok('one for each jump or moment, none of them long', hs.length >= jumps.length / 2 && hs.length <= jumps.length + 12 && hs.every((h) => h.toUs - h.fromUs <= 20 * S), { count: hs.length, longest: Math.max(...hs.map((h) => (h.toUs - h.fromUs) / S)) });

  // A regular GoPro clip, for the record.
  const regular = all.find((f) => f.endsWith('GX010133.MP4'));
  if (regular) { const r = await getMedia(regular); out.regular = r.telemetry.highlights(r.durationUs, r.hilights).map((h) => `${(h.t / S).toFixed(1)}s ${h.kind}`); }

  // In the app: the Clip panel lists the highlights of the clip.
  await api.importPaths([m.path]);
  const clip = { ...newClip(m.path, m.durationUs, true), inUs: 60 * S, outUs: 400 * S };
  api.setTimeline(addClip(emptyTimeline(), clip));
  api.player.seek(10 * S);
  await sleep(600);
  document.querySelector<HTMLElement>('.dock-tab[data-panel="clip"]')?.click();
  openSection('Highlights');
  await sleep(500);
  const mine = clipHighlights(clip, m);
  const rows = $$('[data-section="Highlights"] .hl-row');
  ok('the Clip panel lists this clip’s highlights', mine.length > 0 && rows.length === mine.length, { rows: rows.length, want: mine.length });
  ok('only the ones inside the clip', mine.every((h) => h.t >= clip.inUs && h.t < clip.outUs && h.fromUs >= clip.inUs && h.toUs <= clip.outUs));
  document.querySelector('[data-section="Highlights"]')?.scrollIntoView({ block: 'start' });
  await sleep(200);
  await ace.capture('highlights-section');

  // Clicking one goes there.
  rows[0]?.click();
  await sleep(200);
  ok('clicking one goes to it', Math.abs(api.player.time - (mine[0]!.t - clip.inUs)) < 50_000, { at: api.player.time, want: mine[0]!.t - clip.inUs });

  // Stars on the timeline for the ones that aren't jumps.
  const stars = $$('.clip-star').length, wantStars = mine.filter((h) => h.kind !== 'jump').length;
  ok('stars on the timeline (jumps keep their arcs)', stars === wantStars, { stars, wantStars });

  // Mark them: a marker each, with a note; again adds nothing. (The choice of how many is kept
  // between runs: start from All.)
  $$<HTMLButtonElement>('[data-section="Highlights"] .seg button').find((b) => b.textContent === 'All')?.click();
  await sleep(200);
  button('Mark them')?.click();
  await sleep(300);
  let tl = api.getTimeline();
  ok('Mark them adds a marker at each', tl.markers.length === mine.length && tl.markers.every((mk, i) => Math.abs(mk.t - (mine[i]!.t - clip.inUs)) < 1000 && mk.note.length > 3), tl.markers.map((x) => `${(x.t / S).toFixed(1)} ${x.note}`));
  button('Mark them')?.click();
  await sleep(300);
  ok('marking again doesn’t double them', api.getTimeline().markers.length === mine.length);

  // Best 3, then a reel: three pieces after the clip, each around its moment.
  $$<HTMLButtonElement>('[data-section="Highlights"] .seg button').find((b) => b.textContent === 'Best 3')?.click();
  await sleep(200);
  button('Make a highlight reel')?.click();
  await sleep(500);
  tl = api.getTimeline();
  const pieces = tl.clips.slice(1);
  const best = [...mine].sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.t - b.t);
  ok('the reel is added after the clip, the best three in order', pieces.length === 3 && pieces.every((p, i) => p.mediaPath === m.path && p.inUs === Math.round(best[i]!.fromUs) && p.outUs === Math.round(best[i]!.toUs)), pieces.map((p) => [p.inUs / S, p.outUs / S]));
  ok('the clip itself stays as it was', tl.clips[0]!.inUs === clip.inUs && tl.clips[0]!.outUs === clip.outUs);
  ok('the playhead goes to the reel', api.player.time >= clip.outUs - clip.inUs - 1000, api.player.time);
  ok('it says what was added', document.body.textContent?.includes('at the end of the timeline') ?? false);
  await sleep(300);
  await ace.capture('highlights-reel');

  // A reel from every clip: the reel's own pieces have highlights too.
  const before = tl.clips.length;
  const want = tl.clips.reduce((a, c) => a + Math.min(3, clipHighlights(c, m).length), 0);
  api.player.seek(10 * S);
  await sleep(400);
  openSection('Highlights');
  await sleep(200);
  button('Reel from every clip')?.click();
  await sleep(500);
  ok('Reel from every clip adds the best of each', api.getTimeline().clips.length === before + want, { added: api.getTimeline().clips.length - before, want });
  api.run?.('undo');
  await sleep(300);
  ok('undo takes them away', api.getTimeline().clips.length === before);

  return { fails, ...out };
}

// Beats found in music, shown on it, and drags on the timeline snapping to beats, markers and the
// playhead (hold ⌘ to drag freely).

import { addClip, addMarker, emptyTimeline, newAudioClip, newClip, newTextOverlay } from '@ace/project';
import { ace } from './api';
import { getMedia, loadMusic } from './media';
import { beatsOf } from './musicBeats';
import type { EditorApi } from './selftest';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

export async function snapCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end))!;
  const v = await getMedia(fix('GX010133.MP4'));
  // (Sound files aren't in the fixture list, which is videos: it's at a known place.)
  const song = `${(await ace.info()).fixtures}/synthetic/beats-120.wav`;
  const m = await loadMusic(song);
  let tl = addClip(emptyTimeline(), newClip(v.path, v.durationUs, false));
  tl = { ...tl, audio: [newAudioClip(song, m.durationUs, 0)], overlays: [{ ...newTextOverlay(3.3 * S, 5.3 * S, 'Snap me'), id: 'snapme' }] };
  tl = addMarker(tl, 7.25 * S, 'mark').tl;
  api.setTimeline(tl);
  if (!(await api.getTimeline()).markers.length) api.setTimeline(tl);

  // The beats are found in the background.
  const t0 = performance.now();
  while (!beatsOf(song) && performance.now() - t0 < 15_000) await sleep(100);
  const g = beatsOf(song);
  ok('finds the tempo of the music', !!g && Math.abs(g.bpm - 120) < 2, { bpm: g?.bpm, ms: Math.round(performance.now() - t0) });
  // Beats every 0.5 s from 0.5 s (the file's own pattern).
  const off = g ? g.beats.filter((b) => b > 1 && b < 22).map((b) => Math.abs(b - (0.5 + Math.round((b - 0.5) / 0.5) * 0.5))) : [1];
  ok('and its beats to 25 ms', Math.max(...off) < 0.025, Math.round(Math.max(...off) * 1000));
  ok('bars start on the kick drum', !!g && Math.abs(((Math.round((g.beats[g.downbeats[0]!]! - 0.5) / 0.5) % 4) + 4) % 4) === 0);
  await sleep(300);
  ok('beats show on the music', $$('.music .beat-ticks i').length > 20 && $$('.music .beat-ticks i.bar').length > 5, { ticks: $$('.music .beat-ticks i').length });

  // Dragging the text block: let go near a beat, it lands on it; near the marker, on the marker.
  const block = $$('.ov-item').find((e) => /Snap me/.test(e.textContent ?? ''))!;
  const pps = block.getBoundingClientRect().width / 2;
  const drag = async (dxS: number, meta = false) => {
    api.setTimeline({ ...api.getTimeline(), overlays: api.getTimeline().overlays.map((o) => (o.id === 'snapme' ? { ...o, startUs: 3.3 * S, endUs: 5.3 * S } : o)) });
    await sleep(150);
    const b = $$('.ov-item').find((e) => /Snap me/.test(e.textContent ?? ''))!.getBoundingClientRect();
    const x0 = b.left + b.width / 2, y = b.top + b.height / 2;
    const ev = (type: string, x: number) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, metaKey: meta, pointerId: 1 });
    $$('.ov-item').find((e) => /Snap me/.test(e.textContent ?? ''))!.dispatchEvent(ev('pointerdown', x0));
    for (let i = 1; i <= 5; i++) { window.dispatchEvent(ev('pointermove', x0 + (dxS * pps * i) / 5)); await sleep(20); }
    const guide = !!document.querySelector('.snap-guide');
    window.dispatchEvent(ev('pointerup', x0 + dxS * pps));
    await sleep(100);
    return { start: api.getTimeline().overlays.find((o) => o.id === 'snapme')!.startUs / S, guide };
  };
  const toBeat = await drag(0.15);       // 3.45 → beat at 3.5
  ok('a drag lands on a nearby beat', Math.abs(toBeat.start - 3.5) < 0.03 && toBeat.guide, toBeat);
  const toMarker = await drag(1.95 - 0.06); // end 7.19 → marker at 7.25 (start 5.25)
  ok('the end of a block lands on a marker', Math.abs(toMarker.start - 5.25) < 0.01, toMarker);
  const freeDrag = await drag(0.15, true);
  ok('holding ⌘ drags freely', Math.abs(freeDrag.start - 3.45) < 0.02 && !freeDrag.guide, freeDrag);
  api.run!('snap');
  await sleep(100);
  const off2 = await drag(0.15);
  ok('N turns snapping off', Math.abs(off2.start - 3.45) < 0.02, off2);
  api.run!('snap');
  // Scrubbing the ruler stops on a beat, so a split lands on it.
  await sleep(100);
  const ruler = document.querySelector<HTMLElement>('.ruler')!.getBoundingClientRect();
  const scroller = document.querySelector<HTMLElement>('.timeline-scroll')!;
  const xAt = (t: number) => ruler.left - scroller.scrollLeft + scroller.scrollLeft + t * pps;
  const press = (type: string, x: number) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: ruler.top + 8, button: 0, pointerId: 2 });
  document.querySelector<HTMLElement>('.ruler')!.dispatchEvent(press('pointerdown', xAt(6.04)));
  window.dispatchEvent(press('pointerup', xAt(6.04)));
  await sleep(100);
  ok('scrubbing the ruler stops on a beat', Math.abs(api.player.time / S - 6) < 0.03, api.player.time / S);
  api.run!('split');
  await sleep(200);
  ok('so a split lands on it', api.getTimeline().clips.length === 2 && Math.abs(api.getTimeline().clips[0]!.outUs / S - 6) < 0.03, api.getTimeline().clips.map((c) => c.outUs / S));
  await ace.capture('snap-beats');
  return { fails, ...out };
}

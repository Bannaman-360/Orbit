// Dragging the playhead backward at full quality.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import { setPreviewLevel } from './proxy';
import { TimelinePlayer } from './timelinePlayer';
import type { EditorApi } from './selftest';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scrubBackCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const shownAt = () => api.lastResult()?.layers?.[0]?.frames[0]?.timestamp ?? -1;
  const runs: Record<string, unknown> = {};
  for (const keep of [false, true]) for (const [name, from, to, ms] of [['GS010083.360', 18, 8, 2000], ['GS010083.360', 18, 14, 3000], ['GX010133.MP4', 11, 1, 2000], ['GS010004.360', 200, 190, 2000], ['GS010004.360', 200, 196, 3000], ['GS010120.360', 12, 2, 2000]] as [string, number, number, number][]) {
    const m = await getMedia(all.find((f) => f.endsWith(name))!);
    setPreviewLevel(1, [m]);
    TimelinePlayer.keepBackward = keep;
    api.setTimeline(addClip(emptyTimeline(), newClip(m.path, m.durationUs, m.is360)));
    api.player.seek(from * S);
    await sleep(1200);
    const shown = new Set<number>();
    let forward = 0, prev = shownAt(), dragging = true, peak = 0, levels = new Set<number>();
    void (async () => {
      while (dragging) {
        await Promise.race([api.nextRender(), sleep(100)]);
        const ts = shownAt();
        if (ts >= 0) { shown.add(ts); if (prev >= 0 && ts > prev + 1000) forward++; prev = ts; levels.add(api.lastResult()?.layers?.[0]?.level ?? 0); }
        peak = Math.max(peak, api.player.reverseBytes);
      }
    })();
    const t0 = performance.now();
    for (;;) {
      const f = (performance.now() - t0) / ms;
      if (f >= 1) break;
      api.player.seek((from + (to - from) * f) * S);
      await sleep(16);
    }
    dragging = false;
    await sleep(50);
    api.player.seek(to * S);
    const r0 = performance.now();
    let exact = -1;
    while (performance.now() - r0 < 3000) { await sleep(10); const ts = shownAt(); if (Math.abs(ts - to * S) < 1e6 / m.fps && api.lastResult()?.layers?.[0]?.level === 1) { exact = performance.now() - r0; break; } }
    const perS = (shown.size * 1000) / ms;
    const label = `${name} back ${from - to}s in ${ms / 1000}s`;
    runs[`${label}|${keep}`] = { pictures: shown.size, forward, exactMs: Math.round(exact), peakMB: Math.round(peak / 1e6), level: [...levels].join('/') };
    if (keep) {
      const old = runs[`${label}|false`] as { pictures: number; exactMs: number };
      out[`${label}`] = { before: old, now: runs[`${label}|true`] };
      ok(`${label}: more pictures than before`, shown.size >= old.pictures * ((from - to) / (ms / 1000) > 2 ? 1 : 2), [old.pictures, shown.size]);
      ok(`${label}: never jumps forward`, forward === 0, forward);
      ok(`${label}: sharp again on letting go, no slower than before`, exact >= 0 && exact < Math.max(450, old.exactMs * 1.25 + 60), [old.exactMs, Math.round(exact)]);
      ok(`${label}: memory kept in bounds`, peak < 450e6, Math.round(peak / 1e6));
    }
  }
  TimelinePlayer.keepBackward = true;
  // Forward dragging and playback are as they were.
  const m = await getMedia(all.find((f) => f.endsWith('GS010083.360'))!);
  api.setTimeline(addClip(emptyTimeline(), newClip(m.path, m.durationUs, true)));
  api.player.seek(2 * S);
  await sleep(900);
  const fw = new Set<number>();
  let go = true;
  void (async () => { while (go) { await Promise.race([api.nextRender(), sleep(100)]); fw.add(shownAt()); } })();
  const t1 = performance.now();
  while (performance.now() - t1 < 2000) { api.player.seek((2 + (10 * (performance.now() - t1)) / 2000) * S); await sleep(16); }
  go = false;
  out['forward drag pictures'] = fw.size;
  ok('forward drag still shows pictures', fw.size > 15, fw.size);
  api.player.seek(2 * S);
  await sleep(800);
  const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
  api.player.play();
  await sleep(3000);
  api.player.pause();
  const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
  ok('playback unchanged', speed > 0.95, { speed: +speed.toFixed(3), stalls: api.player.stalls - s0 });
  return { fails, ...out };
}

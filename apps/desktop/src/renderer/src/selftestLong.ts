// Hardening: a long recording (GS010004, about 7.5 minutes, 6.7 GB). Opening, jumping around,
// playing near the end, the ride data, and exporting a piece from late in the file.

import { addClip, emptyTimeline, newClip, newGaugeOverlay } from '@ace/project';
import { ace } from './api';
import { exportTimeline } from './exporter';
import { getMedia } from './media';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const S = 1e6;
const heapMB = () => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20);

export async function longCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const errors: string[] = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const p = (await ace.listFixtures()).find((f) => f.endsWith('GS010004.360'));
  if (!p) return { fails: ['GS010004.360 missing'] };
  const heap0 = heapMB();

  // Opening: the file, its motion data and its GPS.
  let t0 = performance.now();
  await api.dropPaths!([p]);
  const m = await getMedia(p);
  const openS = (performance.now() - t0) / 1000;
  t0 = performance.now();
  const jumps = m.telemetry.jumps();
  const jumpsMs = performance.now() - t0;
  ok('opens in under 3 s', openS < 3, { seconds: +openS.toFixed(1), minutes: +(m.durationUs / 60e6).toFixed(1) });
  ok('jumps found quickly', jumpsMs < 1000, { jumps: jumps.length, ms: Math.round(jumpsMs) });

  // On the timeline with a speed and an airtime gauge, as a rider would.
  const tl = { ...addClip(emptyTimeline(), newClip(m.path, m.durationUs, m.is360)), overlays: [newGaugeOverlay('speed', 0, m.durationUs), newGaugeOverlay('airtime', 0, m.durationUs)] };
  api.setTimeline(tl);
  await sleep(500);

  // Jumping around: how long until the picture at the new place shows.
  const shownAt = () => api.lastResult()?.layers?.[0]?.frames?.[0]?.timestamp ?? -1;
  const seekMs: Record<string, number> = {};
  for (const T of [10 * S, 210 * S, m.durationUs - 10 * S, 30 * S, m.durationUs / 2]) {
    t0 = performance.now();
    api.player.seek(T);
    while (Math.abs(shownAt() - T) > 0.2 * S && performance.now() - t0 < 10_000) await Promise.race([api.nextRender(), sleep(100)]);
    seekMs[`${Math.round(T / S)}s`] = Math.round(performance.now() - t0);
  }
  ok('a jump to anywhere shows within 1.5 s', Object.values(seekMs).every((x) => x < 1500), seekMs);

  // Playing near the end.
  api.player.seek(m.durationUs - 20 * S);
  await sleep(800);
  const s0 = api.player.stalls, p0 = api.player.time;
  t0 = performance.now();
  api.player.play();
  await sleep(4000);
  const speed = (api.player.time - p0) / 1000 / (performance.now() - t0);
  api.player.pause();
  ok('plays in real time near the end', speed > 0.95, { speed: +speed.toFixed(3), stalls: api.player.stalls - s0 });

  // Exporting 10 s from late in the file, with the gauges.
  const late = m.durationUs - 40 * S;
  const piece = { ...tl, clips: tl.clips.map((c) => ({ ...c, inUs: late, outUs: late + 10 * S })), overlays: tl.overlays.map((o) => ({ ...o, startUs: 0, endUs: 10 * S })) };
  const path = await ace.selftestOut('long-late.mp4');
  t0 = performance.now();
  let err = '';
  await exportTimeline(piece, { path, resolution: 1080, fps: 30, codec: 'avc', quality: 'high' }, () => {}, new AbortController().signal).catch((e) => { err = String(e); });
  const exportS = (performance.now() - t0) / 1000;
  const size = await ace.stat(path).then((s) => s.size, () => 0);
  ok('exports a piece from the end', !err && size > 1e6, { realtime: +(10 / exportS).toFixed(2), MB: +(size / 1e6).toFixed(1), err });

  // Memory stays put after all that.
  await sleep(1000);
  const heap1 = heapMB();
  ok('memory stays reasonable', heap1 < 1500 && heap1 - heap0 < 800, { startMB: heap0, endMB: heap1 });
  ok('no uncaught errors', !errors.length, errors);
  api.setTimeline(emptyTimeline());
  return { fails, ...out };
}

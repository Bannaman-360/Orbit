// Recordings split into chapters by the camera, against the same recording in one piece.

import { addClip, DEFAULT_LOOK, emptyTimeline, newClip, type Look, type TimelineClip } from '@ace/project';
import { decodeAudioRange, toStereo, TrackDecoder } from '@ace/engine';
import { ReframeRenderer } from '@ace/media360';
import { DEFAULT_AXIS_MAP } from '@ace/telemetry';
import { ace, baseName } from './api';
import { AudioPlayer, mixTimeline } from './audioEngine';
import { framesAt } from './calib';
import { exportTimeline } from './exporter';
import { presentLook, pushClipFrame } from './frameRender';
import { getMedia, wholeRecordings, type Media } from './media';
import { previewSource, proxiesIdle, setPreviewLevel } from './proxy';
import type { EditorApi } from './selftest';

const S = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const look = (o: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...o });
const pixels = async (c: OffscreenCanvas) => {
  const o = new OffscreenCanvas(c.width, c.height), x = o.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(await createImageBitmap(c), 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
};
const sorted = (m: Media) => m.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);

export async function chapterCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const file = (end: string) => all.find((f) => f.endsWith(end))!;

  const compare = async (label: string, joined: Media, whole: Media, parts: number, joins: number[]) => {
    ok(`${label}: joined`, joined.parts.length === parts && !joined.partsNote, [joined.parts.map((p) => [baseName(p.path), p.startUs / S]), joined.partsNote]);
    const a = sorted(joined), b = sorted(whole);
    ok(`${label}: same frames at the same times`, a.length === b.length && a.every((t, i) => Math.abs(t - b[i]!) <= 60), [a.length, b.length, Math.max(...a.map((t, i) => Math.abs(t - (b[i] ?? 0))))]);
    ok(`${label}: same length`, Math.abs(joined.durationUs - whole.durationUs) < 2000, [joined.durationUs, whole.durationUs]);
    // Pictures round the joins, with stabilisation and leveling on.
    const cv = new OffscreenCanvas(320, 180), r = await ReframeRenderer.create(cv);
    r.setLayout(joined.layout);
    const clip = (m: Media): TimelineClip => ({ ...newClip(m.path, m.durationUs, m.is360), id: `c${m.path}`, lensMode: m.is360 ? undefined : 'custom', look: look({ fov: 80 }), stabilize: { smoothing: 'off', horizon: false } });
    let worst = 0, decodeBad = 0;
    const dj = new TrackDecoder(joined.reader, joined.tracks[0]!);
    for (const j of joins) for (const i of [j - 2, j - 1, j, j + 1, j + 30]) {
      const px: Uint8ClampedArray[] = [];
      for (const [m, t] of [[joined, a[i]!], [whole, b[i]!]] as const) {
        const { frames, close } = await framesAt(m, t);
        r.resetHistory();
        pushClipFrame(r, clip(m), m, t, frames);
        presentLook(r, look({}));
        px.push(await pixels(cv));
        close();
      }
      let s = 0;
      for (let k = 0; k < px[0]!.length; k++) s = Math.max(s, Math.abs(px[0]![k]! - px[1]![k]!));
      worst = Math.max(worst, s);
    }
    // Decoding straight through the joins.
    for (const j of joins) {
      dj.seek(a[j - 8]!);
      for (let i = j - 8; i < j + 8; i++) {
        let f: VideoFrame | null = null;
        for (let k = 0; !f && k < 3000; k++) { void dj.pump(); f = dj.frameAt(a[i]!); if (!f) await sleep(1); }
        if (f?.timestamp !== a[i]) decodeBad++;
      }
    }
    dj.close();
    r.destroy();
    ok(`${label}: the same picture on both sides of every join`, worst <= 1, worst);
    ok(`${label}: decodes straight through the joins`, decodeBad === 0, decodeBad);
    // Motion data.
    let turn = 0, level = 0, atJoin = 0;
    for (const [i, t] of a.entries()) {
      const d = (st: { smoothing: 'medium' | 'off'; horizon: boolean }) => {
        const x = joined.stabilizer.correctionAt(t, { ...st, axisMap: DEFAULT_AXIS_MAP }), y = whole.stabilizer.correctionAt(b[i]!, { ...st, axisMap: DEFAULT_AXIS_MAP });
        let tr = 0;
        for (let k = 0; k < 9; k++) tr += x[k]! * y[k]!;
        return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
      };
      const s = d({ smoothing: 'medium', horizon: false });
      turn = Math.max(turn, s);
      if (joins.some((j) => Math.abs(i - j) < 40)) atJoin = Math.max(atJoin, s);
      level = Math.max(level, d({ smoothing: 'off', horizon: true }));
    }
    const sa = joined.stabilizer.data!, sb = whole.stabilizer.data!;
    out[`${label}: motion`] = { stabilizationDegrees: +turn.toFixed(3), nearJoins: +atJoin.toFixed(3), horizonDegrees: +level.toFixed(3), counts: [sa.cori.length, sb.cori.length, sa.grav.length, sb.grav.length, sa.gps?.length, sb.gps?.length, sa.accl?.length, sb.accl?.length, sa.gyro?.length, sb.gyro?.length] };
    ok(`${label}: stabilization and leveling carry on across the joins`, turn < 1 && level < 1, [turn, level]);
    ok(`${label}: all motion samples kept`, sa.cori.length === sb.cori.length && sa.grav.length === sb.grav.length && sa.accl!.length >= sb.accl!.length - 4, [sa.cori.length, sb.cori.length]);
    // Sound.
    const mix = async (m: Media) => (await mixTimeline(addClip(emptyTimeline(), newClip(m.path, m.durationUs, m.is360), 0), m.durationUs))!;
    const ma = (await mix(joined)).getChannelData(0), mb = (await mix(whole)).getChannelData(0);
    let power = 0, err = 0, n = 0, joinErr = 0;
    const near = (i: number) => joined.parts.some((p) => p.startUs > 0 && Math.abs(i / 48000 - p.startUs / S) < 0.06);
    for (let i = 0; i < Math.min(ma.length, mb.length); i++) { const e = (ma[i]! - mb[i]!) ** 2; if (near(i)) joinErr = Math.max(joinErr, e); else { err += e; power += mb[i]! ** 2; n++; } }
    ok(`${label}: the same sound, in step`, ma.length === mb.length && Math.sqrt(err / n) < Math.sqrt(power / n) * 0.05, { level: +Math.sqrt(power / n).toFixed(4), difference: +Math.sqrt(err / n).toFixed(5), worstAtJoin: +Math.sqrt(joinErr).toFixed(4) });
  };
  const flat = await getMedia(file('GX010900.MP4')), flatWhole = await getMedia(file('GX010133.MP4'));
  await compare('regular', flat, flatWhole, 3, [240, 540]);
  const sph = await getMedia(file('GS010901.360')), sphWhole = await getMedia(file('GS010120.360'));
  await compare('360', sph, sphWhole, 2, [144]);

  // --- Sound in blocks: the same as decoded in one go, and it keeps playing ------------------------------------
  {
    const m = await getMedia(file('GS010113.360'));
    const whole = toStereo((await decodeAudioRange(m.reader, m.info.audioTracks[0]!, 0, 44 * S))!)[0];
    const clip: TimelineClip = { ...newClip(m.path, m.durationUs, true), outUs: 44 * S };
    const mixed = (await mixTimeline(addClip(emptyTimeline(), clip, 0), 44 * S))!.getChannelData(0);
    let worst = 0, level = 0;
    for (let i = 0; i < 44 * 48000; i++) { worst = Math.max(worst, Math.abs(mixed[i]! - whole[i]!)); level += whole[i]! ** 2; }
    ok('sound in blocks is the same as in one piece', worst < 0.001, { worst: +worst.toFixed(6), level: +Math.sqrt(level / (44 * 48000)).toFixed(4) });
    const pl = new AudioPlayer();
    const inner = pl as unknown as { ctx: AudioContext; master: GainNode };
    const an = inner.ctx.createAnalyser();
    an.fftSize = 2048;
    inner.master.disconnect();
    const mute = inner.ctx.createGain();
    mute.gain.value = 0;
    inner.master.connect(an).connect(mute).connect(inner.ctx.destination);
    const tl = addClip(emptyTimeline(), clip, 0);
    await pl.prepare(tl);
    for (const [label, T, secs] of [['from the start', 0, 1.5], ['across a block', 18.8, 2.6], ['after a jump', 35, 1.5]] as const) {
      pl.play(tl, T * S);
      const t0 = performance.now();
      let first = -1, silent = 0, n = 0;
      const buf = new Float32Array(2048);
      while (performance.now() - t0 < secs * 1000) {
        await sleep(20);
        an.getFloatTimeDomainData(buf);
        const loud = Math.max(...buf.map(Math.abs));
        if (first < 0 && loud > 1e-5) first = performance.now() - t0;
        else if (first >= 0) { n++; if (loud < 1e-6) silent++; }
      }
      pl.stop();
      ok(`sound plays ${label}`, first >= 0 && first < 700 && silent <= 1, { firstSoundMs: Math.round(first), silent, of: n, state: inner.ctx.state });
    }
  }

  // --- Which files belong together -------------------------------------------------------------------------
  const pick = async (...n: string[]) => (await wholeRecordings(n.map(file))).map(baseName);
  ok('picking any part imports the whole recording once', JSON.stringify([await pick('GX020900.MP4'), await pick('GX030900.MP4', 'GX010900.MP4', 'GX020900.MP4'), await pick('GS020901.360', 'GX010133.MP4')]) === JSON.stringify([['GX010900.MP4'], ['GX010900.MP4'], ['GS010901.360', 'GX010133.MP4']]));
  const gap = await getMedia(file('GX010902.MP4')), gap3 = await getMedia(file('GX030902.MP4'));
  ok('a missing part is said, not skipped', gap.parts.length === 1 && /Part 2/.test(gap.partsNote ?? '') && gap3.parts.length === 1 && /Part 2/.test(gap3.partsNote ?? ''), [gap.partsNote, gap3.partsNote]);
  ok('and the parts stay separate', JSON.stringify(await pick('GX010902.MP4', 'GX030902.MP4')) === JSON.stringify(['GX010902.MP4', 'GX030902.MP4']));
  const other = await getMedia(file('GX010903.MP4'));
  ok('a file from another recording with a matching name is not joined', other.parts.length === 1 && /another time/.test(other.partsNote ?? ''), other.partsNote);
  ok('and both can be imported', (await pick('GX010903.MP4', 'GX020903.MP4')).length === 2);
  ok('ordinary files are left alone', flatWhole.parts.length === 1 && !flatWhole.partsNote);
  const later = await getMedia(file('GX020900.MP4'));
  ok('a later part still opens by itself (older projects)', later.parts.length === 2 && Math.abs(later.durationUs - (flat.durationUs - flat.parts[1]!.startUs)) < 2000);

  // --- In the app ----------------------------------------------------------------------------------------------
  await api.importPaths([file('GX020900.MP4'), file('GS020901.360'), file('GX010902.MP4')]);
  await sleep(700);
  const items = [...document.querySelectorAll<HTMLElement>('.bin-item')];
  ok('the media bin shows recordings and their parts', items.length === 3 && /GX010900.*3 parts/.test(items[0]!.textContent!) && /GS010901.*2 parts/.test(items[1]!.textContent!) && /Not all parts joined/.test(items[2]!.textContent!), items.map((e) => e.textContent));
  await ace.capture('chapters-ui');
  items[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(1200);
  for (const [name, at] of [['first', 3.0], ['second', 8.2]] as const) {
    api.player.seek(at * S);
    await sleep(900);
    const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
    api.player.play();
    await sleep(2500);
    api.player.pause();
    const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
    ok(`plays through the ${name} join in real time`, speed > 0.95 && api.player.stalls - s0 < 4 && api.player.time > (at + 1.5) * S, [+speed.toFixed(3), api.player.stalls - s0]);
  }
  for (const t of [4.02, 4.0, 9.0, 11.5, 0.5]) {
    api.player.seek(t * S);
    const t0 = performance.now();
    let got = -1;
    while (performance.now() - t0 < 4000) { await sleep(15); got = api.lastResult()?.layers?.[0]?.frames[0]?.timestamp ?? -1; if (Math.abs(got - t * S) < 20_000) break; }
    ok(`jumping to ${t}s`, Math.abs(got - t * S) < 20_000, Math.round(performance.now() - t0));
  }
  // Proxy of the whole recording, not of its first file.
  setPreviewLevel(8, [flat]);
  await proxiesIdle();
  const src = previewSource(flat);
  ok('its preview copy is of the whole recording', src.level === 8 && src.tracks[0]!.samples.length === flat.tracks[0]!.samples.length, [src.level, src.tracks[0]!.samples.length]);
  setPreviewLevel(1, [flat]);
  // Export across a join.
  const path = await ace.selftestOut('chapters.mp4');
  await exportTimeline(addClip(emptyTimeline(), { ...newClip(flat.path, flat.durationUs, false), inUs: 3 * S, outUs: 10 * S }, 0), { path, resolution: 720, fps: 60, codec: 'avc', quality: 'standard' }, () => {}, new AbortController().signal);
  const ex = await getMedia(path);
  ok('exports across both joins', Math.abs(ex.durationUs / S - 7) < 0.05 && ex.tracks[0]!.samples.length === 420, [ex.durationUs / S, ex.tracks[0]!.samples.length]);
  return { fails, ...out };
}

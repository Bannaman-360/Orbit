// Slow motion and speed ramps, against clips whose every frame carries its own number and whose
// sound clicks at known moments.

import { AudioBufferSource, BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output } from 'mediabunny';
import { addClip, clipDuration, hasRamp, clipStarts, newTextOverlay, detachAudio, emptyTimeline, localAt, mediaAt, newClip, rampPreset, slowSpans, splitAt, timelineDuration, type SpeedKey, type TimelineClip } from '@ace/project';
import { TrackDecoder } from '@ace/engine';
import { ace } from './api';
import { mixTimeline } from './audioEngine';
import { exportTimeline } from './exporter';
import { getMedia, type Media } from './media';
import { previewSource, proxiesIdle, setPreviewLevel } from './proxy';
import { defaultPrefs, setPrefs } from './ui/prefs';
import type { EditorApi } from './selftest';

const S = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (q: string) => document.querySelector<HTMLElement>(q);
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const k = (t: number, speed: number, ease?: SpeedKey['ease']): SpeedKey => ({ id: `k${t}`, t: t * S, speed, ...(ease ? { ease } : {}) });

/** A clip whose frames carry their number as a row of blocks, with a click every half second. */
async function numbered(name: string, W: number, H: number, fps: number, seconds: number, codec: 'avc' | 'hevc'): Promise<string> {
  const { fixtures } = await ace.info();
  const path = `${fixtures}/synthetic/${name}`;
  if ((await ace.listFixtures()).includes(path)) return path;
  if (!(await canEncodeVideo(codec, { width: W, height: H }))) codec = 'avc';
  const c = new OffscreenCanvas(W, H), x = c.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(c, { codec, bitrate: W > 2000 ? 60e6 : 25e6, keyFrameInterval: 0.5 });
  const audio = new AudioBufferSource({ codec: 'aac', bitrate: 128000 });
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();
  const rate = 48000, buf = new AudioBuffer({ numberOfChannels: 1, length: rate * seconds, sampleRate: rate }), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const t = i / rate, since = t % 0.5;
    d[i] = 0.02 * Math.sin(2 * Math.PI * 300 * t) + (t > 0.2 && since < 0.004 ? 0.8 * Math.sin(2 * Math.PI * 4000 * since) * (1 - since / 0.004) : 0);
  }
  await audio.add(buf);
  for (let f = 0; f < fps * seconds; f++) {
    x.fillStyle = `hsl(${(f * 3) % 360} 40% 40%)`;
    x.fillRect(0, 0, W, H);
    for (let b = 0; b < 12; b++) { x.fillStyle = (f >> b) & 1 ? '#fff' : '#000'; x.fillRect((W * b) / 12, H * 0.4, W / 12, H * 0.2); }
    await video.add(f / fps, 1 / fps);
  }
  await output.finalize();
  return ace.writeFile(path, new Uint8Array((output.target as BufferTarget).buffer!));
}
const reader = new OffscreenCanvas(240, 135);
function readNumber(src: CanvasImageSource): number {
  const x = reader.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, 240, 135);
  let n = 0;
  for (let b = 0; b < 12; b++) if (x.getImageData(b * 20 + 8, 64, 4, 4).data[0]! > 128) n |= 1 << b;
  return n;
}
/** Every frame of a file, as its number. */
async function numbers(m: Media): Promise<number[]> {
  const out: number[] = [], dec = new TrackDecoder(m.reader, m.tracks[0]!);
  dec.seek(0);
  for (const t of m.tracks[0]!.samples.map((s) => s.timestamp).sort((a, b) => a - b)) {
    let f: VideoFrame | null = null;
    for (let i = 0; !f && i < 4000; i++) { void dec.pump(); f = dec.frameAt(t); if (!f) await sleep(1); }
    out.push(f ? readNumber(f) : -1);
  }
  dec.close();
  return out;
}
/** Loud moments (s), each once. */
function clicks(b: AudioBuffer): number[] {
  const d = b.getChannelData(0), out: number[] = [];
  for (let i = 1; i < d.length; i++) if (Math.abs(d[i]!) > 0.2 && (!out.length || i / b.sampleRate - out[out.length - 1]! > 0.03)) out.push(i / b.sampleRate);
  return out;
}
const loud = (b: AudioBuffer, from: number, to: number) => { const d = b.getChannelData(0); let s = 0, n = 0; for (let i = Math.floor(from * b.sampleRate); i < Math.min(d.length, to * b.sampleRate); i++) { s += d[i]! ** 2; n++; } return Math.sqrt(s / Math.max(1, n)); };

const mid = (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
async function dragFrom(a: { x: number; y: number }, b: { x: number; y: number }) {
  await ace.selftestInput({ type: 'mouseMove', ...a });
  await ace.selftestInput({ type: 'mouseDown', ...a, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) { await ace.selftestInput({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * i) / 6), y: Math.round(a.y + ((b.y - a.y) * i) / 6), button: 'left', modifiers: ['leftButtonDown'] }); await sleep(25); }
  await ace.selftestInput({ type: 'mouseUp', ...b, button: 'left', clickCount: 1 });
  await sleep(250);
}
async function press(key: string, modifiers: string[] = []) {
  await ace.selftestInput({ type: 'keyDown', keyCode: key, modifiers });
  await ace.selftestInput({ type: 'keyUp', keyCode: key, modifiers });
  await sleep(250);
}

export async function speedCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  setPrefs(defaultPrefs());
  try { localStorage.removeItem('ace.speedLines'); } catch { /* */ }

  const p240 = await numbered('slow-240.mp4', 1920, 1080, 240, 6, 'hevc');
  const p120 = await numbered('slow-4k120.mp4', 3840, 2160, 120, 5, 'hevc');
  const p30 = await numbered('slow-30.mp4', 1280, 720, 30, 12, 'avc');
  const m240 = await getMedia(p240), m120 = await getMedia(p120), m30 = await getMedia(p30);
  ok('test clips', Math.abs(m240.fps - 240) < 1 && Math.abs(m120.fps - 120) < 1, [m240.fps, m120.fps, m240.tracks[0]!.codec, m120.tracks[0]!.codec]);
  await api.importPaths([p240, p120, p30]);

  // --- Exports show exactly the right pictures ------------------------------------------------------------
  const clip = (m: Media, o: Partial<TimelineClip>): TimelineClip => ({ ...newClip(m.path, m.durationUs, false), ...o });
  const ramped = { speedKeys: [k(1, 2), k(2, 0.125), k(2.5, 0.125), k(4, 6, 'linear'), k(5, 1)] };
  for (const [name, c] of [
    ['normal', clip(m240, { outUs: 2 * S })],
    ['slow motion 0.125×', clip(m240, { inUs: S, outUs: 2 * S, speed: 0.125 })],
    ['8×', clip(m240, { speed: 8 })],
    ['ramp', clip(m240, ramped)],
    ['ramp, trimmed into', clip(m240, { ...ramped, inUs: 1.7 * S, outUs: 4.4 * S })],
    ['ramp with jumps', clip(m30, { speedKeys: [k(2, 1, 'jump'), k(4, 4, 'jump'), k(8, 0.5)] })],
  ] as [string, TimelineClip][]) {
    const tl = addClip(emptyTimeline(), c), path = await ace.selftestOut(`speed-${name.replace(/\W+/g, '-')}.mp4`);
    const m = c.mediaPath === p240 ? m240 : m30, fps = Math.round(m.fps);
    await exportTimeline(tl, { path, resolution: 720, fps: 30, codec: 'avc', quality: 'high' }, () => {}, new AbortController().signal);
    const ex = await getMedia(path), got = await numbers(ex);
    const want = Array.from({ length: Math.ceil((clipDuration(c) / 1e6) * 30 - 1e-6) }, (_, i) => Math.min(Math.floor(m.durationUs / 1e6 * fps) - 1, Math.floor((Math.min(c.outUs - 1, mediaAt(c, (i * 1e6) / 30)) / 1e6) * fps + Math.min(0.25, 0.001 * fps))));
    const off = got.map((g, i) => Math.abs(g - (want[i] ?? -99)));
    ok(`export ${name}: right picture at every moment`, got.length === want.length && off.every((d) => d <= 1) && off.filter((d) => d).length <= got.length * 0.05, { frames: got.length, want: want.length, offByOne: off.filter((d) => d === 1).length, worse: off.filter((d) => d > 1).length });
  }

  // --- Sound --------------------------------------------------------------------------------------------------
  for (const keepPitch of [false, true]) for (const [name0, c0] of [['2×', clip(m30, { speed: 2 })], ['0.5×', clip(m30, { speed: 0.5 })], ['ramp', clip(m30, { speedKeys: [k(1, 1), k(3, 3), k(5, 0.6), k(7, 0.6, 'linear'), k(10, 2)] })], ['jumps', clip(m30, { speedKeys: [k(2, 1, 'jump'), k(4, 4, 'jump'), k(8, 0.5)] })], ['trimmed ramp', clip(m30, { inUs: 2.1 * S, outUs: 9.3 * S, speedKeys: [k(1, 1), k(3, 3), k(5, 0.6), k(7, 0.6), k(10, 2)] })]] as [string, TimelineClip][]) {
    const c = { ...c0, keepPitch }, name = `${name0}${keepPitch ? ', pitch kept' : ', like a tape'}`;
    const tl = addClip(emptyTimeline(), c), mix = (await mixTimeline(tl, timelineDuration(tl)))!;
    // (AAC adds its own small delay to the file: measured on the file itself.)
    const plain = (await mixTimeline(addClip(emptyTimeline(), clip(m30, {})), m30.durationUs))!;
    const heard = clicks(mix), media = clicks(plain).filter((t) => t * S > c.inUs + 2000 && t * S < c.outUs - 20_000);
    const want = media.map((t) => localAt(c, t * S) / S).filter((t) => t > 0);
    const err = want.map((t) => Math.min(...heard.map((h) => Math.abs(h - t))));
    // Kept pitch: sped-up sound leaves out bits of the original, so a click a few milliseconds long can go; what is heard must be in place.
    const placed = heard.map((h) => Math.min(...want.map((t) => Math.abs(h - t))));
    const slowOnly = !hasRamp(c) && (c.speed ?? 1) < 1;
    const good = !keepPitch ? want.length > 5 && Math.max(...err) < 0.012 && Math.abs(heard.length - want.length) <= 1
      : slowOnly ? Math.max(...err) < 0.02 && Math.abs(heard.length - want.length) <= 1
        : heard.length >= want.length * 0.6 && Math.max(...placed) < 0.02;
    ok(`sound ${name}: clicks where the picture is`, good, { clicks: want.length, heard: heard.length, worstMs: +(Math.max(...err) * 1000).toFixed(1), heardWorstMs: +(Math.max(...placed) * 1000).toFixed(1) });
  }
  {
    // The 300 Hz hum under the clicks: its pitch at other speeds.
    const pitch = (b: AudioBuffer, from: number, to: number) => {
      const d = b.getChannelData(0), r = b.sampleRate;
      // (Only quiet stretches: the clicks would count as crossings.)
      const hz: number[] = [];
      for (let t = from; t + 0.06 < to; t += 0.05) {
        const a = Math.floor(t * r), z = Math.floor((t + 0.06) * r);
        let peak = 0;
        for (let i = a; i < z; i++) peak = Math.max(peak, Math.abs(d[i]!));
        if (peak > 0.06 || peak < 0.005) continue;
        let first = -1, last = -1, n = 0;
        for (let i = a + 1; i < z; i++) if (d[i - 1]! < 0 && d[i]! >= 0) { const x = i - 1 + -d[i - 1]! / (d[i]! - d[i - 1]!); if (first < 0) first = x; last = x; n++; }
        if (n > 5) hz.push(((n - 1) * r) / (last - first));
      }
      hz.sort((x, y) => x - y);
      return hz.length ? hz[hz.length >> 1]! : NaN;
    };
    const base = pitch((await mixTimeline(addClip(emptyTimeline(), clip(m30, {})), m30.durationUs))!, 0.5, 11);
    for (const [name, c, a, b] of [['0.5×', clip(m30, { speed: 0.5 }), 1, 20], ['2×', clip(m30, { speed: 2 }), 0.3, 5.5], ['ramp, slow part', clip(m30, { speedKeys: [k(2, 1), k(4, 0.3), k(7, 0.3), k(9, 2)] }), 7.5, 13], ['ramp, fast part', clip(m30, { speedKeys: [k(2, 1), k(4, 0.3), k(7, 0.3), k(9, 2)] }), 14.6, 15.8]] as [string, TimelineClip, number, number][]) {
      const mix = (await mixTimeline(addClip(emptyTimeline(), c), clipDuration(c)))!;
      const hz = pitch(mix, a, b);
      ok(`sound ${name}: keeps its pitch`, Math.abs(hz / base - 1) < 0.02, { hz: +hz.toFixed(1), recorded: +base.toFixed(1) });
    }
    const tape = (await mixTimeline(addClip(emptyTimeline(), clip(m30, { speed: 0.5, keepPitch: false })), 24 * S))!;
    ok('switched off, it goes deep like a tape', Math.abs(pitch(tape, 1, 20) / base - 0.5) < 0.02, +pitch(tape, 1, 20).toFixed(1));
  }
  {
    const c = clip(m30, { speedKeys: [k(2, 1), k(4, 0.25), k(6, 0.25), k(8, 1)], muteBelow: 0.5 });
    const tl = addClip(emptyTimeline(), c), mix = (await mixTimeline(tl, timelineDuration(tl)))!;
    const [span] = slowSpans(c, 0.5) as [[number, number]];
    const a = span[0] / S, b = span[1] / S;
    ok('slow parts are silent, the rest is heard', loud(mix, a + 0.02, b - 0.02) < 1e-4 && loud(mix, 0.5, a - 0.2) > 0.005 && loud(mix, b + 0.2, b + 2) > 0.005, [loud(mix, a, b), loud(mix, 0.5, a - 0.2), loud(mix, b + 0.2, b + 2), a, b]);
    const d = detachAudio(tl, c.id), dm = (await mixTimeline(d, timelineDuration(d)))!;
    let diff = 0;
    for (let i = 0; i < mix.length; i += 7) diff = Math.max(diff, Math.abs(mix.getChannelData(0)[i]! - dm.getChannelData(0)[i]!));
    ok('detached sound is the same', diff < 0.002, diff);
    const two = splitAt(tl, timelineDuration(tl) * 0.4), sm = (await mixTimeline(two, timelineDuration(two)))!;
    const e = clicks(mix).map((t) => Math.min(...clicks(sm).map((h) => Math.abs(h - t))));
    ok('splitting a ramp keeps the sound in place', Math.max(...e) < 0.012, Math.max(...e));
  }

  // --- The preview -------------------------------------------------------------------------------------------------
  const play = async (c: TimelineClip, from: number, ms: number) => {
    api.setTimeline(addClip(emptyTimeline(), c));
    api.player.seek(from);
    await sleep(900);
    const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
    api.player.play();
    let last = -1, pictures = 0, worst = 0, held = performance.now();
    while (performance.now() - w0 < ms && api.player.playing) {
      await api.nextRender();
      const ts = api.lastResult()?.layers?.[0]?.frames[0]?.timestamp ?? -1;
      if (ts !== last) { pictures++; last = ts; worst = Math.max(worst, performance.now() - held); held = performance.now(); }
      await sleep(0);
    }
    const t = performance.now() - w0, speed = (api.player.time - p0) / 1000 / t;
    api.player.pause();
    return { speed: +speed.toFixed(3), stalls: api.player.stalls - s0, picturesPerS: Math.round((pictures * 1000) / t), longestHoldMs: Math.round(worst), skim: (api.player.debug()[0]!.dec[0] as { skim?: boolean }).skim };
  };
  const perf: Record<string, unknown> = {};
  const real360 = (await ace.listFixtures()).find((f) => /GS010083\.360$/.test(f))!, r360 = await getMedia(real360);
  const real4k = (await ace.listFixtures()).find((f) => /GX010133\.MP4$/.test(f))!, r4k = await getMedia(real4k);
  for (const [name, c, ms] of [
    ['1080p 240 fps at 1×', clip(m240, {}), 4000], ['240 fps at 0.125×', clip(m240, { speed: 0.125 }), 3000], ['240 fps at 4×', clip(m240, { speed: 4 }), 1200], ['240 fps ramp', clip(m240, ramped), 6000],
    ['4K 120 fps at 1×', clip(m120, {}), 4000], ['4K 120 fps at 2×', clip(m120, { speed: 2 }), 2000], ['4K 120 fps at 8× (first time)', clip(m120, { speed: 8 }), 550], ['4K 120 fps at 8×', clip(m120, { speed: 8 }), 550],
    ['real 4K60 at 2×', clip(r4k, { speed: 2 }), 3500], ['real 4K60 at 8× (first time)', clip(r4k, { speed: 8 }), 1300], ['real 4K60 at 8×', clip(r4k, { speed: 8 }), 1300],
    ['real 360 (60 fps) at 2×', { ...newClip(real360, r360.durationUs, true), speed: 2 }, 4000], ['real 360 at 4×, sound like a tape', { ...newClip(real360, r360.durationUs, true), speed: 4, keepPitch: false }, 4000], ['real 360 at 4×', { ...newClip(real360, r360.durationUs, true), speed: 4 }, 4000], ['real 360 at 8×', { ...newClip(real360, r360.durationUs, true), speed: 8 }, 2800],
    ['real 360 ramp (first time)', { ...newClip(real360, r360.durationUs, true), speedKeys: [k(2, 1), k(3, 6), k(15, 6), k(16, 0.5)] }, 6500],
    ['real 360 ramp', { ...newClip(real360, r360.durationUs, true), speedKeys: [k(2, 1), k(3, 6), k(15, 6), k(16, 0.5)] }, 6500],
  ] as [string, TimelineClip, number][]) {
    const r = await play(c, 0, ms);
    perf[name] = r;
    ok(`plays in real time: ${name}`, r.speed > (/first time/.test(name) ? 0.6 : 0.93), r);
  }
  for (const [n, c] of [['ramp', clip(m240, ramped)], ['0.1×', clip(m30, { speed: 0.1, outUs: 2 * S })]] as [string, TimelineClip][]) {
    api.setTimeline(addClip(emptyTimeline(), c));
    const L = clipDuration(c), m = c.mediaPath === p240 ? m240 : m30;
    let bad = 0;
    for (const f of [0.05, 0.6, 0.31, 0.9, 0.45, 0.12]) {
      api.player.seek(L * f);
      const want = mediaAt(c, L * f);
      const t0 = performance.now();
      let ts = -1;
      while (performance.now() - t0 < 3000) { await sleep(20); ts = api.lastResult()?.layers?.[0]?.frames[0]?.timestamp ?? -1; if (ts <= want + 1000 && ts > want - 1e6 / m.fps - 1000) break; }
      if (!(ts <= want + 1000 && ts > want - 1e6 / m.fps - 1000)) bad++;
    }
    ok(`scrubbing shows the right picture: ${n}`, bad === 0, bad);
  }

  // --- With a smaller preview copy --------------------------------------------------------------------------------
  setPreviewLevel(4, [m120]);
  await proxiesIdle();
  ok('a smaller copy of a 120 fps clip keeps all its pictures', previewSource(m120).level === 4 && previewSource(m120).tracks[0]!.samples.length === m120.tracks[0]!.samples.length);
  const px = await play(clip(m120, { speed: 8 }), 0, 550);
  ok('and plays at 8×', px.speed > 0.93, px);
  setPreviewLevel(1, [m120]);

  // --- The editor ---------------------------------------------------------------------------------------------------------
  const c0 = clip(m240, { id: 'edit' });
  const twoClips = addClip(addClip(emptyTimeline(), c0), clip(m30, { id: 'after' }));
  api.setTimeline({ ...twoClips, overlays: [{ ...newTextOverlay(clipDuration(c0) + 2 * S, clipDuration(c0) + 4 * S, 'On the second clip'), id: 'title2' }] });
  await sleep(500);
  api.player.seek(3 * S);
  await sleep(400);
  const cur = () => api.getTimeline().clips[0]!;
  const shown = () => mediaAt(cur(), api.player.time);
  const tab = $('.dock-tab[data-panel="clip"]')!;
  await ace.selftestInput({ type: 'mouseDown', ...mid(tab), button: 'left', clickCount: 1 });
  await ace.selftestInput({ type: 'mouseUp', ...mid(tab), button: 'left', clickCount: 1 });
  await sleep(400);
  const chip = (t: RegExp) => $$('[data-panel-body="clip"] button').find((b) => t.test(b.textContent ?? ''))!;
  ok('a fast clip offers slow motion', /0\.125×/.test(chip(/Use as slow motion/)?.textContent ?? ''), chip(/Use as slow motion/)?.textContent);
  ok('no speed line until asked for', !$('.speed-line'));
  await ace.capture('speed-plain');
  chip(/Use as slow motion/).click();
  await sleep(300);
  ok('use as slow motion', Math.abs(cur().speed - 0.125) < 1e-6 && cur().muteBelow === 0.5 && Math.abs(shown() - 3 * S) < 2000, [cur().speed, shown()]);
  await press('Z', ['meta']);
  ok('undo', cur().speed === 1 && cur().muteBelow === undefined, cur().speed);
  api.player.seek(3 * S);
  await sleep(200);
  for (const [name] of [['Slow moment'], ['Fast – slow – fast'], ['Fast forward'], ['Slow start'], ['Slow finish'], ['Speed up'], ['Slow down']] as const) {
    chip(new RegExp(`^${name}$`)).click();
    await sleep(120);
    ok(`preset ${name} keeps the picture`, (cur().speedKeys?.length ?? 0) >= 2 && Math.abs(shown() - 3 * S) < 3000, [cur().speedKeys?.length, shown()]);
  }
  chip(/^Slow moment$/).click();
  await sleep(300);
  {
    const tl2 = api.getTimeline(), o = tl2.overlays.find((x) => x.id === 'title2')!;
    ok('a title on the next clip moves with it', Math.abs(o.startUs - (clipStarts(tl2)[1]! + 2 * S)) < 2 && o.endUs - o.startUs === 2 * S, [o.startUs, clipStarts(tl2)[1]]);
  }
  ok('the next clip follows on', Math.abs(clipStarts(api.getTimeline())[1]! - clipDuration(cur())) < 1);
  ok('a ramp shows its line and points', $$('.speed-line').length === 1 && $$('.speed-point').length === 4, [$$('.speed-line').length, $$('.speed-point').length]);
  await ace.capture('speed-ramp');
  // Points by hand.
  {
    const before = cur().speedKeys!;
    const pt = $$('.speed-point')[1]!, a = mid(pt);
    await dragFrom(a, { x: a.x, y: a.y - 18 });
    ok('drag a point up: faster', cur().speedKeys![1]!.speed > before[1]!.speed * 1.3 && Math.abs(cur().speedKeys![1]!.t - before[1]!.t) < 1, [before[1], cur().speedKeys![1]]);
    ok('the picture stays while dragging', Math.abs(shown() - 3 * S) < 5000, shown());
    const t1 = cur().speedKeys![3]!.t, b = mid($$('.speed-point')[3]!);
    await dragFrom(b, { x: b.x + 60, y: b.y });
    ok('drag a point right: later', cur().speedKeys![3]!.t > t1 + 50_000 && cur().speedKeys![3]!.speed === 1, [t1, cur().speedKeys![3]]);
    await press('Backspace');
    ok('⌫ deletes the point, not the clip', cur().speedKeys!.length === 3 && api.getTimeline().clips.length === 2, cur().speedKeys!.length);
    await press('Z', ['meta']);
    ok('undo brings it back', cur().speedKeys!.length === 4);
    // Double-click the line near the clip's start.
    const line = $('.speed-grab') as unknown as SVGPolylineElement, r = line.ownerSVGElement!.getBoundingClientRect();
    const [x0, y0] = line.getAttribute('points')!.split(' ')[0]!.split(',').map(Number) as [number, number];
    const at = { x: Math.round(r.left + x0 + 40), y: Math.round(r.top + y0) };
    for (const n of [1, 2]) { await ace.selftestInput({ type: 'mouseDown', ...at, button: 'left', clickCount: n }); await ace.selftestInput({ type: 'mouseUp', ...at, button: 'left', clickCount: n }); }
    await sleep(300);
    ok('double-click adds a point that changes nothing yet', cur().speedKeys!.length === 5 && cur().speedKeys!.some((x) => Math.abs(x.speed - 1) < 1e-6 && x.t < 1.5 * S), cur().speedKeys!.map((x) => [x.t, x.speed]));
    $('.speed-point.selected')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 600 }));
    await sleep(200);
    const item = $$('.menu.context button').find((b) => /Jump/.test(b.textContent ?? ''));
    item?.click();
    await sleep(200);
    ok('its menu sets how it changes', cur().speedKeys!.some((x) => x.ease === 'jump'));
    const slider = $$('[data-panel-body="clip"] .slider').find((s) => /Speed here/.test(s.textContent ?? ''));
    ok('the slider is for the speed here', !!slider);
    chip(/Remove ramp/).click();
    await sleep(250);
    ok('remove ramp', !cur().speedKeys && cur().speed === 1 && !$('.speed-line'));
  }
  // The line on a clip without a ramp.
  await press('R');
  ok('R shows the lines', $$('.speed-line').length === 2);
  {
    const line = $('.speed-grab') as unknown as SVGPolylineElement, r = line.ownerSVGElement!.getBoundingClientRect();
    const y = Number(line.getAttribute('points')!.split(' ')[0]!.split(',')[1]);
    const a = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + y) };
    await dragFrom(a, { x: a.x, y: a.y - 20 });
    ok('drag the line: the whole clip', cur().speed > 1.5 && !cur().speedKeys, cur().speed);
    await ace.capture('speed-lines');
    const b = { x: Math.round(r.left + 60), y: Math.round(r.top + r.height - 4) };
    const len = api.getTimeline().clips.length;
    await dragFrom(b, { x: b.x, y: b.y });
    ok('the clip itself can still be clicked', api.getTimeline().clips.length === len);
  }
  await press('R');
  ok('R hides them again', !$('.speed-line'));
  // Trimming a ramped clip keeps its points on the same moments.
  api.setTimeline(addClip(emptyTimeline(), clip(m240, { id: 'trim', ...ramped })));
  await sleep(400);
  {
    const b = mid($('.clip .trim.left')!), keys = JSON.stringify(cur().speedKeys), want = mediaAt(cur(), 0);
    await dragFrom(b, { x: b.x + 50, y: b.y });
    ok('trimming moves the edge, not the ramp', JSON.stringify(cur().speedKeys) === keys && cur().inUs > want + 100_000, cur().inUs);
  }
  // Keyframes, tracking marks, gauges: all where the picture is.
  api.setTimeline(addClip(emptyTimeline(), clip(m240, { id: 'kf', speedKeys: rampPreset('slow-moment', clip(m240, {}), 3 * S, 0.125), keyframes: [{ id: 'q', t: 4 * S, easing: 'smooth', look: newClip('', 1, false).look }] })));
  await sleep(400);
  {
    const kf = $('.clip-kf')!, r = $('.clip')!.getBoundingClientRect();
    const px2 = kf.getBoundingClientRect().left + 10 - r.left, want = (localAt(cur(), 4 * S) / clipDuration(cur())) * r.width;
    ok('keyframes sit on their moment', Math.abs(px2 - want) < 4, [px2, want]);
    kf.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    await sleep(300);
    ok('clicking one goes there', Math.abs(shown() - 4 * S) < 5000, shown());
  }
  ok('no errors', !errors.length, errors);
  return { fails, ...out };
}

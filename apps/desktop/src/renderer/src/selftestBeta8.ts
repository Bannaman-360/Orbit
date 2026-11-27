// Beta 8 and the rest of milestone 2, in the running app: the track header column, taller tracks
// with keyframes, cuts on a selected track clip, gauges trimmed with a cut and reading a track
// clip's ride data, solo sound, on/off switches, social export presets (size and loudness),
// compound clips and multicam.

import {
  addClip, addMulticam, emptyTimeline, envelopeOffset, flattenTimeline, isCompound, makeCompound, newClip, newGaugeOverlay, placeConnected,
  stackAt, timelineDuration, type Timeline,
} from '@ace/project';
import { ace } from './api';
import { mixTimeline } from './audioEngine';
import { framesAt } from './calib';
import { exportTimeline, grabFrame } from './exporter';
import { reframeForExport } from './exportReframe';
import { fovForAspect } from '@ace/media360';
import { measureLufs } from './loudness';
import { clipSound, getMedia, type Media } from './media';
import { soundEnvelope } from './multicamSync';
import { gaugeReading } from './overlayRender';
import type { EditorApi } from './selftest';
import type { LayerFrame } from './timelinePlayer';
import { LAYOUTS } from './ui/prefs';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (q: string) => document.querySelector<HTMLElement>(q);
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

async function settle(api: EditorApi, renders = 6) {
  const deadline = performance.now() + 8000;
  for (let i = 0; i < renders; i++) await Promise.race([api.nextRender(), sleep(Math.max(0, deadline - performance.now()))]);
  await sleep(250);
}
const press = (el: Element, type: string, x = 0, y = 0) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 7 }));
async function click(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  press(el, 'pointerdown', r.left + r.width / 2, r.top + r.height / 2);
  press(window as unknown as Element, 'pointerup', r.left + r.width / 2, r.top + r.height / 2);
  await sleep(150);
}

async function stackFrames(tl: Timeline, T: number): Promise<{ layers: LayerFrame[]; close: () => void }> {
  const st = stackAt(tl, T)!;
  const layers: LayerFrame[] = [], closers: (() => void)[] = [];
  for (const l of st.layers) {
    const m = await getMedia(l.clip.mediaPath);
    const f = await framesAt(m, l.mediaUs);
    closers.push(f.close);
    layers.push({ clip: l.clip, index: l.index, track: l.track, role: l.role, media: m, layout: m.layout, level: 1, mediaUs: l.mediaUs, frames: f.frames });
  }
  return { layers, close: () => closers.forEach((c) => c()) };
}
async function pixels(path: string, w = 96, h = 54) {
  const bmp = await createImageBitmap(new Blob([(await ace.readAll(path)) as Uint8Array<ArrayBuffer>]));
  const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0, w, h);
  return x.getImageData(0, 0, w, h).data;
}
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) s += Math.abs(a[i + k]! - b[i + k]!); return s / ((a.length / 4) * 3); };
async function grab(tl: Timeline, T: number, name: string) {
  const f = await stackFrames(tl, T);
  const p = await ace.selftestOut(name);
  await grabFrame(tl, T, f.layers, p, 720);
  f.close();
  return pixels(p);
}

export async function beta8Check(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  try {
    await beta8Steps(api, out, fails);
  } catch (e) {
    fails.push(`stopped in “${String(out.step)}”: ${e}`);
  }
  await ace.capture('beta8');
  return { fails, ...out };
}

async function beta8Steps(api: EditorApi, out: Record<string, unknown>, fails: string[]) {
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end));
  const ride = await getMedia(fix('GX010133.MP4')!);
  // A recording with sound, for the sound checks.
  let loud: Media | null = null;
  for (const n of ["GX010133.MP4", "GX010132.MP4", "GS010115.360", "GS010113.360", "GS010116.360"]) { const f = fix(n); if (!f) continue; const m = await getMedia(f).catch(() => null); if (m && clipSound(m)) { loud = m; break; } }
  out.soundFrom = loud?.name ?? "none";
  const plain = await getMedia(fix('virtual-ride.mp4')!);
  await api.importPaths([ride.path, plain.path]);
  const clipOf = (m: Media, len: number, from = 0) => ({ ...newClip(m.path, m.durationUs, m.is360), inUs: from, outUs: Math.min(m.durationUs, from + len) });

  // --- Timeline: buttons in a column, tall tracks with keyframes, zoom range

  out.step = 'Timeline: buttons in a column, tall tracks with keyframes, zoom range';
  let tl = addClip(emptyTimeline(), clipOf(plain, 10 * S));
  const kf = { ...clipOf(ride, 6 * S, 1 * S), keyframes: [{ id: 'k1', t: 3 * S, easing: 'smooth' as const, look: newClip(ride.path, 1, false).look }] };
  tl = placeConnected(tl, kf, 0)!.tl;
  api.setTimeline(tl);
  await settle(api);
  const head = $('.vtrack-head')?.getBoundingClientRect(), trim = $('.vclip .trim.left')?.getBoundingClientRect();
  ok('track buttons sit in a column beside the clips, not over them', !!head && !!trim && trim.left >= head.right - 0.5, { head: head?.right, trimLeft: trim?.left });
  const vh = $('.vtrack')?.getBoundingClientRect().height ?? 0, mh = $('.video-track')?.getBoundingClientRect().height ?? 1;
  ok('tracks above are nearly as tall as the main row', vh >= 0.8 * mh, { vh, mh });
  ok('a track clip shows its keyframes', $$('.vclip .clip-kf').length === 1);
  const zoom = $('input[aria-label="Timeline zoom"]') as HTMLInputElement | null;
  ok('the zoom slider zooms out further', !!zoom && Math.exp(+zoom.min) < 1, zoom && Math.exp(+zoom.min));
  ok('layouts with the timeline under one side panel', ['Tall inspector', 'Tall media'].every((n) => LAYOUTS.some(([x]) => x === n)));

  // --- Cuts act on the selected track clip

  out.step = 'Cuts act on the selected track clip';
  if ($('.vclip')) await click($('.vclip')!); else fails.push('no track clip on the timeline');
  api.player.seek(3 * S);
  await sleep(200);
  api.run!('split');
  await sleep(200);
  tl = api.getTimeline();
  ok('split cuts the selected track clip, not the main row', tl.connected.length === 2 && tl.clips.length === 1, { connected: tl.connected.length, main: tl.clips.length });
  out.selectedAfterClick = !!$('.vclip.selected');
  const right = tl.connected.find((c) => c.startUs > 1 * S) ?? tl.connected[0]!;
  const vclips = $$('.vclip').sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  out.vclips = vclips.length;
  if (vclips.length) await click(vclips[vclips.length - 1]!);
  api.player.seek(4 * S);
  await sleep(200);
  api.run!('delLeft');
  await sleep(200);
  tl = api.getTimeline();
  const r2 = tl.connected.find((c) => c.id === right.id);
  ok('delete left trims the selected track clip', !!r2 && Math.abs(r2.startUs - 4 * S) < 2000 && tl.clips[0]!.inUs === 0, r2 && { start: r2.startUs, inUs: r2.inUs });

  // --- Gauges end with the video after a cut

  out.step = 'Gauges end with the video after a cut';
  api.setTimeline({ ...addClip(emptyTimeline(), clipOf(plain, 10 * S)), overlays: [newGaugeOverlay('speed', 0, 10 * S)] });
  await settle(api, 2);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  api.player.seek(6 * S);
  await sleep(200);
  api.run!('delRight');
  await sleep(200);
  tl = api.getTimeline();
  ok('a gauge is trimmed with the footage', Math.abs(timelineDuration(tl) - 6 * S) < 50_000 && Math.abs(tl.overlays[0]!.endUs - timelineDuration(tl)) < 1000, { dur: timelineDuration(tl), end: tl.overlays[0]!.endUs });

  // --- A gauge reads a track clip's ride data

  out.step = "A gauge reads a track clip's ride data";
  {
    let g = addClip(emptyTimeline(), clipOf(plain, 10 * S));
    g = placeConnected(g, clipOf(ride, 8 * S, 2 * S), 1 * S)!.tl;
    const vid = g.connected[0]!.id;
    const gauge = newGaugeOverlay('gforce', 0, 10 * S);
    const own = gaugeReading(gauge, g, 4 * S), fromTrack = gaugeReading({ ...gauge, sourceClipId: vid }, g, 4 * S);
    const direct = ride.telemetry.gforceAt(5 * S);
    ok('a gauge can show the ride data of a clip on V2', !own.available && fromTrack.available && Math.abs(fromTrack.num - direct) < 0.5, { own: own.value, track: fromTrack.value, direct });
  }

  // --- Solo sound

  out.step = 'Solo sound';
  if (loud) {
    let t = addClip(emptyTimeline(), clipOf(loud, 8 * S, 0));
    t = placeConnected(t, { ...clipOf(loud, 3 * S, 1 * S), volume: 0, soloSound: true }, 3 * S)!.tl;
    const mix = await mixTimeline(t, timelineDuration(t));
    out.soloDebug = { mix: !!mix, dur: timelineDuration(t), sound: !!clipSound(loud), path: loud.name, tracks: t.tracks.length, connected: t.connected.length };
    if (!mix) throw new Error(`no mix ${JSON.stringify(out.soloDebug)}`);
    const rms = (a: number, b: number) => { const d = mix!.getChannelData(0); let s = 0; const i0 = Math.round(a * mix!.sampleRate), i1 = Math.round(b * mix!.sampleRate); for (let i = i0; i < i1; i++) s += d[i]! ** 2; return Math.sqrt(s / (i1 - i0)); };
    const before = rms(1, 2.8), during = rms(3.3, 5.7);
    ok('solo sound silences the other clips while it plays', before > 0.003 && during < before * 0.05, { before: +before.toFixed(4), during: +during.toFixed(5) });
  } else out['solo sound'] = 'skipped (no sound in fixture)';

  // --- On/off switches

  out.step = 'On/off switches';
  {
    const base = clipOf(ride, 4 * S, 4 * S);
    const lit = { ...base, look: { ...base.look, grade: { ...base.look.grade, exposure: 2 } } };
    const plainPic = await grab(addClip(emptyTimeline(), base), 1 * S, 'b8-off-plain.png');
    const litPic = await grab(addClip(emptyTimeline(), lit), 1 * S, 'b8-off-lit.png');
    const offPic = await grab(addClip(emptyTimeline(), { ...lit, off: ['grade.exposure'] }), 1 * S, 'b8-off-off.png');
    ok('a change switched off is left out of the export (and kept)', diff(plainPic, litPic) > 10 && diff(plainPic, offPic) < 2, { lit: +diff(plainPic, litPic).toFixed(1), off: +diff(plainPic, offPic).toFixed(2) });
    api.setTimeline(addClip(emptyTimeline(), lit));
    await settle(api, 2);
    const sw = $('.slider-toggle[aria-label^="Exposure"]');
    if (sw) { sw.click(); await sleep(150); ok('the switch beside Exposure turns it off', api.getTimeline().clips[0]!.off?.includes('grade.exposure') === true); }
    else out['exposure switch'] = 'not on screen in this layout';
  }

  // --- Compound clips

  out.step = 'Compound clips';
  {
    let t = addClip(emptyTimeline(), clipOf(plain, 5 * S));
    t = addClip(t, clipOf(ride, 5 * S, 2 * S));
    t = addClip(t, clipOf(plain, 4 * S, 1 * S));
    const made = makeCompound(t, 1, 2)!;
    api.setTimeline(made.tl);
    api.player.seek(7 * S);
    await settle(api, 8);
    out.shownAt7 = [api.player.time, api.lastResult()?.mediaUs];
    ok('a compound clip plays the clips inside it', api.lastResult()?.layers?.[0]?.clip.mediaPath === ride.path && timelineDuration(made.tl) === timelineDuration(t), api.lastResult()?.layers?.[0]?.clip.mediaPath);
    out.step = 'compound: grab';
    out.flatPaths = flattenTimeline(made.tl).clips.map((c) => c.mediaPath.split('/').pop());
    const a = await grab(flattenTimeline(made.tl), 7 * S, 'b8-compound.png'), b = await grab(t, 7 * S, 'b8-compound-ref.png');
    out.step = 'compound: open';
    ok('and exports the same picture', diff(a, b) < 1, +diff(a, b).toFixed(2));
    const block = $('.clip.compound');
    block?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(300);
    ok('double-click opens it, with a way back', !!$('.tl-crumbs') && api.getTimeline().clips.length === 2 && !api.getTimeline().clips.some(isCompound));
    // A change inside shows outside.
    api.setTimeline({ ...api.getTimeline(), clips: api.getTimeline().clips.slice(0, 1) });
    await sleep(100);
    $('.tl-crumbs button')?.click();
    await sleep(300);
    tl = api.getTimeline();
    ok('going back keeps the change inside', !$('.tl-crumbs') && tl.clips.length === 2 && isCompound(tl.clips[1]!) && Math.abs(timelineDuration(tl) - 10 * S) < 1000, { clips: tl.clips.length, dur: timelineDuration(tl) });
    out.step = 'compound: save';
    const saved = JSON.parse(api.saveText!());
    ok('the project keeps the compound clip', saved.timeline.sequences?.length === 1);
  }

  // --- Multicam

  out.step = 'Multicam';
  {
    const env = await soundEnvelope(loud?.path ?? ride.path);
    if (env) {
      // Two "cameras": one from the start, one that started 3 s later (the same sound).
      const r = envelopeOffset(env.slice(0, env.length - 300), env.slice(300));
      ok('sound sync finds a camera that started 3 s later', r.lag === 300 && r.confidence > 4, { ...r, steps: env.length });
    } else out['sound sync'] = 'skipped (no sound)';
    const angles = [{ path: ride.path, offsetUs: 0, durationUs: ride.durationUs }, { path: ride.path, offsetUs: 3 * S, durationUs: ride.durationUs - 3 * S }];
    const m = addMulticam(emptyTimeline(), angles, 'Test');
    const t = { ...m.tl, clips: m.tl.clips.map((c) => ({ ...c, inUs: 2 * S, outUs: 9 * S })) };
    api.setTimeline(t);
    api.player.seek(4 * S);
    await settle(api, 2);
    ok('the angle viewer shows every camera', $$('.angle-viewer .angle').length === 2);
    api.run!('angle2');
    await sleep(200);
    const c = api.getTimeline().clips;
    ok('pressing 2 cuts to angle 2 at the playhead, on the same moment', c.length === 2 && c[1]!.multicam?.angle === 1 && Math.abs(c[1]!.inUs - 3 * S) < 2000, c.map((x) => [x.multicam?.angle, x.inUs]));
  }

  // --- Export preset: TikTok shape and loudness

  out.step = 'Export preset: TikTok shape and loudness';
  if (loud) {
    const path = await ace.selftestOut('b8-tiktok.mp4');
    const src = await mixTimeline(addClip(emptyTimeline(), clipOf(loud, 4 * S, 1 * S)), 4 * S);
    const before = src ? measureLufs([src.getChannelData(0), src.getChannelData(1)], src.sampleRate) : NaN;
    // (Very quiet sound is raised by 24 dB at most.)
    const want = Math.min(-14, before + 24);
    out.loudnessBefore = +before.toFixed(2);
    const t = addClip(emptyTimeline(), clipOf(loud, 4 * S, 1 * S));
    await exportTimeline(t, { path, resolution: 720, fps: 30, codec: 'avc', quality: 'high', framing: '9:16', bitrate: 6e6, loudness: -14 }, () => {}, new AbortController().signal);
    const e = await getMedia(path);
    const snd = clipSound(e);
    let lufs = NaN;
    if (snd) {
      const chans: Float32Array[] = [[], []].map(() => new Float32Array(0));
      const parts: Float32Array[][] = [[], []];
      for (let b = 0; b * snd.blockS < snd.seconds; b++) {
        const buf = await snd.fetch(b);
        if (!buf) continue;
        const own = Math.min(buf.length, Math.round(snd.blockS * buf.sampleRate));
        for (let k = 0; k < 2; k++) parts[k]!.push(buf.getChannelData(Math.min(k, buf.numberOfChannels - 1)).slice(0, own));
        if (snd.blockS === Infinity) break;
      }
      for (let k = 0; k < 2; k++) { const n = parts[k]!.reduce((a, p) => a + p.length, 0); chans[k] = new Float32Array(n); let o = 0; for (const p of parts[k]!) { chans[k]!.set(p, o); o += p.length; } }
      lufs = measureLufs(chans, 48000);
    }
    ok('a 9:16 preset exports vertical video', e.width === 720 && e.height === 1280, [e.width, e.height]);
    ok('and brings the sound to −14 LUFS (or as close as it may)', Math.abs(lufs - want) < 1.5, { got: +lufs.toFixed(2), want: +want.toFixed(2) });
  }

  // --- Exporting in another shape: each clip reframed for it

  out.step = 'Exporting in another shape: each clip reframed for it';
  {
    const panoPath = fix('GS010115.360') ?? fix('GS010004.360');
    const pano = panoPath ? await getMedia(panoPath) : null;
    let t = addClip(emptyTimeline(), { ...clipOf(ride, 4 * S, 1 * S), fit: 'fit' as const });
    if (pano) {
      const c = clipOf(pano, 4 * S, 2 * S);
      t = addClip(t, { ...c, look: { ...c.look, yaw: 30, fov: 110 }, keyframes: [{ id: 'kp', t: c.inUs + S, easing: 'smooth' as const, look: { ...c.look, yaw: 40, fov: 90 } }] });
    }
    const r = await reframeForExport(t, '9:16', () => {}, new AbortController().signal);
    const flat = r.clips[0]!;
    ok('the edit is exported in the new shape, the edit itself is untouched', r.framing === '9:16' && t.framing === '16:9' && t.clips[0]!.fit === 'fit');
    ok('a regular clip fills the tall frame and pans with the action', flat.fit === 'fill' && (flat.keyframes.length > 0 || !!flat.look.pan), { fit: flat.fit, keys: flat.keyframes.length, pan: flat.look.pan });
    if (pano) {
      const p = r.clips[1]!, want = fovForAspect({ fov: 110, fisheye: t.clips[1]!.look.fisheye }, 16 / 9, 9 / 16);
      ok('a 360 view keeps its direction and zoom instead of squeezing the wide view in', Math.abs(p.look.fov - want) < 0.01 && p.look.fov < 85 && p.look.yaw === 30 && p.keyframes[0]!.look.fov < 75 && p.keyframes[0]!.look.yaw === 40, { fov: +p.look.fov.toFixed(1), key: +p.keyframes[0]!.look.fov.toFixed(1) });
      const back = await reframeForExport({ ...r, framing: '9:16' }, '16:9', () => {}, new AbortController().signal);
      ok('and turns back into the same view the other way round', Math.abs(back.clips[1]!.look.fov - 110) < 0.01, +back.clips[1]!.look.fov.toFixed(2));
    } else out['360 reframe'] = 'skipped (no 360 clip)';
  }
}

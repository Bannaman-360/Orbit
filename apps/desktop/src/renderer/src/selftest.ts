// Automated end-to-end check: `pnpm selftest`.
// Builds a multi-clip edit from fixtures/ (plus a synthetic 360 clip and a test tone),
// captures the editor, measures playback across cuts, checks stabilisation, exports
// a video and decodes it back. Output: selftest-out/report.json + PNGs.

import { openMedia, TrackDecoder } from '@ace/engine';
import { frameShare, ReframeRenderer } from '@ace/media360';
import {
  fitSubjectFrac, trackRange,
  addClip, DEFAULT_LOOK, detachAudio, emptyTimeline, newGaugeOverlay, newTextOverlay, TEXT_PRESETS, updateClip, gradeFromPreset, newAudioClip, newClip, setKeyframe, timelineDuration,
  type Look, type Timeline, type TimelineClip,
  NO_EFFECTS,
} from '@ace/project';
import { fitCoriMapping, TelemetrySeries } from '@ace/telemetry';
import { mulMat, mulVec, transpose } from '@ace/media360';
import { ace, ipcReader } from './api';
import { calibrateMedia, framesAt } from './calib';
import { exportTimeline, grabFrame } from './exporter';
import { clipLookAt, clipViewToWorld, presentLook, pushClipFrame, WORLD_STABILIZE, worldToClipView } from './frameRender';
import { getMedia, loadMusic, mediaNow, type Media } from './media';
import { generateSynthetic360, generateTone } from './synth';
import { directionAt, TRACKER, trackSubject } from './tracker';
import { flatCheck, flatProbe, realSteady, realPlay, realLooks, lensDump, stabCheck } from './selftestFlat';
import { lensCheck, lensLookCheck } from './selftestLens';
import { stripCheck } from './selftestStrip';
import { airtimeCheck, gaugesCheck } from './selftestGauges';
import { beta8Check } from './selftestBeta8';
import { dropCheck } from './selftestDrop';
import { tenbitExport, tenbitProbe } from './selftestTenbit';
import { tourCheck } from './selftestTour';
import { reportCheck } from './selftestReport';
import { compatCheck } from './selftestCompat';
import { projectsCheck } from './selftestProjects';
import { oddCheck } from './selftestOdd';
import { longCheck } from './selftestLong';
import { markersCheck } from './selftestMarkers';
import { snapCheck } from './selftestSnap';
import { proTrimCheck } from './selftestProTrim';
import { poolCheck } from './selftestPool';
import { scrubBackCheck } from './selftestScrub';
import { exportCheck, exportTag } from './selftestExport';
import { seamCheck, seamFit, seamLook, seamMeasure } from './selftestSeam';
import { colorCheck, colorFacts, colorProbe, colorRoutes } from './selftestColor';
import { speedCheck } from './selftestSpeed';
import { cardCheck, cardQuit } from './selftestCard';
import { chapterCheck } from './selftestChapters';
import { equirectCheck, equirectMotion } from './selftestEquirect';
import { followCheck, realFollow } from './selftestFollow';
import { uiCheck } from './selftestUi';
import { layersCheck } from './selftestLayers';
import { aiCheck } from './selftestAi';
import { spectrumCheck } from './selftestSpectrum';
import { highlightsCheck } from './selftestHighlights';
import { regularCheck } from './selftestRegular';
import { masksCheck } from './selftestMasks';
import { motionCheck } from './selftestMotion';
import { finishCheck } from './selftestFinish';
import { group } from './ui/dockModel';
import { defaultPrefs, setPrefs } from './ui/prefs';
import { DEFAULT_THEME } from './ui/theme';
import { previewSource, proxiesIdle, proxyErrors, setPreviewLevel } from './proxy';
import type { TickResult, TimelinePlayer } from './timelinePlayer';

export interface EditorApi {
  importPaths(paths: string[]): Promise<unknown>;
  getTimeline(): Timeline;
  setTimeline(t: Timeline): void;
  player: TimelinePlayer;
  setShowRaw(v: boolean): void;
  nextRender(): Promise<void>;
  lastResult(): TickResult | null;
  versions: Record<string, string>;
  mode?: string;
  /** Runs an app command, like a menu choice. */
  run?: (cmd: string) => void;
  /** Track the subject inside this box (preview pixels), as if dragged in "Track subject". */
  trackBox?: (box: { x0: number; y0: number; x1: number; y1: number }) => Promise<void>;
  /** As if these files were dragged in from the desktop (onto the timeline at `at`). */
  dropPaths?: (paths: string[], at?: number) => Promise<void>;
  /** The project as it would be saved, and opening one. */
  saveText?: () => string;
  restore?: (text: string) => Promise<void>;
  /** Find missing files in this folder (no dialog). */
  relink?: (folder: string) => Promise<void>;
  /** Makes drawing the editor fail (checks the recovery screen). */
  crashForTest?: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const S = 1_000_000;

async function settle(api: EditorApi, renders = 4, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  for (let i = 0; i < renders; i++) await Promise.race([api.nextRender(), sleep(Math.max(0, deadline - performance.now()))]);
  await sleep(150);
}

async function capture(api: EditorApi, name: string, T?: number) {
  if (T !== undefined) api.player.seek(T);
  await settle(api);
  await ace.capture(name);
}

/** Mean absolute difference between consecutive low-res renders: lower = steadier picture. */
async function shakeScore(media: Media, clip: TimelineClip, startUs: number, frames = 40): Promise<number> {
  const W = 192, H = 108;
  const canvas = new OffscreenCanvas(W, H);
  const r = await ReframeRenderer.create(canvas);
  r.setLayout(media.layout);
  const decs = media.tracks.map((t) => new TrackDecoder(media.reader, t));
  decs.forEach((d) => d.seek(startUs));
  const times = media.tracks[0]!.samples.map((s) => s.timestamp).filter((t) => t >= startUs).sort((a, b) => a - b).slice(0, frames);
  const read = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
  let prev: Uint8ClampedArray | null = null;
  let total = 0, n = 0;
  try {
    for (const t of times) {
      let fr: (VideoFrame | null)[] = [];
      for (let i = 0; i < 3000; i++) {
        decs.forEach((d) => void d.pump());
        fr = decs.map((d) => d.frameAt(t));
        if (fr.every(Boolean)) break;
        await sleep(2);
      }
      r.resetHistory();
      const look = pushClipFrame(r, clip, media, t, fr as VideoFrame[]);
      presentLook(r, { ...look, motionBlur: 0 });
      await r.idle();
      const bmp = await createImageBitmap(canvas);
      read.drawImage(bmp, 0, 0);
      bmp.close();
      const px = read.getImageData(0, 0, W, H).data;
      if (prev) {
        let d = 0;
        // Upper half only: distant scenery, so differences come from rotation (shake), not riding forward.
        const lim = (W * H * 4) / 2;
        for (let i = 0; i < lim; i += 4) d += Math.abs(px[i]! - prev[i]!) + Math.abs(px[i + 1]! - prev[i + 1]!);
        total += d / (W * (H / 2) * 2);
        n++;
      }
      prev = new Uint8ClampedArray(px);
    }
  } finally {
    decs.forEach((d) => d.close());
    r.destroy();
  }
  return +(total / Math.max(1, n)).toFixed(2);
}

async function measurePlayback(api: EditorApi, fromUs: number, seconds: number) {
  const p = api.player;
  p.seek(fromUs);
  await settle(api);
  const stalls0 = p.stalls;
  let renders = 0;
  let counting = true;
  void (async () => { while (counting) { await api.nextRender(); renders++; } })();
  const m0 = await ace.selftestMetrics();
  const t0 = performance.now();
  p.play();
  await sleep(seconds * 1000);
  p.pause();
  counting = false;
  const m1 = await ace.selftestMetrics();
  const wall = (performance.now() - t0) / 1000;
  return { from: fromUs / S, wallSeconds: +wall.toFixed(2), advanced: +((p.time - fromUs) / S).toFixed(2), renderFps: +(renders / wall).toFixed(1), stalls: p.stalls - stalls0, msPerSecond: Object.fromEntries(['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration'].map((k) => [k.replace('Duration', ''), Math.round(((m1[k]! - m0[k]!) * 1000) / wall)])), nodes: m1.Nodes, frame: `${(document.querySelector('.frame') as HTMLElement).clientWidth}` };
}

const look = (o: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...o });

/**
 * Diagnostics for stabilisation sync: dumps the centre of the front camera face as small
 * greyscale frames (plus timestamps) so image motion can be compared with the motion data.
 */
async function dumpSyncFrames(media: Media, seconds: number) {
  const N = 256;
  const tile = media.layout!.tiles.find((t) => t.face === 'front')!;
  const track = media.tracks[tile.stream]!;
  const times = track.samples.map((s) => s.timestamp).sort((a, b) => a - b).filter((t) => t < seconds * S);
  const dec = new TrackDecoder(media.reader, track);
  dec.seek(times[0]!);
  const c = new OffscreenCanvas(N, N);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const out = new Uint8Array(times.length * N * N);
  // Middle half of the front face (avoids lens overlap strips).
  const fs = tile.size;
  const sx = tile.x + fs / 4, sy = tile.y + fs / 4, sw = fs / 2;
  try {
    for (let k = 0; k < times.length; k++) {
      const t = times[k]!;
      let fr: VideoFrame | null = null;
      for (let i = 0; i < 5000 && !fr; i++) {
        void dec.pump();
        fr = dec.frameAt(t);
        if (!fr) await sleep(2);
      }
      if (!fr) throw new Error(`frame ${t} timed out`);
      ctx.drawImage(fr, sx, sy, sw, sw, 0, 0, N, N);
      const px = ctx.getImageData(0, 0, N, N).data;
      for (let i = 0; i < N * N; i++) out[k * N * N + i] = (px[i * 4]! * 2 + px[i * 4 + 1]! * 5 + px[i * 4 + 2]!) >> 3;
    }
  } finally {
    dec.close();
  }
  await ace.writeFile(await ace.selftestOut('sync-frames.bin'), out);
  return { n: times.length, size: N, times, tile, crop: { sx, sy, sw } };
}

/** Tracks the sun with stabilisation off and compares against where it must be (from the motion data). */
async function trackCheck(media: Media, target: 'sun' | 'shore') {
  const base = newClip(media.path, media.durationUs, true);
  const ax: [string, string, string] = ['x', '-y', 'z'];
  const t0 = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).find((t) => t >= 0.5 * S)!;
  // 1. Find the sun in a world-locked, level view: brightest blob.
  const W = 320, H = 180;
  const canvas = new OffscreenCanvas(W, H);
  const r = await ReframeRenderer.create(canvas);
  r.setLayout(media.layout);
  const worldLook = look({ yaw: 0, pitch: 0, fov: 90 });
  const { frames, close } = await framesAt(media, t0);
  const levelClip = { ...base, look: worldLook, stabilize: { smoothing: 'locked' as const, horizon: true } };
  pushClipFrame(r, levelClip, media, t0, frames);
  presentLook(r, { ...worldLook, motionBlur: 0 });
  close();
  const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
  const bmp = await createImageBitmap(canvas);
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < W * H; i++) if (px[i * 4]! + px[i * 4 + 1]! + px[i * 4 + 2]! > 745) { sx += i % W; sy += Math.floor(i / W); n++; }
  r.destroy();
  if (!n) return { error: 'sun not found' };
  const sunLevel = directionAt(worldLook, W / H, (sx / n / W) * 2 - 1, 1 - (sy / n / H) * 2)!;
  // Level view → world-steady frame.
  const sunDir = clipViewToWorld(media, levelClip, t0, sunLevel.yaw, sunLevel.pitch);
  // The far shore just left of the sun, on the horizon (textured and far away).
  const sun = target === 'sun' ? sunDir : clipViewToWorld(media, levelClip, t0, sunLevel.yaw - 14, 1);
  const RADS = Math.PI / 180;
  const w: [number, number, number] = [Math.cos(sun.pitch * RADS) * Math.sin(sun.yaw * RADS), Math.sin(sun.pitch * RADS), Math.cos(sun.pitch * RADS) * Math.cos(sun.yaw * RADS)];
  // Where the sun is in the camera's own frame at time t (stabilisation off = camera frame).
  const truth = (t: number) => {
    // Same world-steady frame as the tracker.
    const C = media.stabilizer.correctionAt(t, { ...WORLD_STABILIZE, axisMap: ax });
    const d = mulVec(transpose(C), w);
    return { yaw: Math.atan2(d[0], d[2]) / RADS, pitch: Math.asin(d[1]) / RADS };
  };
  // 2. Track it with stabilisation off, from 0.5 s to 8.5 s.
  const clip = { ...base, outUs: 12.5 * S, stabilize: { smoothing: 'off' as const, horizon: false } };
  const start = truth(t0);
  const t1 = performance.now();
  const patches: Float64Array[] = [];
  const out = await trackSubject({ clip, media, startUs: t0, yaw: start.yaw, pitch: start.pitch, sizeDeg: target === 'sun' ? 12 : 10 }, () => {}, new AbortController().signal, patches);
  // Contact sheet of what the tracker saw (every 4th step), 64 px tiles, 12 per row.
  {
    const picks = patches.filter((_, i) => i % 4 === 0);
    const cols = 12, rows = Math.ceil(picks.length / cols);
    const sheet = new OffscreenCanvas(cols * 64, Math.max(1, rows) * 64);
    const sc = sheet.getContext('2d')!;
    picks.forEach((p, k) => {
      const img = sc.createImageData(64, 64);
      for (let i = 0; i < 64 * 64; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = p[i]!; img.data[i * 4 + 3] = 255; }
      sc.putImageData(img, (k % cols) * 64, Math.floor(k / cols) * 64);
    });
    await ace.writeFile(await ace.selftestOut(`track-${target}.png`), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  const ms = performance.now() - t1;
  // Convert the world-frame path into the clip's view (stabilisation off) and compare.
  const viewPts = out.points.map((p) => ({ t: p.t, ...worldToClipView(media, clip, p.t, p.yaw, p.pitch) }));
  const errs = viewPts.map((p) => {
    const q = truth(p.t);
    const dy = ((p.yaw - q.yaw + 540) % 360) - 180;
    return Math.hypot(dy * Math.cos(q.pitch * RADS), p.pitch - q.pitch);
  });
  const sorted = [...errs].sort((a, b) => a - b);
  const swing = out.points.map((p) => truth(p.t).yaw);
  return {
    sunAt: { yaw: +sun.yaw.toFixed(1), pitch: +sun.pitch.toFixed(1), pixels: n },
    trackedSeconds: +(((out.points.at(-1)?.t ?? t0) - t0) / S).toFixed(2),
    steps: out.points.length,
    lostAt: out.lostAt ? +(out.lostAt / S).toFixed(2) : null,
    errorDeg: { median: +sorted[Math.floor(sorted.length / 2)]!.toFixed(2), p95: +sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2), max: +sorted.at(-1)!.toFixed(2) },
    sunSwingYawDeg: +(Math.max(...swing) - Math.min(...swing)).toFixed(1),
    speed: `${(((out.points.at(-1)?.t ?? t0) - t0) / 1e3 / ms).toFixed(2)}× realtime`,
    confidence: out.confidence?.filter((_, i) => i % 5 === 0).join(' '),
    errTrace: errs.filter((_, i) => i % 10 === 0).map((e) => +e.toFixed(1)).join(' '),
  };
}

/** Scrubbing: single jumps and a simulated drag across the timeline. */
const progressLog: string[] = [];
async function logStep(msg: string) {
  progressLog.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  await ace.writeFile(await ace.selftestOut('progress.txt'), progressLog.join('\n'));
}

async function scrubCheck(api: EditorApi, media: Media) {
  const tl = addClip(emptyTimeline(), newClip(media.path, media.durationUs, media.is360));
  api.setTimeline(tl);
  await settle(api, 6);
  const src = previewSource(media);
  const samples = src.tracks[0]!.samples;
  const keys = samples.filter((x) => x.isSync).map((x) => x.timestamp).sort((a, b) => a - b);
  const gop = keys.length > 1 ? (keys[keys.length - 1]! - keys[0]!) / (keys.length - 1) / 1e6 : null;
  const frameUs = 1e6 / media.fps;
  const shownAt = () => api.lastResult()?.layers?.[0]?.frames[0]?.timestamp ?? -1;
  /** Waits until the shown frame is the one for media time T. */
  const waitFor = async (T: number, timeout = 5000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      await Promise.race([api.nextRender(), sleep(100)]);
      const ts = shownAt();
      if (ts >= 0 && Math.abs(ts - T) <= frameUs) return performance.now() - t0;
    }
    return NaN;
  };
  await logStep(`scrub: start (source level ${src.level})`);
  // 1. Single jumps to random places (paused).
  const jumps: number[] = [];
  const firsts: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 8; i++) {
    const T = (1 + rnd() * (media.durationUs / S - 2)) * S;
    const before = shownAt();
    const t0 = performance.now();
    api.player.seek(T);
    // First picture near the target (nearest keyframe or later), then the exact frame.
    for (;;) {
      await Promise.race([api.nextRender(), sleep(100)]);
      const ts = shownAt();
      if ((ts !== before && ts <= T + frameUs && ts >= T - 1.2 * S) || performance.now() - t0 > 5000) break;
    }
    await logStep(`jump ${i} to ${(T / S).toFixed(2)}: shown ${(shownAt() / S).toFixed(2)} after ${Math.round(performance.now() - t0)} ms; ${JSON.stringify(api.player.debug?.())}`);
    firsts.push(performance.now() - t0);
    const rest = await waitFor(T);
    jumps.push(performance.now() - t0 - 0 * rest);
  }
  await logStep('scrub: jumps done');
  // 2. A drag: 2 s of pointer moves (every 16 ms) from 2 s to 12 s on the timeline.
  const shown = new Set<number>();
  const lags: number[] = [];
  let dragging = true;
  void (async () => {
    while (dragging) {
      await Promise.race([api.nextRender(), sleep(100)]);
      const ts = shownAt();
      if (ts >= 0) { shown.add(ts); lags.push(Math.abs(api.player.time - ts) / 1e6); }
    }
  })();
  const d0 = performance.now();
  for (;;) {
    const f = (performance.now() - d0) / 2000;
    if (f >= 1) break;
    api.player.seek((2 + 10 * f) * S);
    await sleep(16);
  }
  const endT = 12 * S;
  api.player.seek(endT);
  const settleMs = await waitFor(endT);
  dragging = false;
  await logStep('scrub: forward drag done');
  // 3. Backward drag 12 s → 2 s: count times the picture moves forward (the "pull").
  const back = { shown: new Set<number>(), forwardSteps: 0, forwardSeconds: 0 };
  let prevTs = shownAt();
  dragging = true;
  void (async () => {
    while (dragging) {
      await Promise.race([api.nextRender(), sleep(100)]);
      const ts = shownAt();
      if (ts >= 0) {
        back.shown.add(ts);
        if (prevTs >= 0 && ts > prevTs + 1000) { back.forwardSteps++; back.forwardSeconds += (ts - prevTs) / 1e6; }
        prevTs = ts;
      }
    }
  })();
  const b0 = performance.now();
  for (;;) {
    const f = (performance.now() - b0) / 2000;
    if (f >= 1) break;
    api.player.seek((12 - 10 * f) * S);
    await sleep(16);
  }
  dragging = false;
  await sleep(50);
  const backEnd = 2 * S;
  api.player.seek(backEnd);
  const backSettle = await waitFor(backEnd);
  const sortedLag = [...lags].sort((a, b) => a - b);
  const med = (a: number[]) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? +b[Math.floor(b.length / 2)]!.toFixed(0) : null; };
  await logStep('scrub: backward drag done');
  // Playback smoothness at this level.
  const pb = await measurePlayback(api, 2 * S, 3);
  return {
    source: src.level === 1 ? 'original' : `proxy 1/${src.level} (${src.tracks[0]!.width}x${src.tracks[0]!.height})`,
    shownLevel: api.lastResult()?.layers?.[0]?.level,
    playback: pb,
    keyframeEverySeconds: gop && +gop.toFixed(2),
    jumpFirstPictureMs: med(firsts),
    jumpMs: { median: med(jumps), max: Math.round(Math.max(...jumps.filter(Number.isFinite))), failed: jumps.filter((j) => !Number.isFinite(j)).length },
    drag: {
      distinctFramesShown: shown.size,
      medianLagSeconds: sortedLag.length ? +sortedLag[Math.floor(sortedLag.length / 2)]!.toFixed(2) : null,
      exactFrameAfterReleaseMs: Number.isFinite(settleMs) ? Math.round(settleMs) : 'never',
    },
    backwardDrag: {
      distinctFramesShown: back.shown.size,
      forwardSteps: back.forwardSteps,
      forwardSecondsTotal: +back.forwardSeconds.toFixed(2),
      exactFrameAfterReleaseMs: Number.isFinite(backSettle) ? Math.round(backSettle) : 'never',
    },
  };
}

/**
 * Moving-subject tracking test with a known answer: the rider's own helmet. It is rigid with
 * the camera, so its direction in the camera frame never changes, and its true position in
 * the world-steady frame (where the tracker works) follows from the motion data.
 */
async function helmetCheck(media: Media, opts: { yaw: number; pitch: number; size: number; seconds: number; tag: string }) {
  const base = newClip(media.path, media.durationUs, true);
  const levelClip = { ...base, stabilize: { smoothing: 'locked' as const, horizon: true } };
  const offClip = { ...base, stabilize: { smoothing: 'off' as const, horizon: false } };
  const t0 = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).find((t) => t >= 1 * S)!;
  const w0 = clipViewToWorld(media, levelClip, t0, opts.yaw, opts.pitch);
  const dImg0 = worldToClipView(media, offClip, t0, w0.yaw, w0.pitch);
  // The picture is the camera body's view turned by the camera's own image rotation (IORI,
  // about the lens axis). Something fixed to the body therefore turns with IORI in the picture.
  const iori = media.stabilizer.data?.iori ?? [];
  const ioriAngle = (t: number) => {
    if (!iori.length) return 0;
    let k = iori.findIndex((x) => x.t >= t);
    if (k < 0) k = iori.length - 1;
    const q = iori[k]!.q;
    return 2 * Math.atan2(q[3], q[0]);
  };
  const RADS0 = Math.PI / 180;
  const toV = (y: number, p: number): [number, number, number] => [Math.cos(p * RADS0) * Math.sin(y * RADS0), Math.sin(p * RADS0), Math.cos(p * RADS0) * Math.cos(y * RADS0)];
  const toA = (d: number[]) => ({ yaw: Math.atan2(d[0]!, d[2]!) / RADS0, pitch: Math.asin(Math.max(-1, Math.min(1, d[1]!))) / RADS0 });
  const rotZ = (d: number[], a: number) => [d[0]! * Math.cos(a) - d[1]! * Math.sin(a), d[0]! * Math.sin(a) + d[1]! * Math.cos(a), d[2]!];
  const truthFor = (sign: number) => {
    const body = rotZ(toV(dImg0.yaw, dImg0.pitch), -sign * ioriAngle(t0));
    return (t: number) => {
      const img = toA(rotZ(body, sign * ioriAngle(t)));
      return clipViewToWorld(media, offClip, t, img.yaw, img.pitch);
    };
  };
  let truth = truthFor(1);
  // Snapshot of the starting view with the box, for checking the target by eye.
  {
    const W = 480, H = 270;
    const c = new OffscreenCanvas(W, H);
    const r = await ReframeRenderer.create(c);
    r.setLayout(media.layout);
    const { frames, close } = await framesAt(media, t0);
    const lk = look({ yaw: opts.yaw, pitch: opts.pitch, fov: 100 });
    pushClipFrame(r, { ...levelClip, look: lk }, media, t0, frames);
    presentLook(r, { ...lk, motionBlur: 0 });
    close();
    const bmp = await createImageBitmap(c);
    const out = new OffscreenCanvas(W, H);
    const ctx = out.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const half = (Math.tan((opts.size / 2) * Math.PI / 180) / Math.tan(50 * Math.PI / 180)) * (W / 2);
    ctx.strokeStyle = '#35e0ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(W / 2 - half, H / 2 - half, half * 2, half * 2);
    r.destroy();
    await ace.writeFile(await ace.selftestOut(`track-${opts.tag}-start.png`), new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  const clip = { ...levelClip, outUs: (1 + opts.seconds) * S };
  const patches: Float64Array[] = [];
  const tA = performance.now();
  const out = await trackSubject({ clip, media, startUs: t0, yaw: opts.yaw, pitch: opts.pitch, sizeDeg: opts.size }, () => {}, new AbortController().signal, patches);
  const ms = performance.now() - tA;
  const RADS = Math.PI / 180;
  const ang = (a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }) => {
    const da = [Math.cos(a.pitch * RADS) * Math.sin(a.yaw * RADS), Math.sin(a.pitch * RADS), Math.cos(a.pitch * RADS) * Math.cos(a.yaw * RADS)];
    const db = [Math.cos(b.pitch * RADS) * Math.sin(b.yaw * RADS), Math.sin(b.pitch * RADS), Math.cos(b.pitch * RADS) * Math.cos(b.yaw * RADS)];
    return Math.acos(Math.max(-1, Math.min(1, da[0]! * db[0]! + da[1]! * db[1]! + da[2]! * db[2]!))) / RADS;
  };
  // Pick the IORI direction that matches (the convention isn't documented); report both.
  const errFor = (tr: (t: number) => { yaw: number; pitch: number }) => out.points.map((p) => ang(p, tr(p.t)));
  const eP = errFor(truthFor(1)), eM = errFor(truthFor(-1)), e0 = errFor(truthFor(0));
  const medOf = (e: number[]) => [...e].sort((a, b) => a - b)[Math.floor(e.length / 2)] ?? NaN;
  const best = [[1, medOf(eP)], [-1, medOf(eM)], [0, medOf(e0)]].sort((a, b) => a[1]! - b[1]!)[0]!;
  truth = truthFor(best[0]!);
  const errs = errFor(truth);
  const moved = out.points.map((p) => ang(truth(p.t), truth(t0)));
  const sorted = [...errs].sort((a, b) => a - b);
  // Contact sheet of what the tracker saw.
  {
    const picks = patches.filter((_, i) => i % 6 === 0).slice(0, 48);
    const cols = 12, P = Math.round(Math.sqrt(patches[0]?.length ?? 4096));
    const sheet = new OffscreenCanvas(cols * P, Math.max(1, Math.ceil(picks.length / cols)) * P);
    const sc = sheet.getContext('2d')!;
    picks.forEach((p, k) => {
      const img = sc.createImageData(P, P);
      for (let i = 0; i < P * P; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = p[i]!; img.data[i * 4 + 3] = 255; }
      sc.putImageData(img, (k % cols) * P, Math.floor(k / cols) * P);
    });
    await ace.writeFile(await ace.selftestOut(`track-${opts.tag}.png`), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  const within = (deg: number) => {
    const firstBad = errs.findIndex((e) => e > deg);
    const pts = firstBad < 0 ? out.points : out.points.slice(0, firstBad);
    return +(((pts.at(-1)?.t ?? t0) - t0) / S).toFixed(2);
  };
  return {
    probe: `${out.motionFocus?.toFixed(2)} (${out.probe?.map((v) => v.toFixed(1)).join('/')})`,
    trackedSeconds: +(((out.points.at(-1)?.t ?? t0) - t0) / S).toFixed(2),
    lostAt: out.lostAt ? +(out.lostAt / S).toFixed(2) : null,
    secondsWithin5deg: within(5),
    secondsWithin10deg: within(10),
    errorDeg: { median: +(sorted[Math.floor(sorted.length / 2)] ?? NaN).toFixed(2), p90: +(sorted[Math.floor(sorted.length * 0.9)] ?? NaN).toFixed(2), max: +(sorted.at(-1) ?? NaN).toFixed(2) },
    subjectMovedDeg: +Math.max(...moved).toFixed(1),
    ioriSign: best[0], medianBySign: { plus: +medOf(eP).toFixed(2), minus: +medOf(eM).toFixed(2), none: +medOf(e0).toFixed(2) },
    speed: `${(((out.points.at(-1)?.t ?? t0) - t0) / 1e3 / ms).toFixed(2)}× realtime`,
    errTrace: errs.filter((_, i) => i % 15 === 0).map((e) => +e.toFixed(1)).join(' '),
  };
}

/**
 * The case that failed for the user: following a rider in GS010120.360 from 7.38 s. Renders
 * the tracked view every 0.5 s into a contact sheet so the result can be checked by eye.
 */
/** Rider's true position in GS010120.360, labelled by eye: time s, world yaw°, pitch°, height°. */
export const RIDER_TRUTH: [number, number, number, number][] = [
  [4.42, 5.0, 9.1, 5],
  [4.67, 5.4, 8.4, 5],
  [4.92, 6.2, 6.2, 6],
  [5.17, 6.4, 4.1, 6.5],
  [5.42, 7.0, 0.7, 8],
  [5.67, 8.8, -1.8, 9],
  [5.92, 11.7, -3.0, 11],
  [6.17, 16.2, -2.9, 14],
  [6.42, 24.0, -3.2, 18],
  [6.67, 36.3, -1.7, 21],
  [7.17, 79.1, -7.1, 35],
  [7.42, 106.5, -10.9, 26],
  [7.67, 128.5, -15.3, 18],
  [7.92, 144.0, -17.4, 14],
  [8.17, 155.4, -15.7, 14],
  [8.43, 163.8, -13.2, 10],
  [8.93, 171.8, -11.3, 7.5],
  [9.43, 175.8, -10.2, 5.5],
  [9.93, 177.9, -7.3, 3.5],
  [10.43, 179.1, -3.6, 3],
  [10.93, 179.6, -4.9, 3],
];
export const riderTruthAt = (ts: number) => {
  const k = RIDER_TRUTH.findIndex((p) => p[0] >= ts);
  if (k <= 0) return k === 0 ? RIDER_TRUTH[0]! : RIDER_TRUTH.at(-1)!;
  const a = RIDER_TRUTH[k - 1]!, b = RIDER_TRUTH[k]!, f = (ts - a[0]) / (b[0] - a[0]);
  return a.map((v, i) => v + (b[i]! - v) * f) as [number, number, number, number];
};
/** Angle from the true rider position at each label time inside the track. */
function riderScore(points: { t: number; yaw: number; pitch: number; size?: number }[], fromS: number) {
  const R = Math.PI / 180;
  const errs: string[] = [];
  let ok = 0, n = 0;
  for (const [ts, y, p, h] of RIDER_TRUTH) {
    if (ts < fromS + 0.2) continue;
    n++;
    const q = points.find((x) => x.t >= ts * S - 1);
    if (!q) { errs.push(`${ts}:lost`); continue; }
    const c = Math.sin(y * 0 + p * R) * Math.sin(q.pitch * R) + Math.cos(p * R) * Math.cos(q.pitch * R) * Math.cos((q.yaw - y) * R);
    const e = Math.acos(Math.max(-1, Math.min(1, c))) / R;
    if (e < Math.max(2.5, h * 0.6)) ok++;
    errs.push(`${ts}:${e.toFixed(0)}(${h.toFixed(0)},${(q.size ?? 0).toFixed(0)})`);
  }
  return { onRider: `${ok}/${n}`, errs: errs.join(' ') };
}

async function riderCheck(media: Media, tag: string, sizeDeg: number, startS: number, off: [number, number] = [0, 0]) {
  const tr = riderTruthAt(startS);
  const from = { t: startS, yaw: tr[1] + off[0] * sizeDeg, pitch: tr[2] + off[1] * sizeDeg };
  const base = newClip(media.path, media.durationUs, true);
  const clip = { ...base, stabilize: { smoothing: 'medium' as const, horizon: true } };
  const t0 = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).find((t) => t >= from.t * S)!;
  // Where the rider was at the start (world frame, from the user's own tracking).
  const start = worldToClipView(media, clip, t0, from.yaw, from.pitch);
  const tA = performance.now();
  const patches: Float64Array[] = [];
  const out = await trackSubject({ clip, media, startUs: t0, yaw: start.yaw, pitch: start.pitch, sizeDeg }, () => {}, new AbortController().signal, patches);
  const ms = performance.now() - tA;
  {
    const picks = patches.slice(0, 24);
    const P = Math.round(Math.sqrt(patches[0]?.length ?? 4096)), cols = 12;
    const sh = new OffscreenCanvas(cols * P, 2 * P);
    const c2 = sh.getContext('2d')!;
    picks.forEach((p, k) => {
      const img = c2.createImageData(P, P);
      for (let i = 0; i < P * P; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = p[i]!; img.data[i * 4 + 3] = 255; }
      c2.putImageData(img, (k % cols) * P, Math.floor(k / cols) * P);
    });
    await ace.writeFile(await ace.selftestOut(`rider-${tag}-patches.png`), new Uint8Array(await (await sh.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  const tracked: TimelineClip = { ...clip, look: look({ fov: 75 }), track: { space: 'world', points: out.points, smoothing: 0.25, offsetYaw: 0, offsetPitch: 0, autoZoom: 1 } };
  tracked.track!.subjectFrac = fitSubjectFrac(tracked.track!, sizeDeg / 75, 0, frameShare);
  // Contact sheet of the tracked view.
  const W = 240, H = 135;
  const times = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).filter((t) => t >= t0 && (t - t0) % 500_000 < 1e6 / media.fps && t <= (out.points.at(-1)?.t ?? t0) + 1);
  const cols = 6;
  const sheet = new OffscreenCanvas(cols * W, Math.ceil(times.length / cols) * H);
  const sc = sheet.getContext('2d')!;
  const c = new OffscreenCanvas(W, H);
  const r = await ReframeRenderer.create(c);
  r.setLayout(media.layout);
  for (const [k, t] of times.entries()) {
    const { frames, close } = await framesAt(media, t);
    const lk = pushClipFrame(r, tracked, media, t, frames);
    presentLook(r, { ...lk, motionBlur: 0 });
    close();
    const bmp = await createImageBitmap(c);
    sc.drawImage(bmp, (k % cols) * W, Math.floor(k / cols) * H);
    sc.fillStyle = '#fff';
    sc.font = '12px sans-serif';
    sc.fillText(`${(t / S).toFixed(1)}s`, (k % cols) * W + 4, Math.floor(k / cols) * H + 14);
    // Centre mark.
    sc.strokeStyle = '#35e0ff';
    sc.strokeRect((k % cols) * W + W / 2 - 3, Math.floor(k / cols) * H + H / 2 - 3, 6, 6);
  }
  r.destroy();
  await ace.writeFile(await ace.selftestOut(`rider-${tag}.png`), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  const yaws = out.points.map((p) => p.yaw);
  return {
    score: riderScore(out.points, startS),
    probe: `${out.motionFocus?.toFixed(2)} (${out.probe?.map((v) => v.toFixed(1)).join('/')})`,
    trackedSeconds: +(((out.points.at(-1)?.t ?? t0) - t0) / S).toFixed(2),
    lostAt: out.lostAt ? +(out.lostAt / S).toFixed(2) : null,
    pathYawRange: +(Math.max(...yaws) - Math.min(...yaws)).toFixed(1),
    yawEvery05s: out.points.filter((_, i) => i % 12 === 0).map((p) => `${(p.t / S).toFixed(1)}:${p.yaw.toFixed(0)}/${p.pitch.toFixed(0)}`).join(' '),
    wide: out.wide,
    blobs: out.blobs?.join(' '),
    psr: out.confidence?.join(' '),
    sizeEvery05s: out.points.filter((_, i) => i % 12 === 0).map((p) => `${(p.t / S).toFixed(1)}:${(p.size ?? 0).toFixed(0)}°`).join(' '),
    zoomFovEvery05s: out.points.filter((_, i) => i % 12 === 0).map((p) => `${clipLookAt(tracked, p.t).fov.toFixed(0)}°`).join(' '),
    speed: `${(((out.points.at(-1)?.t ?? t0) - t0) / 1e3 / ms).toFixed(2)}× realtime`,
  };
}

/** Contact sheet of world-steady views with a degree grid, for labelling the rider by eye. */
async function labelSheet(media: Media, name: string, aims: [number, number, number][], fov: number) {
  const W = 360, cols = 4;
  const base = newClip(media.path, media.durationUs, true);
  const clip = { ...base, stabilize: WORLD_STABILIZE };
  const all = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
  const sheet = new OffscreenCanvas(cols * W, Math.ceil(aims.length / cols) * W);
  const sc = sheet.getContext('2d')!;
  const c = new OffscreenCanvas(W, W);
  const r = await ReframeRenderer.create(c);
  r.setLayout(media.layout!);
  for (const [k, [ts, yaw, pitch]] of aims.entries()) {
    const t = all.find((x) => x >= ts * S - 1)!;
    const { frames, close } = await framesAt(media, t);
    const lk = look({ yaw, pitch, fov, fisheye: 0 });
    r.resetHistory();
    pushClipFrame(r, { ...clip, look: lk }, media, t, frames);
    presentLook(r, { ...lk, motionBlur: 0 });
    close();
    const bmp = await createImageBitmap(c);
    const ox = (k % cols) * W, oy = Math.floor(k / cols) * W;
    sc.drawImage(bmp, ox, oy);
    sc.strokeStyle = 'rgba(255,255,0,.35)';
    sc.fillStyle = '#ff0';
    sc.font = '11px sans-serif';
    // Grid of 10° lines in yaw / pitch (drawn as points along each line).
    for (let py = 0; py < W; py += 3) for (let px = 0; px < W; px += 3) {
      const d = directionAt(lk, 1, (px - W / 2) / (W / 2), -(py - W / 2) / (W / 2));
      if (!d) continue;
      const near = (v: number) => Math.abs(v / 10 - Math.round(v / 10)) * 10 < fov / W;
      if (near(d.yaw) || near(d.pitch)) sc.fillRect(ox + px, oy + py, 1, 1);
      if (near(d.yaw) && Math.abs(py - W + 9) < 2) sc.fillText(`${Math.round(d.yaw)}`, ox + px, oy + py);
      if (near(d.pitch) && px === 0) sc.fillText(`${Math.round(d.pitch)}`, ox + 2, oy + py);
    }
    sc.font = 'bold 15px sans-serif';
    sc.fillText(`${(t / S).toFixed(2)}s`, ox + 60, oy + 16);
  }
  r.destroy();
  await ace.writeFile(await ace.selftestOut(name), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
}

/** The user's own case: a short lead-in, then a tracked biker with auto zoom. */
async function zoomCheck(api: EditorApi) {
  const file = (await ace.listFixtures()).find((f) => f.endsWith('GS010120.360'))!;
  const media = await getMedia(file);
  await api.importPaths([file]);
  const start = 4.087417 * S;
  const base: TimelineClip = { ...newClip(media.path, media.durationUs, true), inUs: 3556365, outUs: 11695629, stabilize: { smoothing: 'medium', horizon: true }, look: look({ yaw: 0.23, pitch: 7.4, fov: 41.17 }) };
  const tr = riderTruthAt(4.42);
  const view = worldToClipView(media, base, start, tr[1], tr[2]);
  const res = await trackSubject({ clip: base, media, startUs: start, yaw: view.yaw, pitch: view.pitch, sizeDeg: 5.5 }, () => {}, new AbortController().signal);
  const track: NonNullable<TimelineClip['track']> = { space: 'world', points: res.points, smoothing: 0.25, offsetYaw: 0, offsetPitch: 0, autoZoom: 1 };
  track.subjectFrac = fitSubjectFrac(track, 5.5 / 41.17, 0, frameShare);
  const clip = { ...base, track };
  const out: Record<string, unknown> = { subjectFrac: +track.subjectFrac!.toFixed(3) };
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown) => { out[n] = pass ? 'ok' : { FAILED: info }; if (!pass) fails.push(n); };
  const trace = (c: TimelineClip) => [3.6, 3.8, 4.0, 4.1, 4.3, 4.6, 5, 5.5, 6, 6.5, 6.9, 7.2, 7.5, 8, 8.5, 9, 10, 11].map((t) => { const l = clipLookAt(c, t * S); return `${t}:${l.fov.toFixed(0)}°/${l.fisheye.toFixed(2)}`; }).join(' ');
  out.trace = trace(clip);
  out.traceNoFisheye = trace({ ...clip, track: { ...track, lens: 0 } });
  // 1. Nothing moves before the section.
  const lead = Array.from({ length: 32 }, (_, k) => clipLookAt(clip, base.inUs + (k / 60) * S)).filter((_, k) => base.inUs + (k / 60) * S < start);
  ok('lead-in keeps its own view and zoom', lead.every((l) => l.fov === 41.17 && l.yaw === 0.23 && l.pitch === 7.4), lead.map((l) => l.fov));
  // 2. Smooth everywhere: zoom speed and no jumps.
  let maxZoom = 0, maxYaw = 0;
  for (let t = base.inUs; t < base.outUs - 20000; t += S / 60) {
    const a = clipLookAt(clip, t), b = clipLookAt(clip, t + S / 60);
    maxZoom = Math.max(maxZoom, Math.abs(Math.log(b.fov / a.fov)));
    maxYaw = Math.max(maxYaw, Math.abs(((b.yaw - a.yaw + 540) % 360) - 180));
  }
  out.maxZoomPerFrame = `${(maxZoom * 100).toFixed(1)}%`;
  out.maxYawPerFrame = +maxYaw.toFixed(2);
  ok('zoom never jumps', maxZoom < 0.05, maxZoom);
  // 3. Zooming with the wheel in the lead-in, on the easing part and while following.
  api.setTimeline(addClip(emptyTimeline(), clip, 0));
  await settle(api, 4);
  const frame = document.querySelector('.frame') as HTMLElement;
  const cur = () => api.getTimeline().clips[0]!;
  const shown = (t: number) => clipLookAt(cur(), t).fov;
  const wheel = async (t: number, dy: number) => {
    api.player.seek(t - base.inUs);
    await settle(api);
    await sleep(250);
    const at = clipMediaTime(api);
    const before = shown(at), rest = [6.5, 8, 10].map((x) => shown(x * S));
    for (let k = 0; k < 4; k++) { frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: dy })); await sleep(40); }
    await sleep(150);
    return { want: before * Math.exp(dy * 0.0015 * 4), got: shown(at), restMoved: [6.5, 8, 10].map((x, i) => Math.abs(shown(x * S) / rest[i]! - 1)) };
  };
  const clipMediaTime = (a: EditorApi) => base.inUs + a.player.time;
  const a = await wheel(3.75 * S, 60);
  ok('zooming before the section zooms exactly as asked', Math.abs(a.got / a.want - 1) < 0.01, a);
  ok('and leaves the tracked part alone', a.restMoved.every((x) => x < 0.001), a.restMoved);
  ok('and the lead-in stays still', clipLookAt(cur(), base.inUs).fov === clipLookAt(cur(), start - 1000).fov, [clipLookAt(cur(), base.inUs).fov, clipLookAt(cur(), start - 1000).fov]);
  api.setTimeline(addClip(emptyTimeline(), clip, 0));
  const b = await wheel(4.25 * S, 40);
  ok('zooming while it eases in works', Math.abs(b.got / b.want - 1) < 0.04, b);
  api.setTimeline(addClip(emptyTimeline(), clip, 0));
  const c = await wheel(6.5 * S, 30);
  ok('zooming while following works', Math.abs(c.got / c.want - 1) < 0.03, c);
  // 4. Changing colour or adding a keyframe while following keeps the clip's own view.
  api.setTimeline(addClip(emptyTimeline(), clip, 0));
  api.player.seek(8 * S - base.inUs);
  await settle(api);
  await sleep(250);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'k', code: 'KeyK', bubbles: true }));
  await sleep(400);
  const kf = cur().keyframes[0]?.look;
  ok('a keyframe added while following stores the clip’s own view', !!kf && kf.fov === 41.17 && kf.yaw === 0.23, kf && [kf.fov, kf.yaw]);
  ok('so the lead-in is unchanged', clipLookAt(cur(), base.inUs).fov === 41.17, clipLookAt(cur(), base.inUs).fov);
  // 5. Pictures: the close pass without and with auto fisheye, then the whole run.
  const W = 480, H = 270, times = [3.7, 4.05, 4.4, 5.4, 6.4, 6.9, 7.2, 7.5, 8, 8.9, 9.9, 10.9];
  for (const [name, cl] of [['off', { ...clip, track: { ...track, lens: 0, maxFov: 170 } }], ['on', clip], ['strong', { ...clip, track: { ...track, lens: 1 } }]] as [string, TimelineClip][]) {
    const sheet = new OffscreenCanvas(4 * W, 3 * H), sc = sheet.getContext('2d')!, cv = new OffscreenCanvas(W, H);
    const r = await ReframeRenderer.create(cv);
    r.setLayout(media.layout);
    const all = media.tracks[0]!.samples.map((x) => x.timestamp).sort((p, q) => p - q);
    for (const [k, t] of times.entries()) {
      const ts = all.find((x) => x >= t * S - 1)!;
      const { frames, close } = await framesAt(media, ts);
      const lk = pushClipFrame(r, cl, media, ts, frames);
      presentLook(r, { ...lk, motionBlur: 0 });
      close();
      sc.drawImage(await createImageBitmap(cv), (k % 4) * W, Math.floor(k / 4) * H);
      sc.fillStyle = '#fff';
      sc.font = '15px sans-serif';
      sc.fillText(`${t}s  fov ${lk.fov.toFixed(0)}°  fisheye ${(lk.fisheye * 100).toFixed(0)}%`, (k % 4) * W + 8, Math.floor(k / 4) * H + 20);
    }
    r.destroy();
    await ace.writeFile(await ace.selftestOut(`zoom-${name}.png`), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  return { fails, ...out };
}

/** Playback speed of a typical edit under different interface settings. */
async function perfCheck(api: EditorApi) {
  const files = (await ace.listFixtures()).filter((f) => /\.360$/i.test(f) && !/[\\/]synthetic[\\/]/.test(f));
  const media = await getMedia(files[0]!);
  await api.importPaths(files.slice(0, 9));
  let tl = addClip(emptyTimeline(), { ...newClip(media.path, media.durationUs, true), outUs: 8 * S }, 0);
  // Two 360 clips at once, the heaviest thing to play.
  tl = addClip(tl, { ...newClip(media.path, media.durationUs, true), inUs: 12 * S, outUs: 22 * S, transitionIn: { kind: 'crossfade', durationUs: 4 * S } }, 1);
  const total = timelineDuration(tl);
  tl = { ...tl, overlays: [{ ...newGaugeOverlay('speed', 0, total), style: 'needle' as const }, { ...newGaugeOverlay('gforce', 0, total), style: 'graph' as const }, newGaugeOverlay('timer', 0, total)] };
  api.setTimeline(tl);
  await settle(api, 6);
  const out: Record<string, unknown> = {};
  const none = { translucent: false, panelOpacity: 1, shadow: 0, radius: 0, controlRadius: 4, clipRadius: 0, panelStyle: 'flush' as const, gap: 1 };
  const variants: [string, () => void][] = [
    ['default', () => setPrefs(defaultPrefs())],
    ['opaque', () => setPrefs({ ...defaultPrefs(), theme: { ...DEFAULT_THEME, translucent: false } })],
    ['opaque no shadow', () => setPrefs({ ...defaultPrefs(), theme: { ...DEFAULT_THEME, translucent: false, shadow: 0 } })],
    ['opaque square', () => setPrefs({ ...defaultPrefs(), theme: { ...DEFAULT_THEME, translucent: false, radius: 0, clipRadius: 0 } })],
    ['plainest', () => setPrefs({ ...defaultPrefs(), theme: { ...DEFAULT_THEME, ...none } })],
    ['only preview', () => setPrefs({ ...defaultPrefs(), layout: { root: group('viewer'), floats: [] } })],
    ['default again', () => setPrefs(defaultPrefs())],
  ];
  for (const [name, apply] of variants) {
    apply();
    await sleep(700);
    const st0 = api.player.stalls;
    api.player.seek(3.5 * S);
    await settle(api);
    api.player.play();
    await sleep(600);
    // Real frame times from the display loop.
    const times: number[] = [];
    let last = performance.now(), go = true;
    const tick = (n: number) => { times.push(n - last); last = n; if (go) requestAnimationFrame(tick); };
    requestAnimationFrame((n) => { last = n; requestAnimationFrame(tick); });
    const t0 = performance.now(), p0 = api.player.time;
    await sleep(4500);
    go = false;
    const wall = performance.now() - t0, adv = (api.player.time - p0) / 1000;
    api.player.pause();
    times.sort((a, b) => a - b);
    out[name] = { fps: +((times.length * 1000) / wall).toFixed(1), p95ms: +(times[Math.floor(times.length * 0.95)] ?? 0).toFixed(1), slowFrames: times.filter((x) => x > 25).length, speed: +(adv / wall).toFixed(3), stalls: api.player.stalls - st0 };
  }
  return out;
}

export async function runSelftest(api: EditorApi) {
  if (api.mode === 'flat' || api.mode === 'flatprobe' || api.mode === 'stab' || api.mode === 'lensdump' || api.mode === 'reallooks' || api.mode === 'realplay' || api.mode === 'realsteady' || api.mode === 'follow' || api.mode === 'realfollow' || api.mode === 'equirect' || api.mode === 'equirectmotion' || api.mode === 'chapters' || api.mode === 'card' || api.mode === 'cardquit' || api.mode === 'speed' || api.mode === 'colorprobe' || api.mode === 'colorroutes' || api.mode === 'colorfacts' || api.mode === 'color' || api.mode === 'seamlook' || api.mode === 'seam' || api.mode === 'seamfit' || api.mode === 'seamcheck' || api.mode === 'lens' || api.mode === 'exporttag' || api.mode === 'export' || api.mode === 'lenslook' || api.mode === 'strip' || api.mode === 'scrubback' || api.mode === 'gauges' || api.mode === 'drop' || api.mode === 'airtime' || api.mode === 'tenbit' || api.mode === 'tenbitexport' || api.mode === 'tour' || api.mode === 'report' || api.mode === 'odd' || api.mode === 'long' || api.mode === 'markers' || api.mode === 'snap' || api.mode === 'protrim' || api.mode === 'pool' || api.mode === 'compat' || api.mode === 'projects' || api.mode === 'layers' || api.mode === 'masks' || api.mode === 'motion' || api.mode === 'finish' || api.mode === 'beta8' || api.mode === 'regular' || api.mode === 'ai' || api.mode === 'spectrum' || api.mode === 'highlights' || api.mode === 'startup') {
    try {
      await ace.selftestDone(api.mode === 'startup' ? { fails: [], readyMs: Math.round(performance.now()), packaged: (await ace.info()).packaged } : api.mode === 'tour' ? await tourCheck(api) : api.mode === 'report' ? await reportCheck(api) : api.mode === 'compat' ? await compatCheck(api) : api.mode === 'projects' ? await projectsCheck(api) : api.mode === 'layers' ? await layersCheck(api) : api.mode === 'regular' ? await regularCheck(api) : api.mode === 'ai' ? await aiCheck(api) : api.mode === 'spectrum' ? await spectrumCheck(api) : api.mode === 'highlights' ? await highlightsCheck(api) : api.mode === 'masks' ? await masksCheck(api) : api.mode === 'motion' ? await motionCheck(api) : api.mode === 'finish' ? await finishCheck(api) : api.mode === 'beta8' ? await beta8Check(api) : api.mode === 'odd' ? await oddCheck(api) : api.mode === 'long' ? await longCheck(api) : api.mode === 'markers' ? await markersCheck(api) : api.mode === 'snap' ? await snapCheck(api) : api.mode === 'protrim' ? await proTrimCheck(api) : api.mode === 'pool' ? await poolCheck(api) : api.mode === 'tenbitexport' ? await tenbitExport() : api.mode === 'tenbit' ? await tenbitProbe() : api.mode === 'airtime' ? await airtimeCheck(api) : api.mode === 'drop' ? await dropCheck(api) : api.mode === 'gauges' ? await gaugesCheck(api) : api.mode === 'scrubback' ? await scrubBackCheck(api) : api.mode === 'strip' ? await stripCheck(api) : api.mode === 'lenslook' ? await lensLookCheck(api) : api.mode === 'export' ? await exportCheck() : api.mode === 'exporttag' ? await exportTag() : api.mode === 'lens' ? await lensCheck(api) : api.mode === 'colorprobe' ? await colorProbe() : api.mode === 'seam' ? await seamMeasure() : api.mode === 'seamcheck' ? await seamCheck() : api.mode === 'seamfit' ? await seamFit() : api.mode === 'seamlook' ? await seamLook() : api.mode === 'color' ? await colorCheck(api) : api.mode === 'colorfacts' ? await colorFacts() : api.mode === 'colorroutes' ? await colorRoutes() : api.mode === 'speed' ? await speedCheck(api) : api.mode === 'card' ? await cardCheck(api) : api.mode === 'cardquit' ? await cardQuit() : api.mode === 'chapters' ? await chapterCheck(api) : api.mode === 'equirectmotion' ? await equirectMotion() : api.mode === 'equirect' ? await equirectCheck(api) : api.mode === 'realfollow' ? await realFollow() : api.mode === 'follow' ? await followCheck(api) : api.mode === 'flat' ? await flatCheck(api) : api.mode === 'stab' ? await stabCheck(api) : api.mode === 'realsteady' ? await realSteady('GX010133.MP4') : api.mode === 'realplay' ? await realPlay(api, 'GX010133.MP4') : api.mode === 'reallooks' ? await realLooks('GX010133.MP4') : api.mode === 'lensdump' ? await lensDump('GX010133.MP4') : await flatProbe());
    } catch (e) {
      await ace.capture('flat-crash');
      await ace.selftestDone({ error: String((e as Error).stack ?? e) });
    }
    return;
  }
  if (api.mode === 'ui') {
    try {
      await ace.selftestDone(await uiCheck(api));
    } catch (e) {
      await ace.capture('ui-crash');
      await ace.selftestDone({ error: String((e as Error).stack ?? e) });
    }
    return;
  }
  if (api.mode === 'zoom') {
    try {
      await ace.selftestDone(await zoomCheck(api));
    } catch (e) {
      await ace.selftestDone({ error: String((e as Error).stack ?? e) });
    }
    return;
  }
  if (api.mode === 'perf') {
    try {
      await ace.selftestDone(await perfCheck(api));
    } catch (e) {
      await ace.selftestDone({ error: String((e as Error).stack ?? e) });
    }
    return;
  }
  if (api.mode === 'label') {
    const file = (await ace.listFixtures()).find((f) => f.endsWith('GS010120.360'));
    try {
      const media = await getMedia(file!);
      const early: [number, number, number][] = [], late: [number, number, number][] = [];
      const ys = [5, 5, 5, 6, 6, 7, 8, 9, 12, 17, 26, 45];
      ys.forEach((y, k) => early.push([4.4 + 0.25 * k, y, 0]));
      [[7.15, 60], [7.4, 90], [7.65, 115], [7.9, 130], [8.15, 145], [8.4, 155], [8.9, 165], [9.4, 172], [9.9, 175], [10.4, 178], [10.9, 178], [11.4, 178]].forEach(([t, y]) => late.push([t!, y!, -8]));
      await labelSheet(media, 'label-early.png', early, 50);
      await labelSheet(media, 'label-late.png', late, 70);
      await ace.selftestDone({ ok: true });
    } catch (e) {
      await ace.selftestDone({ error: String((e as Error).stack ?? e) });
    }
    return;
  }
  if (api.mode === 'rider') {
    const file = (await ace.listFixtures()).find((f) => f.endsWith('GS010120.360'));
    try {
      const media = await getMedia(file!);
      const defaults = { ...TRACKER };
      const out: Record<string, unknown> = {};
      const starts: [number, number, [number, number]?][] = [[4.42, 6], [4.42, 10], [5.42, 8], [6.42, 18], [7.42, 26], [8.43, 10], [4.42, 8, [0.2, 0.2]], [5.42, 10, [-0.2, 0.15]], [8.43, 12, [0.2, -0.2]]];
      const variants: [string, Partial<typeof TRACKER>][] = [
        ['default', {}],
      ];
      for (const [name, cfg] of variants) {
        Object.assign(TRACKER, defaults, cfg);
        const res: Record<string, unknown> = {};
        let tot = 0, n = 0;
        for (const [t, size, off] of starts) {
          const a = await riderCheck(media, `${name}-${t}-${size}`, size, t, off);
          const [o, m] = a.score.onRider.split('/').map(Number);
          tot += o!; n += m!;
          res[`${t}s box ${size}${off ? ' off' : ''}`] = `${a.score.onRider}  ${a.probe}  ${a.score.errs}  ${a.speed}`;
        }
        out[`${name} ${tot}/${n}`] = res;
      }
      Object.assign(TRACKER, defaults);
      await ace.selftestDone(out);
    } catch (e) {
      await ace.selftestDone({ error: String(e), stack: (e as Error).stack });
    }
    return;
  }
  if (api.mode === 'track2') {
    const real = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f) && /\.360$/i.test(f));
    try {
      const media = await getMedia(real[0]!);
      const out: Record<string, unknown> = {};
      const defaults = { ...TRACKER };
      const variants: [string, Partial<typeof TRACKER>, number][] = [
        ['box 30°', {}, 30],
        ['box 12°', {}, 12],
        ['box 6°', {}, 6],
      ];
      for (const [name, cfg, size] of variants) {
        Object.assign(TRACKER, defaults, cfg);
        out[name] = await helmetCheck(media, { yaw: 180, pitch: -20, size, seconds: 11, tag: `helmet-${name.replace(/[^a-z0-9]/gi, '')}` });
      }
      Object.assign(TRACKER, defaults);
      await ace.selftestDone(out);
    } catch (e) {
      await ace.selftestDone({ error: String(e), stack: (e as Error).stack });
    }
    return;
  }
  if (api.mode === 'scrub') {
    const real = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f) && /\.360$/i.test(f));
    try {
      await api.importPaths(real);
      const media = await getMedia(real[0]!);
      const out: Record<string, unknown> = {};
      for (const l of [1, 2, 4, 8] as const) {
        const t0 = performance.now();
        await logStep(`level ${l}: building proxy`);
        setPreviewLevel(l, [media]);
        await proxiesIdle();
        await logStep(`level ${l}: proxy ready (${proxyErrors.get(media.path) ?? 'ok'})`);
        const built = (performance.now() - t0) / 1000;
        const { path: pp, exists } = l > 1 ? await ace.proxyPath(media.path, l) : { path: '', exists: false };
        const size = exists ? (await ace.stat(pp)).size : 0;
        api.player.seek(10 * S);
        await settle(api, 6);
        await ace.capture(`preview-level${l}`);
        out[`level${l}`] = { proxyBuildSeconds: +built.toFixed(1), proxyMB: +(size / 1e6).toFixed(1), errors: proxyErrors.get(media.path) ?? null, ...(await scrubCheck(api, media)) };
      }
      setPreviewLevel(1, [media]);
      await ace.selftestDone(out);
    } catch (e) {
      await ace.selftestDone({ error: String(e), stack: (e as Error).stack });
    }
    return;
  }
  if (api.mode === 'track') {
    const real = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f) && /\.360$/i.test(f));
    try {
      const media = await getMedia(real[0]!);
      await ace.selftestDone({ sun: await trackCheck(media, 'sun'), shore: await trackCheck(media, 'shore') });
    } catch (e) {
      await ace.selftestDone({ error: String(e), stack: (e as Error).stack });
    }
    return;
  }
  if (api.mode === 'render') {
    // Diagnostics: dumps small greyscale renders of the first 25 s for a few stabilisation settings.
    const real = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f) && /\.360$/i.test(f));
    try {
      const media = await getMedia(real[0]!);
      const base = newClip(media.path, media.durationUs, true);
      const W = 320, H = 180;
      const canvas = new OffscreenCanvas(W, H);
      const r = await ReframeRenderer.create(canvas);
      r.setLayout(media.layout);
      const read = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
      const variants: [string, TimelineClip['stabilize']][] = [
        ['hoff', { smoothing: 'off', horizon: true }],
        ['hlocked', { smoothing: 'locked', horizon: true }],
        ['hhigh', { smoothing: 'high', horizon: true }],
      ];
      const times = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).filter((t) => t < 25 * S);
      for (const [name, stabilize] of variants) {
        const decs = media.tracks.map((t) => new TrackDecoder(media.reader, t));
        decs.forEach((d) => d.seek(times[0]!));
        const out = new Uint8Array(times.length * W * H);
        for (let k = 0; k < times.length; k++) {
          const t = times[k]!;
          let fr: (VideoFrame | null)[] = [];
          for (let i = 0; i < 5000; i++) {
            decs.forEach((d) => void d.pump());
            fr = decs.map((d) => d.frameAt(t));
            if (fr.every(Boolean)) break;
            await sleep(2);
          }
          r.resetHistory();
          const lk = pushClipFrame(r, { ...base, look: look({ fov: 90 }), stabilize }, media, t, fr as VideoFrame[]);
          presentLook(r, { ...lk, motionBlur: 0 });
          await r.idle();
          const bmp = await createImageBitmap(canvas);
          read.drawImage(bmp, 0, 0);
          bmp.close();
          const px = read.getImageData(0, 0, W, H).data;
          for (let i = 0; i < W * H; i++) out[k * W * H + i] = (px[i * 4]! * 2 + px[i * 4 + 1]! * 5 + px[i * 4 + 2]!) >> 3;
        }
        decs.forEach((d) => d.close());
        await ace.writeFile(await ace.selftestOut(`render-${name}.bin`), out);
      }
      r.destroy();
      await ace.selftestDone({ n: times.length, W, H });
    } catch (e) {
      await ace.selftestDone({ error: String(e), stack: (e as Error).stack });
    }
    return;
  }
  if (api.mode === 'frames') {
    const real = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f) && /\.360$/i.test(f));
    try {
      const media = await getMedia(real[0]!);
      const base = newClip(media.path, media.durationUs, true);
      const W = 480, H = 270;
      const canvas = new OffscreenCanvas(W, H);
      const r = await ReframeRenderer.create(canvas);
      r.setLayout(media.layout);
      const files: string[] = [];
      for (const T of [12.5, 13.9]) {
        const { frames, close } = await framesAt(media, T * S);
        for (const yaw of [0, 90, 180, 270]) {
          for (const [name, stabilize] of [['level', { smoothing: 'off', horizon: true }], ['lock', { smoothing: 'locked', horizon: true }]] as const) {
            r.resetHistory();
            const lk = pushClipFrame(r, { ...base, look: look({ fov: 100, yaw }), stabilize: { ...stabilize } }, media, T * S, frames);
            presentLook(r, { ...lk, motionBlur: 0 });
            await r.idle();
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            const file = `frame-${T}-${yaw}-${name}.png`;
            await ace.writeFile(await ace.selftestOut(file), new Uint8Array(await blob.arrayBuffer()));
            files.push(file);
          }
        }
        close();
      }
      r.destroy();
      await ace.selftestDone({ files });
    } catch (e) {
      await ace.selftestDone({ error: String(e), stack: (e as Error).stack });
    }
    return;
  }
  if (api.mode === 'sync') {
    const real = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f) && /\.360$/i.test(f));
    try {
      const media = await getMedia(real[0]!);
      const res = await dumpSyncFrames(media, 25);
      const syncOffsetMs = ((media.stabilizer.data as { syncOffsetUs?: number } | null)?.syncOffsetUs ?? 0) / 1000;
      await ace.selftestDone({ path: real[0], syncOffsetMs, coriFit: media.stabilizer.coriFit, n: res.n });
    } catch (e) {
      await ace.selftestDone({ error: String(e), stack: (e as Error).stack });
    }
    return;
  }
  const report: Record<string, unknown> = {
    when: new Date().toISOString(),
    versions: { electron: api.versions.electron, chrome: api.versions.chrome },
  };
  const out = (name: string) => ace.selftestOut(name);
  try {
    // --- Media ---------------------------------------------------------------------------
    const synth = await generateSynthetic360({ seconds: 3 });
    const tone = await generateTone(30);
    const real = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f) && !/GS010004\.mp4$/.test(f)); // (that one is 8 minutes long)
    await api.importPaths([...real, synth]);
    const media = await Promise.all([...real, synth].map((p) => getMedia(p).catch((e) => ({ error: String(e), path: p }))));
    report.media = media.map((m) => ('error' in m ? m : { name: m.name, is360: m.is360, durationS: +(m.durationUs / S).toFixed(2), fps: +m.fps.toFixed(2), size: `${m.width}x${m.height}`, audioTracks: m.info.audioTracks.map((a) => `${a.codec} ${a.channels}ch ${a.sampleRate}Hz`), telemetry: m.stabilizer.hasOrientation }));
    const real360 = media.find((m): m is Media => !('error' in m) && m.is360 && m.path !== synth);
    const synthMedia = mediaNow(synth)!;

    // --- Build an edit -------------------------------------------------------------------
    let tl: Timeline = emptyTimeline();
    if (real360) {
      // Clip 1: 0–6 s, keyframed pan right with warm grade + motion blur.
      const c1 = newClip(real360.path, real360.durationUs, true);
      c1.outUs = 6 * S;
      c1.stabilize = { smoothing: 'medium', horizon: true };
      const g = gradeFromPreset('Golden hour');
      c1.keyframes = setKeyframe(setKeyframe([], 0, look({ yaw: 0, fov: 110, fisheye: 0.2, grade: g, motionBlur: 0.43 })), 4 * S, look({ yaw: 90, fov: 140, fisheye: 0.35, grade: g, motionBlur: 0.43 }));
      tl = addClip(tl, c1);
    }
    tl = addClip(tl, newClip(synth, synthMedia.durationUs, true));
    if (real360) {
      // Clip 3: 10–15 s as a tiny planet, black & white, 2× speed.
      const c3 = newClip(real360.path, real360.durationUs, true);
      c3.inUs = 10 * S;
      c3.outUs = 15 * S;
      c3.speed = 2;
      c3.look = look({ pitch: -90, fov: 260, fisheye: 1 / 3, grade: gradeFromPreset('Black & white') });
      tl = addClip(tl, c3);
    }
    await loadMusic(tone);
    tl = { ...tl, audio: [newAudioClip(tone, 30 * S, 0)] };
    // Transitions: crossfade into clip 2, dip to black into clip 3.
    if (tl.clips[1]) tl = updateClip(tl, tl.clips[1].id, { transitionIn: { kind: 'iris', durationUs: 1 * S } });
    // Effects on clip 1 (keyframes carry them, so set them on both keys).
    if (tl.clips[0]?.keyframes.length) {
      const fx = { ...NO_EFFECTS, grain: 0.35, glow: 0.5, leak: 0.5, bars: 1 };
      tl = updateClip(tl, tl.clips[0].id, { keyframes: tl.clips[0].keyframes.map((k) => ({ ...k, look: { ...k.look, fx } })) });
    }
    if (tl.clips[2]) tl = updateClip(tl, tl.clips[2].id, { transitionIn: { kind: 'dip-black', durationUs: 0.6 * S } });
    // Overlays: a title and telemetry gauges. The fixture has no GPS lock, so give the real clip
    // a simulated ride (a loop at 20–40 km/h) to exercise the speed / distance / map gauges.
    if (real360) {
      const gps = Array.from({ length: 251 }, (_, i) => {
        const a = (i / 250) * Math.PI * 2;
        return { t: i * 100_000, lat: 46.2 + 0.0004 * Math.sin(a), lon: 7.3 + 0.0006 * Math.cos(a), alt: 520 + 8 * Math.sin(a * 2), speed: 8 + 3 * Math.sin(a * 3), fix: 3 };
      });
      real360.telemetry = new TelemetrySeries(gps, real360.stabilizer.data?.accl);
      tl = detachAudio(tl, tl.clips[0]!.id);
      await loadMusic(real360.path);
    }
    const total = timelineDuration(tl);
    const neon = TEXT_PRESETS.find(([n]) => n === 'Neon')![1];
    const title = { ...newTextOverlay(0.3 * S, 4.5 * S, 'Pump track session'), ...neon, animation: 'pop' as const, size: 0.09, y: 0.2 };
    tl = {
      ...tl,
      overlays: [
        title,
        { ...newGaugeOverlay('speed', 0, total), style: 'needle' as const, size: 0.24, x: 0.13, y: 0.76 },
        { ...newGaugeOverlay('gforce', 0, total), style: 'graph' as const, x: 0.42, y: 0.84, size: 0.12, background: 'box' as const },
        { ...newGaugeOverlay('altitude', 0, total), style: 'graph' as const, x: 0.84, y: 0.2, size: 0.1, background: 'box' as const, accent: '#4cd790' },
        { ...newGaugeOverlay('map', 0, total), style: 'round' as const, size: 0.26, y: 0.76 },
        { ...newGaugeOverlay('timer', 0, total), y: 0.32 },
      ],
    };
    api.setTimeline(tl);
    report.timeline = {
      clips: tl.clips.length,
      durationS: +(timelineDuration(tl) / S).toFixed(2),
      transitions: tl.clips.map((c) => c.transitionIn?.kind ?? null),
      overlays: tl.overlays.map((o) => o.kind),
      audio: tl.audio.map((a) => (a.linkedClipId ? 'detached clip audio' : 'music')),
    };
    await settle(api, 6);

    // --- Screenshots of the editor --------------------------------------------------------
    await capture(api, 'editor-clip1-start', 0.2 * S);
    await capture(api, 'editor-clip1-keyframed-mid', 2 * S);
    await capture(api, 'editor-crossfade-mid', 5.5 * S);
    await capture(api, 'editor-synthetic', (real360 ? 6.5 : 0.5) * S);
    if (real360) await capture(api, 'editor-dip-mid', 7.7 * S);
    if (real360) await capture(api, 'editor-tiny-planet', 9 * S);
    setPrefs(defaultPrefs());
    await sleep(400);
    // Panel sections: start closed except the main one, open on click, close all together.
    {
      const heads = () => [...document.querySelectorAll('.inspector .section-toggle')] as HTMLButtonElement[];
      const list = () => heads().map((h) => `${h.querySelector('h3')!.textContent}${h.getAttribute('aria-expanded') === 'true' ? '*' : ''}`);
      api.player.seek(1 * S);
      await settle(api);
      await sleep(300);
      const start = list();
      const lens = () => heads().find((h) => h.querySelector('h3')!.textContent === 'Lens')!;
      lens().click();
      await sleep(200);
      const opened = list();
      const slidersShown = !!document.querySelector('.inspector input[aria-label="Field of view"]');
      await ace.capture('editor-sections-open');
      lens().click();
      (document.querySelector('.inspector button[title^="Close all"]') as HTMLButtonElement).click();
      await sleep(200);
      const closed = list();
      await ace.capture('editor-sections-closed');
      (document.querySelector('.inspector button[title^="Close all"]') as HTMLButtonElement).click();
      await sleep(200);
      const all = list();
      (document.querySelector('.inspector button[title^="Close all"]') as HTMLButtonElement).click();
      const tabs: Record<string, string[]> = {};
      for (const t of ['Stabilize', 'Color', 'Effects', 'Clip', 'Reframe']) {
        ([...document.querySelectorAll('.dock-tab')].find((b) => b.textContent === t) as HTMLButtonElement).click();
        await sleep(150);
        tabs[t] = list();
      }
      report.sections = { start, opened, slidersShown, closed, all, tabs, saved: localStorage.getItem('ace.sections.v1') };
      localStorage.removeItem('ace.sections.v1'); // next run starts fresh
    }
    // Right-click (two-finger click) the first clip: the clip menu should open.
    {
      api.player.seek(1 * S);
      await settle(api);
      const el = document.querySelector('.video-track .clip') as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.3, clientY: r.top + r.height / 2, button: 2 }));
        await sleep(300);
        report.contextMenu = [...document.querySelectorAll('.menu.context button')].map((b) => b.textContent);
        await ace.capture('editor-context-menu');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(100);
      }
    }
    // Subject tracking through the real UI path: box in the middle of the preview at 1 s.
    if (real360 && api.trackBox) {
      api.player.seek(1 * S);
      await settle(api);
      const f = document.querySelector('.frame') as HTMLElement;
      const w = f.clientWidth, h = f.clientHeight;
      const t0 = performance.now();
      await api.trackBox({ x0: w * 0.42, y0: h * 0.4, x1: w * 0.58, y1: h * 0.6 });
      await sleep(500);
      const c0 = api.getTimeline().clips[0]!;
      report.tracking = {
        points: c0.track?.points.length ?? 0,
        rangeS: c0.track?.points.length ? [+(c0.track.points[0]!.t / S).toFixed(2), +(c0.track.points.at(-1)!.t / S).toFixed(2)] : null,
        seconds: +((performance.now() - t0) / 1000).toFixed(1),
        notice: document.querySelector('.notice')?.textContent ?? null,
      };
      // Use only part of it: drag the right handle on the clip, then "Start here" in the panel.
      {
        const range = () => { const r = trackRange(api.getTimeline().clips[0]!.track!)!; return r.map((v) => +(v / S).toFixed(2)); };
        const drag = async (el: Element | null, dx: number) => {
          if (!el) return false;
          const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
          // Whatever is on top at that point must be the handle itself (not the clip's trim edge).
          const top = document.elementFromPoint(x, y) === el;
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
          for (let k = 1; k <= 5; k++) { window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + (dx * k) / 5, clientY: y })); await sleep(40); }
          window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + dx, clientY: y }));
          await sleep(200);
          return top;
        };
        const before = range(), inOut = () => { const c = api.getTimeline().clips[0]!; return [c.inUs, c.outUs]; };
        const trim0 = inOut();
        const handleOnTop = await drag(document.querySelector('.track-handle.end'), -60);
        const afterDrag = range();
        const playheadS = +(api.player.time / S).toFixed(2);
        api.player.seek((before[0]! + 0.5) * S);
        await settle(api);
        await sleep(250);
        const button = (t: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
        button('Start here')?.click();
        await sleep(200);
        const afterButton = range();
        const c = api.getTimeline().clips[0]!;
        const end = trackRange(c.track!)![1];
        const steps: number[] = [];
        for (let t = trackRange(c.track!)![0] - S; t < end + 1.5 * S; t += 1e6 / 60) {
          const a = clipLookAt(c, t), b = clipLookAt(c, t + 1e6 / 60);
          steps.push(Math.abs(((b.yaw - a.yaw + 540) % 360) - 180));
        }
        report.trackRange = { before, handleOnTop, afterDrag, playheadS, afterButton, pointsKept: c.track!.points.length, clipTrimUnchanged: JSON.stringify(trim0) === JSON.stringify(inOut()), maxYawStepPerFrame: +Math.max(...steps).toFixed(2) };
        // After the stop: scrolling the preview sets the view it settles on, not the tracked part.
        api.player.seek(end + 0.3 * S);
        await settle(api);
        await sleep(250);
        const fovIn0 = clipLookAt(c, end - 0.3 * S).fov;
        document.querySelector('.frame')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200 }));
        await sleep(250);
        const c2 = api.getTimeline().clips[0]!;
        (report.trackRange as Record<string, unknown>).settleView = { set: !!c2.track!.end, trackedPartUnchanged: Math.abs(clipLookAt(c2, end - 0.3 * S).fov - fovIn0) < 1e-6, heldFov: [+clipLookAt(c, end + 2 * S).fov.toFixed(1), +clipLookAt(c2, end + 2 * S).fov.toFixed(1)] };
        await capture(api, 'editor-track-range', (before[0]! + 1) * S);
        button('Use all')?.click();
        await sleep(200);
        (report.trackRange as Record<string, unknown>).afterUseAll = range();
      }
      await capture(api, 'editor-tracking', 3 * S);
    }
    // Full-screen preview (F), then back.
    {
      api.player.seek(2 * S);
      await settle(api);
      await ace.selftestGesture(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })); 1`);
      await sleep(1200);
      await settle(api);
      const el = document.fullscreenElement as HTMLElement | null;
      const frame = document.querySelector('.frame') as HTMLElement | null;
      report.fullscreen = { element: el?.className ?? null, frame: frame ? `${frame.clientWidth}x${frame.clientHeight}` : null, screen: `${screen.width}x${screen.height}` };
      await ace.capture('editor-fullscreen');
      await ace.selftestGesture(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })); 1`);
      await sleep(1200);
      report.fullscreenExited = !document.fullscreenElement;
    }
    api.setTimeline({ ...api.getTimeline(), framing: '9:16' });
    await capture(api, 'editor-vertical-9x16', 2 * S);
    api.setTimeline({ ...api.getTimeline(), framing: '16:9' });

    // --- Playback across cuts ---------------------------------------------------------------
    report.playback = [await measurePlayback(api, 0, 2), ...(real360 ? [await measurePlayback(api, 5 * S, 3)] : [])];

    // --- Stabilisation: steadier picture with more smoothing ------------------------------------
    if (real360?.stabilizer.hasOrientation) {
      const base = newClip(real360.path, real360.durationUs, true);
      const mk = (smoothing: TimelineClip['stabilize']['smoothing'], horizon: boolean): TimelineClip => ({ ...base, look: look({ fov: 90 }), stabilize: { smoothing, horizon } });
      const shake: Record<string, number> = {};
      for (const sm of ['off', 'low', 'medium', 'high', 'locked'] as const) shake[`${sm}+horizon`] = await shakeScore(real360, mk(sm, true), 8 * S, 60);
      shake.rawCamera = await shakeScore(real360, mk('off', false), 8 * S, 60);
      // Rotation of the rendered view in the world, frame to frame, over the whole clip (from telemetry).
      const st = real360.stabilizer;
      const ax = ['x', '-y', 'z'] as [string, string, string];
      const times = real360.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
      const viewRate: Record<string, number> = {};
      for (const sm of ['off', 'low', 'medium', 'high', 'locked'] as const) {
        let prev: number[] | null = null, sum = 0, n = 0;
        for (const t of times) {
          const A = st.correctionAt(t, { smoothing: 'locked', horizon: false, axisMap: ax }); // camera → world (start frame)
          const B = st.correctionAt(t, { smoothing: sm, horizon: true, axisMap: ax }); // camera → view
          const V = mulMat(A, transpose(B)); // view → world
          if (prev) {
            const d = mulMat(transpose(prev as typeof V), V);
            sum += Math.acos(Math.max(-1, Math.min(1, (d[0] + d[4] + d[8] - 1) / 2))) ** 2;
            n++;
          }
          prev = V;
        }
        viewRate[sm] = +((Math.sqrt(sum / n) * 180) / Math.PI).toFixed(3);
      }
      report.viewRotationDegPerFrame = { note: 'RMS frame-to-frame rotation of the rendered view (horizon on); lower = steadier', ...viewRate };
      report.shake = { note: 'mean |frame-to-frame difference|, upper half of a level 90° view (distant scenery), 60 frames from 8 s; lower = steadier', ...shake };
      const fits = fitCoriMapping(real360.stabilizer.data!);
      report.coriFit = { chosen: real360.stabilizer.coriFit, top: fits.slice(0, 6).map((f) => `${f.axisMap.join(',')}${f.invert ? ' inv' : ''} ${f.score.toExponential(2)}`) };
      report.calibration = await calibrateMedia(real360, 3).then((c) => ({ score: +c.score.toFixed(2), seam: c.seam }));
    }

    // --- Frame grab ------------------------------------------------------------------------------
    api.player.seek(2 * S);
    await settle(api);
    const res = api.lastResult();
    if (res?.layers) {
      const grab = await out('frame-grab.jpg');
      const t0 = performance.now();
      await grabFrame(api.getTimeline(), api.player.time, res.layers, grab, 1080);
      report.frameGrab = { path: grab, ms: Math.round(performance.now() - t0) };
    }

    // --- Export and verify -----------------------------------------------------------------------
    const exportPath = await out('export-720p.mp4');
    const t0 = performance.now();
    let lastStage = '';
    await exportTimeline(api.getTimeline(), { path: exportPath, resolution: 720, fps: 30, codec: 'avc', quality: 'high' }, (p) => (lastStage = `${p.stage} ${Math.round(p.fraction * 100)}%`), new AbortController().signal);
    const exportMs = performance.now() - t0;
    const { size } = await ace.stat(exportPath);
    const info = await openMedia(ipcReader(exportPath, size));
    const v = info.videoTracks[0]!;
    // Decode a frame from the middle and save it for inspection.
    const exported = await getMedia(exportPath);
    // Also keep a frame from the middle of the crossfade.
    {
      const f = await framesAt(exported, 5.5 * S);
      const cc = new OffscreenCanvas(f.frames[0]!.displayWidth, f.frames[0]!.displayHeight);
      cc.getContext('2d')!.drawImage(f.frames[0]!, 0, 0);
      f.close();
      await ace.writeFile(await out('export-frame-crossfade.png'), new Uint8Array(await (await cc.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    }
    const { frames, close } = await framesAt(exported, Math.min(2 * S, exported.durationUs / 2));
    const c = new OffscreenCanvas(v.width, v.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(frames[0]!, 0, 0);
    close();
    const px = ctx.getImageData(0, 0, v.width, v.height).data;
    let lum = 0;
    for (let i = 0; i < px.length; i += 4) lum += px[i]! + px[i + 1]! + px[i + 2]!;
    const blob = await c.convertToBlob({ type: 'image/png' });
    await ace.writeFile(await out('export-frame-2s.png'), new Uint8Array(await blob.arrayBuffer()));
    report.export = {
      path: exportPath,
      sizeMB: +(size / 1e6).toFixed(2),
      seconds: +(exportMs / 1000).toFixed(1),
      realtimeFactor: +((timelineDuration(api.getTimeline()) / 1e3) / exportMs).toFixed(2),
      lastStage,
      durationS: +(info.durationUs / S).toFixed(2),
      expectedS: +(timelineDuration(api.getTimeline()) / S).toFixed(2),
      video: `${v.codec} ${v.width}x${v.height} ${v.fps.toFixed(2)}fps ${v.samples.length} frames`,
      audio: info.audioTracks.map((a) => `${a.codec} ${a.channels}ch ${a.sampleRate}Hz ${a.samples.length} packets`),
      frameMeanBrightness: +(lum / (px.length * 0.75)).toFixed(1),
    };
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e instanceof Error ? e.stack ?? e.message : e);
  }
  await ace.selftestDone(report);
}

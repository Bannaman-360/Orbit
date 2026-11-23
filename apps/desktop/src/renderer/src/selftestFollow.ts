// Horizon leveling and subject tracking on regular clips, scored against a known answer: a
// "virtual camera" films the labelled rider of a 360 clip, shaking and leaning, through a known lens.

import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_VERY_HIGH } from 'mediabunny';
import { addClip, DEFAULT_LOOK, emptyTimeline, fitSubjectFrac, newClip, type ClipTrack, type Look, type TimelineClip } from '@ace/project';
import { TrackDecoder } from '@ace/engine';
import { effectiveLens, lensFor, lensForward, lensInverse, mulMat, pictureToDir, mulVec, ReframeRenderer, rotZ, sampleMatrix, transpose, viewRotation, type Mat3, type SourceLens, type Vec3 } from '@ace/media360';
import { DEFAULT_AXIS_MAP, qnorm, Stabilizer, type OrientationData } from '@ace/telemetry';
import { ace } from './api';
import { framesAt } from './calib';
import { exportTimeline } from './exporter';
import { clipLookAt, cropReady, flatShot, flatWorld, presentLook, pushClipFrame, shareOf, worldInPicture, WORLD_STABILIZE } from './frameRender';
import { getMedia, type Media } from './media';
import { RIDER_TRUTH, riderTruthAt, type EditorApi } from './selftest';
import { trackSubject } from './tracker';

const S = 1_000_000, RAD = Math.PI / 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const look = (o: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...o });
const dirOf = (yaw: number, pitch: number): Vec3 => [Math.cos(pitch * RAD) * Math.sin(yaw * RAD), Math.sin(pitch * RAD), Math.cos(pitch * RAD) * Math.cos(yaw * RAD)];
const anglesOf = (d: Vec3) => ({ yaw: Math.atan2(d[0], d[2]) / RAD, pitch: Math.asin(Math.max(-1, Math.min(1, d[1]))) / RAD });
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / RAD;

/** Where the 360 recording starts in the virtual clip, and how long it is (s). */
const FROM = 4.42, LONG = 6.2;
/** The rider's smoothed heading: what someone filming them would point at. */
const heading = (ts: number): [number, number] => {
  let y = 0, p = 0, w = 0;
  for (let k = -8; k <= 8; k++) { const tr = riderTruthAt(Math.max(FROM, Math.min(FROM + LONG, ts - 0.12 + k * 0.05))); const g = Math.exp(-0.5 * (k / 4) ** 2); y += g * tr[1]; p += g * tr[2]; w += g; }
  return [y / w, p / w];
};
type Path = (s: number) => Mat3;
/** Camera → level world (the 360 clip's steady frame), `s` seconds into the virtual clip. */
const filming: Path = (s) => {
  const [y, p] = heading(FROM + s);
  const lean = 14 * Math.sin(2 * Math.PI * 0.31 * s) + 1.6 * Math.sin(2 * Math.PI * 1.7 * s + 0.7) + 0.6 * Math.sin(2 * Math.PI * 7.3 * s);
  const sy = 1.0 * Math.sin(2 * Math.PI * 3.1 * s + 1) + 0.5 * Math.sin(2 * Math.PI * 8.7 * s), sp = 0.9 * Math.sin(2 * Math.PI * 2.3 * s + 2) + 0.45 * Math.sin(2 * Math.PI * 8.3 * s);
  return viewRotation((y + 13 * Math.sin(2 * Math.PI * 0.42 * s) + sy) * RAD, (p - 4 + 5 * Math.sin(2 * Math.PI * 0.27 * s + 1) + sp) * RAD, lean * RAD);
};
/** Pointing at one place, so the rider goes through the picture and out of it. */
const standing: Path = (s) => viewRotation((20 + 1.2 * Math.sin(2 * Math.PI * 2.1 * s)) * RAD, (-3 + Math.sin(2 * Math.PI * 1.7 * s)) * RAD, 5 * Math.sin(2 * Math.PI * 0.5 * s) * RAD);

const quatOf = (m: Mat3): [number, number, number, number] => {
  // (Whichever term is largest, so half turns are fine too.)
  const t = [m[0] + m[4] + m[8], m[0] - m[4] - m[8], m[4] - m[0] - m[8], m[8] - m[0] - m[4]];
  const i = t.indexOf(Math.max(...t)), k = Math.sqrt(1 + t[i]!) / 2, d = 1 / (4 * k);
  return qnorm(i === 0 ? [k, (m[7] - m[5]) * d, (m[2] - m[6]) * d, (m[3] - m[1]) * d] : i === 1 ? [(m[7] - m[5]) * d, k, (m[1] + m[3]) * d, (m[2] + m[6]) * d] : i === 2 ? [(m[2] - m[6]) * d, (m[1] + m[3]) * d, k, (m[5] + m[7]) * d] : [(m[3] - m[1]) * d, (m[2] + m[6]) * d, (m[5] + m[7]) * d, k]);
};
const P: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, 1];
const steady360 = (m: Media, t: number) => m.stabilizer.correctionAt(t, { ...WORLD_STABILIZE, axisMap: DEFAULT_AXIS_MAP });

async function film(src: Media, lens: SourceLens, path: Path, name: string): Promise<{ file: string; orientation: OrientationData; at: number[] }> {
  const W = 1920, H = 1080;
  const canvas = new OffscreenCanvas(W, H);
  const r = await ReframeRenderer.create(canvas);
  r.setLayout(src.layout);
  const pic = new OffscreenCanvas(W, H), ctx = pic.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(pic, { codec: 'avc', bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 0.5 });
  output.addVideoTrack(source, { frameRate: src.fps });
  await output.start();
  const times = src.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).filter((t) => t >= FROM * S - 1 && t <= (FROM + LONG) * S);
  const decs = src.tracks.map((t) => new TrackDecoder(src.reader, t));
  decs.forEach((d) => { d.maxAhead = 6; d.seek(times[0]!); });
  const cori: OrientationData['cori'] = [], grav: OrientationData['grav'] = [];
  for (const [i, t] of times.entries()) {
    let fr: (VideoFrame | null)[] = [];
    for (let k = 0; ; k++) { for (const d of decs) void d.pump(); fr = decs.map((d) => d.frameAt(t)); if (fr.every(Boolean)) break; if (k > 4000) throw new Error('decode'); await sleep(2); }
    const M = path(t / S - FROM);
    r.resetHistory();
    r.pushFrame({ frames: fr as [VideoFrame, VideoFrame], mode: '360', view: { yaw: 0, pitch: 0, roll: 0, fov: lens.hfov, fisheye: 0 }, correction: mulMat(transpose(M), steady360(src, t)), lens, outputLens: 'source' });
    presentLook(r, look({}));
    ctx.drawImage(await createImageBitmap(canvas), 0, 0);
    await source.add(i / src.fps, 1 / src.fps);
    const us = (i / src.fps) * S;
    cori.push({ t: us, q: quatOf(mulMat(mulMat(P, M), P)) });
    grav.push({ t: us, v: mulVec(P, mulVec(transpose(M), [0, -1, 0])) });
  }
  decs.forEach((d) => d.close());
  r.destroy();
  await output.finalize();
  const { fixtures } = await ace.info();
  const file = await ace.writeFile(`${fixtures}/synthetic/virtual-${name}.mp4`, new Uint8Array((output.target as BufferTarget).buffer!));
  return { file, orientation: { grav, cori, streams: [] }, at: times };
}

const pixels = async (c: OffscreenCanvas) => {
  const o = new OffscreenCanvas(c.width, c.height), x = o.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(await createImageBitmap(c), 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
};
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!); return s / ((a.length / 4) * 3); };
const blackEdge = (a: Uint8ClampedArray, w: number, h: number) => { let n = 0, k = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { n++; const i = (y * w + x) * 4; if (a[i]! + a[i + 1]! + a[i + 2]! < 4) k++; } return k / n; };

export async function followCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const src = await getMedia((await ace.listFixtures()).find((f) => f.endsWith('GS010120.360'))!);
  const lens = lensFor({ model: 'HERO12 Black', fovMode: 'W' }, 3840, 2160);
  const open = async (path: Path, name: string) => {
    const f = await film(src, lens, path, name);
    const media = await getMedia(f.file);
    Object.assign(media, { lens, stabilizer: new Stabilizer(f.orientation), camera: { model: 'HERO12 Black' } });
    return { ...f, media, times: media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b) };
  };
  type Clip = Awaited<ReturnType<typeof open>>;
  const base = (m: Media, o: Partial<TimelineClip> = {}): TimelineClip => ({ ...newClip(m.path, m.durationUs, false), id: `f${Math.random()}`, lensMode: 'custom', look: look({ fov: 95 }), ...o });
  const st = (o: Partial<TimelineClip['stabilize']>) => ({ smoothing: 'off' as const, horizon: false, ...o });
  const W = 480, H = 270;

  /** Draws a clip at many moments and compares each with the same view straight from the 360 file. */
  const compare = async (v: Clip, path: Path, clip: TimelineClip, w = W, h = H, label?: string) => {
    const { media } = v;
    await cropReady(clip, media, w / h);
    const canvas = new OffscreenCanvas(w, h);
    const r = await ReframeRenderer.create(canvas);
    let err = 0, n = 0, black = 0, tilt = 0, minFov = 999, maxFov = 0, minLevel = 1, zoomStep = 0, last = 0, turnJerk = 0;
    const axes: Vec3[] = [];
    const sheet: ImageBitmap[] = [];
    for (let i = 0; i < v.times.length; i++) {
      const t = v.times[i]!;
      const lk = clipLookAt(clip, t), shot = flatShot(clip, media, lk, t, w / h)!;
      const cam = media.turns ? mulMat(path(v.at[i]! / S - FROM), rotZ((media.turns * Math.PI) / 2)) : path(v.at[i]! / S - FROM);
      const M = mulMat(cam, sampleMatrix({ yaw: shot.yaw, pitch: shot.pitch, roll: lk.roll }, shot.correction));
      // The view's right-hand side in the world: level when it doesn't point up or down.
      tilt = Math.max(tilt, Math.abs(Math.asin(M[3])) / RAD);
      axes.push([M[2], M[5], M[8]]);
      minLevel = Math.min(minLevel, shot.level);
      minFov = Math.min(minFov, shot.fov); maxFov = Math.max(maxFov, shot.fov);
      if (last) zoomStep = Math.max(zoomStep, Math.abs(Math.log(shot.fov / last)));
      last = shot.fov;
      if (i % 6 !== 3) continue;
      const a = await framesAt(media, t);
      r.setLayout(null);
      r.resetHistory();
      pushClipFrame(r, clip, media, t, a.frames);
      presentLook(r, look({}));
      const px = await pixels(canvas);
      if (label && i % 12 === 3) sheet.push(await createImageBitmap(canvas));
      a.close();
      const b = await framesAt(src, v.at[i]!);
      const pic = media.width / media.height, across = Math.min(1, w / h / pic);
      const e = effectiveLens({ fov: shot.fov, fisheye: lk.fisheye, autoLens: true });
      const half = lensInverse(e.k, lensForward(e.k, (e.fov * RAD) / 2) * across);
      r.setLayout(src.layout);
      r.resetHistory();
      r.pushFrame({ frames: b.frames as [VideoFrame, VideoFrame], mode: '360', view: { yaw: shot.yaw, pitch: shot.pitch, roll: lk.roll, fov: (2 * half) / RAD, fisheye: lk.fisheye, autoLens: false }, correction: mulMat(mulMat(shot.correction, transpose(cam)), steady360(src, v.at[i]!)) });
      presentLook(r, look({}));
      err += diff(px, await pixels(canvas));
      b.close();
      black = Math.max(black, blackEdge(px, w, h));
      n++;
    }
    r.destroy();
    // (Once a followed view has eased onto the subject.)
    for (let i = clip.track ? Math.round(2 * media.fps) : 2; i < axes.length; i++) turnJerk = Math.max(turnJerk, Math.abs(angle(axes[i]!, axes[i - 1]!) - angle(axes[i - 1]!, axes[i - 2]!)));
    if (label) {
      const c = new OffscreenCanvas(4 * 320, Math.ceil(sheet.length / 4) * Math.round((320 * h) / w)), x = c.getContext('2d')!;
      sheet.forEach((b, k) => { const hh = Math.round((320 * h) / w); x.drawImage(b, (k % 4) * 320, Math.floor(k / 4) * hh, 320, hh); });
      await ace.writeFile(await ace.selftestOut(`follow-${label}.png`), new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    }
    return { err: +(err / n).toFixed(2), black, tilt: +tilt.toFixed(2), level: +minLevel.toFixed(2), fov: `${minFov.toFixed(0)}–${maxFov.toFixed(0)}`, zoomStep: +(zoomStep * 100).toFixed(2), jerk: +turnJerk.toFixed(2) };
  };

  // --- Horizon ----------------------------------------------------------------------------------------
  const ride = await open(filming, 'ride');
  const plain = await compare(ride, filming, base(ride.media));
  const level = await compare(ride, filming, base(ride.media, { look: look({ fov: 70 }), stabilize: st({ horizon: true }) }), W, H, 'level');
  const panned = await compare(ride, filming, base(ride.media, { look: look({ fov: 45, yaw: 16, pitch: 8 }), stabilize: st({ horizon: true }) }));
  const both = await compare(ride, filming, base(ride.media, { look: look({ fov: 70 }), stabilize: st({ horizon: true, smoothing: 'high', maxCrop: 0.7 }) }));
  const rolled = await compare(ride, filming, base(ride.media, { look: look({ fov: 45, roll: 10 }), stabilize: st({ horizon: true, smoothing: 'medium' }) }));
  const tight = await compare(ride, filming, base(ride.media, { look: look({ fov: 95 }), stabilize: st({ horizon: true, smoothing: 'medium', maxCrop: 0.12 }) }));
  const tall = await compare(ride, filming, base(ride.media, { look: look({ fov: 70 }), stabilize: st({ horizon: true, smoothing: 'medium' }) }), 270, 480);
  const whole = await compare(ride, filming, base(ride.media, { lensMode: 'source', look: look({ fov: lens.hfov }), stabilize: st({ horizon: true, maxCrop: 0.6 }) }));
  Object.assign(out, { plain, level, panned, both, rolled, tight, tall, whole });
  ok('without leveling the horizon tilts', plain.tilt > 12, plain.tilt);
  ok('leveled: the horizon is level at every frame', level.tilt < 0.1 && level.level === 1, level.tilt);
  ok('leveled while panned', panned.tilt < 0.1, panned.tilt);
  ok('leveled and stabilized', both.tilt < 0.1, both.tilt);
  ok('own roll is added on top', Math.abs(rolled.tilt - 10) < 0.3, rolled.tilt);
  ok('the crop limit holds leveling back, gently', tight.level < 0.9 && tight.tilt > 1 && tight.tilt < plain.tilt && tight.zoomStep < 2, [tight.level, tight.tilt, tight.zoomStep]);
  ok('leveled in vertical', tall.tilt < 0.1, tall.tilt);
  ok('leveled with the original lens', whole.tilt < 0.1, whole.tilt);
  // (The original lens has no plain 360 view to compare with.)
  for (const [n, c] of Object.entries({ plain, level, panned, both, rolled, tight, tall })) { ok(`${n}: picture matches the 360 truth`, c.err < 3.2, c.err); ok(`${n}: no edges`, c.black === 0, c.black); }
  ok('original lens: no edges', whole.black === 0, whole.black);
  // The same file, as if the camera had been held upright.
  const up = lensFor({ model: 'HERO12 Black', fovMode: 'W' }, 2160, 3840);
  const turned: Clip = { ...ride, media: { ...ride.media, turns: 1, width: 1080, height: 1920, lens: up } };
  for (const q of [1, 3]) {
    turned.media.turns = q;
    const t1 = await compare(turned, filming, base(turned.media, { look: look({ fov: 40 }), stabilize: st({ smoothing: 'medium' }) }), 270, 480);
    const t2 = await compare(turned, filming, base(turned.media, { look: look({ fov: 30 }), stabilize: st({ smoothing: 'medium', horizon: true, maxCrop: 0.8 }) }), 270, 480);
    Object.assign(out, { [`turned ${q}`]: t1, [`turned ${q}, leveled`]: t2 });
    ok(`turned ${q}: stabilized picture matches the 360 truth`, t1.err < 4 && t1.black === 0, t1);
  }

  // --- Subject tracking --------------------------------------------------------------------------------
  const score = (v: Clip, path: Path, pts: { t: number; yaw: number; pitch: number; size?: number }[], from: number) => {
    let good = 0, n = 0;
    const errs: string[] = [];
    for (const [ts, y, p, size] of RIDER_TRUTH) {
      const s = ts - FROM;
      if (s < from + 0.2 || s > LONG - 0.05) continue;
      const k = v.at.findIndex((a) => a >= ts * S - 1);
      if (k < 0) continue;
      const t = v.times[k]!;
      const cam = mulVec(transpose(path(v.at[k]! / S - FROM)), dirOf(y, p));
      const w = anglesOf(mulVec(flatWorld(v.media, t), cam));
      const q = worldInPicture(v.media, base(v.media), t)(w.yaw, w.pitch);
      if (!q.inside || Math.abs(q.x) > 0.95 || Math.abs(q.y) > 0.95) { errs.push(`${ts}:out`); continue; }
      n++;
      const pt = pts.find((x) => x.t >= t - 1);
      if (!pt) { errs.push(`${ts}:lost`); continue; }
      const e = angle(dirOf(w.yaw, w.pitch), dirOf(pt.yaw, pt.pitch));
      if (e < Math.max(2.5, size * 0.6)) good++;
      errs.push(`${ts}:${e.toFixed(1)}(${size},${(pt.size ?? 0).toFixed(0)})`);
    }
    return { good, n, errs: errs.join(' ') };
  };
  const follow = async (v: Clip, path: Path, startS: number, size: number) => {
    const k = v.at.findIndex((a) => a >= startS * S - 1), t = v.times[k]!;
    const tr = riderTruthAt(v.at[k]! / S);
    const w = anglesOf(mulVec(flatWorld(v.media, t), mulVec(transpose(path(v.at[k]! / S - FROM)), dirOf(tr[1], tr[2]))));
    const t0 = performance.now();
    const res = await trackSubject({ clip: base(v.media), media: v.media, startUs: t, yaw: w.yaw, pitch: w.pitch, sizeDeg: size, world: true }, () => {}, new AbortController().signal);
    const last = res.points.at(-1)!.t;
    return { res, sc: score(v, path, res.points, t / S), left: res.left, lostAt: res.lostAt && +(res.lostAt / S).toFixed(2), upTo: +(last / S).toFixed(2), focus: +(res.motionFocus ?? 0).toFixed(2), speed: +((last - t) / 1e3 / (performance.now() - t0)).toFixed(2) };
  };
  const starts: [number, number][] = [[4.67, 8], [5.17, 8], [5.42, 8], [6.17, 14], [7.42, 26], [8.43, 10]];
  const bare: Clip = { ...ride, media: { ...ride.media, stabilizer: new Stabilizer(null) } };
  let main: ClipTrack | null = null;
  for (const [name, v] of [['with motion data', ride], ['without motion data', bare]] as [string, Clip][]) {
    let good = 0, n = 0;
    const rows: Record<string, unknown> = {};
    for (const [s0, size] of starts) {
      const f = await follow(v, filming, s0, size);
      good += f.sc.good; n += f.sc.n;
      rows[`${s0}s ${size}°`] = { on: `${f.sc.good}/${f.sc.n}`, lostAt: f.lostAt, left: f.left, focus: f.focus, speed: f.speed, errs: f.sc.errs };
      if (v === ride && s0 === 5.17) main = { space: 'world', points: f.res.points, smoothing: 0.25, offsetYaw: 0, offsetPitch: 0, autoZoom: 1 };
    }
    out[`tracking ${name}`] = `${good}/${n}`;
    out[`tracking ${name}, details`] = rows;
    ok(`tracking ${name}`, good >= n * (v === ride ? 0.97 : 0.7), [good, n]);
  }
  // Things that don't move must not look like movers just because the camera shakes.
  {
    const focus: Record<string, string> = {};
    for (const [name, v] of [['with', ride], ['without', bare]] as [string, Clip][]) {
      const got: string[] = [];
      for (const s0 of [0.6, 1.4, 2.3, 3.4, 4.4]) for (const [x, y, size] of [[-0.55, 0.1, 10], [0.6, 0.15, 10], [-0.6, -0.35, 14], [0.55, -0.4, 7]] as const) {
        const i = v.times.findIndex((t) => t >= s0 * S);
        const cam = pictureToDir(lens, x, y);
        // (Not on the rider.)
        const tr = riderTruthAt(v.at[i]! / S);
        if (angle(mulVec(filming(v.at[i]! / S - FROM), cam), dirOf(tr[1], tr[2])) < size / 2 + tr[3] + 5) continue;
        const d = anglesOf(mulVec(flatWorld(v.media, v.times[i]!), cam));
        const c = { ...base(v.media), outUs: v.times[Math.min(v.times.length - 1, i + 12)]! };
        const res = await trackSubject({ clip: c, media: v.media, startUs: v.times[i]!, yaw: d.yaw, pitch: d.pitch, sizeDeg: size, world: true }, () => {}, new AbortController().signal);
        got.push((res.motionFocus ?? 0).toFixed(2));
      }
      focus[name] = got.join(' ');
    }
    out['movement focus of still things'] = focus;
  }
  const stand = await open(standing, 'standing');
  const gone = await follow(stand, standing, 5.17, 8);
  Object.assign(out, { gone: { on: `${gone.sc.good}/${gone.sc.n}`, lostAt: gone.lostAt, left: gone.left, errs: gone.sc.errs } });
  ok('a subject that leaves the picture is let go, and said so', gone.left === true && gone.sc.good >= gone.sc.n - 1, gone.sc);

  // --- The followed view ---------------------------------------------------------------------------------
  if (main) {
    const m = ride.media;
    const withTrack = (o: Partial<TimelineClip>, tr: Partial<ClipTrack> = {}) => { const c = base(m, o); const t = { ...main!, ...tr }; t.subjectFrac = fitSubjectFrac(t, 8 / 60, 0, shareOf(m, c)); return { ...c, track: { ...t, ...tr } }; };
    const views: Record<string, [TimelineClip, number, number]> = {
      'followed': [withTrack({ look: look({ fov: 95 }) }), W, H],
      'followed, steady and level': [withTrack({ look: look({ fov: 95 }), stabilize: st({ smoothing: 'medium', horizon: true }) }), W, H],
      'followed, original lens': [withTrack({ lensMode: 'source', look: look({ fov: lens.hfov }), stabilize: st({ smoothing: 'medium', horizon: true }) }), W, H],
      'followed, vertical': [withTrack({ look: look({ fov: 95 }), stabilize: st({ smoothing: 'medium', horizon: true }) }), 270, 480],
      'followed, wide': [withTrack({ look: look({ fov: 95 }), stabilize: st({ smoothing: 'medium' }) }, { autoZoom: 0 }), W, H],
      'followed, bars': [withTrack({ fit: 'fit', look: look({ fov: 60 }), stabilize: st({ smoothing: 'medium' }) }, { autoZoom: 0 }), 270, 480],
    };
    for (const [name, [clip, w, h]] of Object.entries(views)) {
      const c = await compare(ride, filming, clip, w, h, name.replace(/[^a-z]+/g, '-'));
      // Where the rider really is in the output.
      let off = 0, n = 0, inView = 0;
      for (const [ts, y, p] of RIDER_TRUTH) {
        const k = ride.at.findIndex((a) => a >= ts * S - 1);
        if (k < 0 || ts < 6) continue;
        const t = ride.times[k]!;
        const lk = clipLookAt(clip, t), shot = flatShot(clip, m, lk, t, w / h)!;
        const d = mulVec(transpose(sampleMatrix({ yaw: shot.yaw, pitch: shot.pitch, roll: lk.roll }, shot.correction)), mulVec(transpose(filming(ride.at[k]! / S - FROM)), dirOf(y, p)));
        const e = angle(d, [0, 0, 1]) / (shot.fov / 2);
        off += e; n++;
        if (e < 0.75) inView++;
      }
      out[name] = { ...c, offCentre: +(off / n).toFixed(2), inView: `${inView}/${n}` };
      ok(`${name}: no edges`, w === 270 && clip.fit === 'fit' ? true : c.black === 0, c.black);
      if (clip.lensMode === 'custom' && clip.fit === 'fill') ok(`${name}: picture matches the 360 truth`, c.err < 4, c.err);
      ok(`${name}: the rider stays in view`, inView >= n - 1, [inView, n]);
      ok(`${name}: calm`, c.zoomStep < 6 && c.jerk < 1.2, [c.zoomStep, c.jerk]);
      if (clip.stabilize.horizon) ok(`${name}: level`, c.tilt < 0.2 || c.level < 1, [c.tilt, c.level]);
    }
    await exportTimeline(addClip(emptyTimeline(), views['followed, steady and level']![0], 0), { path: await ace.selftestOut('follow.mp4'), resolution: 720, fps: 24, codec: 'avc', quality: 'high' }, () => {}, new AbortController().signal);
  }

  // --- In the app: draw a box on the preview ---------------------------------------------------------------
  await api.importPaths([ride.file]);
  const c0: TimelineClip = { ...newClip(ride.file, ride.media.durationUs, false), lensMode: undefined };
  api.setTimeline(addClip(emptyTimeline(), c0, 0));
  api.player.seek(0.76 * S);
  await sleep(1200);
  const tShown = api.lastResult()!.layers![0]!.frames[0]!.timestamp;
  const k = ride.times.findIndex((t) => Math.abs(t - tShown) < 2000);
  const tr = riderTruthAt(ride.at[k]! / S);
  const cam = mulVec(transpose(filming(ride.at[k]! / S - FROM)), dirOf(tr[1], tr[2]));
  const w = anglesOf(mulVec(flatWorld(ride.media, tShown), cam));
  const q = worldInPicture(ride.media, base(ride.media), tShown)(w.yaw, w.pitch);
  const fr = document.querySelector('.frame') as HTMLElement;
  const px = ((q.x + 1) / 2) * fr.clientWidth, py = ((1 - q.y) / 2) * fr.clientHeight, half = (4 / lens.hfov) * fr.clientWidth;
  await api.trackBox!({ x0: px - half, y0: py - half, x1: px + half, y1: py + half });
  const done = api.getTimeline().clips[0]!;
  const sc = done.track ? score(ride, filming, done.track.points, tShown / S) : { good: 0, n: 1, errs: 'no track' };
  ok('drawing a box on an untouched clip follows the rider', sc.good >= sc.n - 1 && done.lensMode === 'source', [sc, done.lensMode]);
  const l1 = clipLookAt(done, 2.75 * S);
  ok('it zooms in so there is room to follow', l1.fov <= lens.hfov * 0.82, [l1.fov, lens.hfov]);
  api.player.seek(2.6 * S);
  await sleep(900);
  document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
  await sleep(300);
  for (const id of ['Subject tracking', 'Horizon', 'Crop']) { const s = document.querySelector<HTMLElement>(`[data-section="${id}"] .section-toggle`); if (s?.getAttribute('aria-expanded') === 'false') { s.click(); await sleep(150); } }
  const has = (l: string) => !!document.querySelector(`input[aria-label="${l}"]`);
  ok('tracking controls are there', ['Auto zoom', 'Subject size', 'Widest zoom', 'Shift across', 'Smoothness'].every(has), ['Auto zoom', 'Subject size', 'Widest zoom', 'Shift across', 'Smoothness'].filter((l) => !has(l)));
  document.querySelector<HTMLElement>('.dock-tab[data-panel="stabilize"]')?.click();
  await sleep(300);
  for (const id of ['Horizon', 'Crop']) { const e = document.querySelector<HTMLElement>(`[data-section="${id}"] .section-toggle`); if (e?.getAttribute('aria-expanded') === 'false') { e.click(); await sleep(150); } }
  const hz = [...document.querySelectorAll<HTMLElement>('label.check')].find((e) => e.textContent?.includes('Level horizon'))!.querySelector('input')!;
  ok('Level horizon can be ticked', !hz.disabled);
  hz.click();
  await sleep(600);
  ok('ticking it levels', api.getTimeline().clips[0]!.stabilize.horizon === true);
  await ace.capture('follow-ui');
  // Plays smoothly.
  api.player.seek(0);
  await sleep(900);
  const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
  api.player.play();
  await sleep(5000);
  api.player.pause();
  const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
  ok('plays in real time', speed > 0.95 && api.player.stalls - s0 < 6, [+speed.toFixed(3), api.player.stalls - s0]);
  return { fails, ...out };
}

/** Real clips: leveling before / after, and something still in the room followed. */
export async function realFollow() {
  const out: Record<string, unknown> = {};
  for (const name of ['GX010132.MP4', 'GX010133.MP4']) {
    const m = await getMedia((await ace.listFixtures()).find((f) => f.endsWith(name))!);
    const all = m.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
    // How consistent gravity and orientation are, and how far the camera leans.
    let lean = 0, worst = 0;
    const leans: number[] = [];
    for (const t of all) { const g = m.stabilizer.gravityIn(t, { axisMap: DEFAULT_AXIS_MAP })!; const a = Math.atan2(g[0], -g[1]) / RAD; leans.push(a); lean += a; worst = Math.max(worst, Math.abs(a)); }
    out[`${name} lean`] = { mean: +(lean / all.length).toFixed(1), most: +worst.toFixed(1), gravityFit: m.stabilizer.coriFit, gps: m.telemetry.gpsRange, accel: m.telemetry.accelRange, speed: m.telemetry.gpsRange };
    // The moments it leans most, as filmed and leveled.
    const picks = [...all.keys()].sort((a, b) => leans[b]! - leans[a]!);
    const at = [picks[0]!, picks[Math.floor(picks.length * 0.25)]!, picks[Math.floor(picks.length * 0.75)]!, picks.at(-1)!].map((i) => all[i]!);
    const W = 480, H = 270, cv = new OffscreenCanvas(W, H), r = await ReframeRenderer.create(cv);
    const sheet = new OffscreenCanvas(4 * W, 2 * H), x = sheet.getContext('2d')!;
    const c0: TimelineClip = { ...newClip(m.path, m.durationUs, false), id: `h${name}`, lensMode: 'custom', look: look({ fov: 80 }) };
    const c1: TimelineClip = { ...c0, id: `l${name}`, stabilize: { smoothing: 'off', horizon: true, maxCrop: 0.7 } };
    for (const [row, c] of [c0, c1].entries()) {
      await cropReady(c, m, W / H);
      for (const [k, t] of at.entries()) {
        const { frames, close } = await framesAt(m, t);
        pushClipFrame(r, c, m, t, frames);
        presentLook(r, look({}));
        x.drawImage(await createImageBitmap(cv), k * W, row * H);
        x.fillStyle = '#fff'; x.font = '16px sans-serif';
        x.fillText(`${(t / S).toFixed(2)}s ${row ? 'leveled' : `lean ${leans[all.indexOf(t)]!.toFixed(0)}°`}`, k * W + 8, row * H + 20);
        close();
      }
    }
    await ace.writeFile(await ace.selftestOut(`level-${name.slice(0, 8)}.png`), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    // Follow whatever is at a few places of the picture at 2 s; drawn centred at 8 moments.
    const t0 = all.find((t) => t >= 2 * S)!;
    const back = worldInPicture(m, c0, t0);
    void back;
    const rows: ImageBitmap[][] = [];
    const places: [number, number, number][] = [[0, 0, 12], [-0.35, 0.1, 12], [0.4, 0.05, 12]];
    for (const [px, py, size] of places) {
      const d = anglesOf(mulVec(flatWorld(m, t0), pictureToDir(m.lens!, px, py)));
      const res = await trackSubject({ clip: { ...c0, outUs: Math.min(m.durationUs, t0 + 8 * S) }, media: m, startUs: t0, yaw: d.yaw, pitch: d.pitch, sizeDeg: size, world: true }, () => {}, new AbortController().signal);
      const far = Math.max(...res.points.map((q) => angle(dirOf(q.yaw, q.pitch), dirOf(d.yaw, d.pitch))));
      out[`${name} follow ${px},${py}`] = { points: res.points.length, upTo: +(res.points.at(-1)!.t / S).toFixed(2), lostAt: res.lostAt && +(res.lostAt / S).toFixed(2), left: res.left, movedDeg: +far.toFixed(1), focus: res.motionFocus };
      const track: ClipTrack = { space: 'world', points: res.points, smoothing: 0.1, offsetYaw: 0, offsetPitch: 0, ease: 0 };
      const cc: TimelineClip = { ...c0, id: `t${name}${px}`, look: look({ fov: 45 }), stabilize: { smoothing: 'medium', horizon: true, maxCrop: 0.6 }, track };
      await cropReady(cc, m, W / H);
      const line: ImageBitmap[] = [];
      for (let k = 0; k < 8; k++) {
        const q = res.points[Math.floor(((res.points.length - 1) * k) / 7)]!;
        const { frames, close } = await framesAt(m, q.t);
        pushClipFrame(r, cc, m, q.t, frames);
        presentLook(r, look({}));
        line.push(await createImageBitmap(cv));
        close();
      }
      rows.push(line);
    }
    const s2 = new OffscreenCanvas(8 * 240, rows.length * 135), y = s2.getContext('2d')!;
    rows.forEach((l, j) => l.forEach((b, k) => { y.drawImage(b, k * 240, j * 135, 240, 135); y.strokeStyle = '#35e0ff'; y.strokeRect(k * 240 + 117, j * 135 + 64, 6, 6); }));
    await ace.writeFile(await ace.selftestOut(`realfollow-${name.slice(0, 8)}.png`), new Uint8Array(await (await s2.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    r.destroy();
  }
  return out;
}

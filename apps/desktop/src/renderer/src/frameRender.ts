// One rendering step shared by preview, export and frame grabs, so they always match.

import { bakeCurves, curvesUsed, denoiseFrames, denoiseOn, filmLut, qualifierUniforms, wheelsNeutral, wheelUniforms, DEFAULT_CROP, NO_EFFECTS, NEUTRAL_GRADE, withOff, applyTrack, fisheyeForLook, type OwnLens, blurFrames, lookAt, curveOf, trackWeight, type Look, type ShareOf, type TimelineClip } from '@ace/project';
import { cropAt, DEFAULT_AXIS_MAP, planCrop, smoothUnder, type CropPlan, type CropRequest } from '@ace/telemetry';
import type { Lut3D, PresentInput, ReframeRenderer, RenderMode } from '@ace/media360';
import { inputFor } from './color';
import { mediaNow, type Media } from './media';
import { adjustLens, BORDER, dirToPicture, flatRay, frameShare, IDENTITY, insideFov, matPower, pictureToDir, reachX, rotZ, SHUTTER_ROWS, type Mat3, mulMat, mulVec, planeScale, sampleMatrix, transpose, viewRotation, type FlatView, type SourceLens, type Vec3 } from '@ace/media360';

const RAD = Math.PI / 180;
const dirOf = (yaw: number, pitch: number): Vec3 => [Math.cos(pitch * RAD) * Math.sin(yaw * RAD), Math.sin(pitch * RAD), Math.cos(pitch * RAD) * Math.cos(yaw * RAD)];
const anglesOf = (d: Vec3) => ({ yaw: Math.atan2(d[0], d[2]) / RAD, pitch: Math.asin(Math.max(-1, Math.min(1, d[1]))) / RAD });
/**
 * World-steady frame used for subject tracking: fully locked and level, so head turns are
 * removed and people / bikes stay upright in the tracker's view.
 */
export const WORLD_STABILIZE = { smoothing: 'locked' as const, horizon: true };

/**
 * Converts a view direction between a clip's own view frame (its stabilisation settings) and
 * the world-steady frame. The renderer samples camera direction d = Cᵀ·v for view direction v,
 * so v_clip = C_clip · C_worldᵀ · v_world.
 */
export function worldToClipView(media: Media, clip: TimelineClip, t: number, yaw: number, pitch: number) {
  if (media.lens) return anglesOf(mulVec(mulMat(flatShake(media, clip, t), transpose(flatWorld(media, t))), dirOf(yaw, pitch)));
  if (!media.is360) return { yaw, pitch };
  const Cw = media.stabilizer.correctionAt(t, { ...WORLD_STABILIZE, axisMap: DEFAULT_AXIS_MAP });
  const Cc = media.stabilizer.correctionAt(t, { ...clip.stabilize, axisMap: DEFAULT_AXIS_MAP });
  return anglesOf(mulVec(mulMat(Cc, transpose(Cw)), dirOf(yaw, pitch)));
}
export function clipViewToWorld(media: Media, clip: TimelineClip, t: number, yaw: number, pitch: number) {
  if (media.lens) return anglesOf(mulVec(mulMat(flatWorld(media, t), transpose(flatShake(media, clip, t))), dirOf(yaw, pitch)));
  if (!media.is360) return { yaw, pitch };
  const Cw = media.stabilizer.correctionAt(t, { ...WORLD_STABILIZE, axisMap: DEFAULT_AXIS_MAP });
  const Cc = media.stabilizer.correctionAt(t, { ...clip.stabilize, axisMap: DEFAULT_AXIS_MAP });
  return anglesOf(mulVec(mulMat(Cw, transpose(Cc)), dirOf(yaw, pitch)));
}

// --- Regular (non-360) clips ------------------------------------------------------------------------

const lensCache = new WeakMap<object, SourceLens>();
/** The lens of a regular clip, with the user's correction. Null for 360 footage. */
export function clipLens(media: Media, clip: TimelineClip): SourceLens | null {
  if (!media.lens) return null;
  if (!clip.lensFix) return media.lens;
  let l = lensCache.get(clip.lensFix);
  if (!l) lensCache.set(clip.lensFix, (l = adjustLens(media.lens, clip.lensFix)));
  return l;
}
/** Whether the view can be moved and zoomed at all. */
export const canReframe = (media: Media) => media.is360 || !!media.lens;

/** A clip that was never reframed shows the whole picture, whatever its stored view says. */
const asShot = (look: Look, lens: SourceLens): Look => ({ ...look, yaw: 0, pitch: 0, roll: 0, fov: lens.hfov, fisheye: 0 });
const settle = (clip: TimelineClip, look: Look): Look => {
  if (clip.lensMode) return look;
  const media = mediaNow(clip.mediaPath);
  const lens = media && clipLens(media, clip);
  return lens ? asShot(look, lens) : look;
};
/** Makes a regular clip ready to be reframed (keeping what it looks like). */
export function adoptReframe(clip: TimelineClip): TimelineClip {
  const media = mediaNow(clip.mediaPath);
  const lens = media && clipLens(media, clip);
  if (clip.lensMode || !lens) return clip;
  return { ...clip, lensMode: 'source', look: asShot(clip.look, lens), keyframes: clip.keyframes.map((k) => ({ ...k, look: asShot(k.look, lens) })) };
}

/** The look kept while zooming, where it applies (360 clips, and regular ones through a chosen lens). */
export const lensLookOf = (clip: TimelineClip) => (clip.lensLook && (clip.lensMode === 'custom' || !mediaNow(clip.mediaPath)?.lens) ? clip.lensLook : undefined);
/** The clip's own fisheye: fixed, or following the field of view. */
const ownLens = (clip: TimelineClip, look: Look): OwnLens => { const l = lensLookOf(clip); return l ? (fov: number) => fisheyeForLook(l, fov) : look.fisheye; };

/** The clip's own look (keyframes or settings), without what tracking does to it. */
export const ownLookAt = (clip: TimelineClip, mediaUs: number): Look => {
  const look = settle(clip, lookAt(clip.keyframes, clip.look, mediaUs));
  const l = lensLookOf(clip);
  return l ? { ...look, fisheye: fisheyeForLook(l, look.fov) } : look;
};

const sourceShare = new WeakMap<SourceLens, ShareOf>();
/**
 * Share of the picture's width a subject fills (regular clips: of the recorded picture's width,
 * so cropping to another shape keeps the subject the same height).
 */
export function shareOf(media: Media | null | undefined, clip: TimelineClip): ShareOf {
  const lens = media && clipLens(media, clip);
  if (!lens || clip.lensMode === 'custom') return frameShare;
  let f = sourceShare.get(lens);
  if (!f) sourceShare.set(lens, (f = (size, fov) => reachX(lens, Math.min(size, fov) / 2) / reachX(lens, fov / 2)));
  return f;
}

/** The clip's look at a media time: keyframes, then subject tracking (pan/tilt). */
export function clipLookAt(clip: TimelineClip, mediaUs: number): Look {
  const look = ownLookAt(clip, mediaUs);
  if (!clip.track) return look;
  const media = mediaNow(clip.mediaPath);
  return applyTrack(look, clip.track, mediaUs, media ? (y, p, t) => worldToClipView(media, clip, t, y, p) : undefined, shareOf(media, clip), ownLens(clip, look));
}

/** The view of a regular clip as the lens code wants it, and how the output maps onto the picture. */
export function flatView(clip: TimelineClip, look: Look): FlatView {
  return { fov: look.fov, fisheye: look.fisheye, lens: clip.lensMode === 'custom' ? 'custom' : 'source' };
}
const pictureAspect = (media: Media) => media.width / media.height;
/** How output points map onto the picture when checking for exposed edges. */
const edgeScale = (clip: TimelineClip, media: Media, outAspect: number): [number, number] =>
  clip.fit === 'fill' ? planeScale(outAspect, pictureAspect(media), 'fill') : [1, 1];

const shakes = (media: Media, clip: TimelineClip) => !!media.lens && !!clip.lensMode && clip.stabilize.smoothing !== 'off' && media.stabilizer.hasOrientation;
const levels = (media: Media, clip: TimelineClip) => !!media.lens && !!clip.lensMode && clip.stabilize.horizon && media.stabilizer.hasGravity;
/** Whether a regular clip's picture is being turned by stabilisation or horizon leveling. */
export const flatStabilized = (media: Media, clip: TimelineClip) => shakes(media, clip) || levels(media, clip);
/** Whether its view needs planning ahead: turned, or following a subject around the picture. */
const planned = (media: Media, clip: TimelineClip) => flatStabilized(media, clip) || (!!media.lens && !!clip.lensMode && !!clip.track);
/**
 * Cameras whose recordings come out with rolling shutter already corrected. Measured on real
 * Max 2 footage (HyperSmooth off): matched points fit best with no correction at all.
 */
export const shutterDoneInCamera = (media: Media) => !!media.camera.stabilizedInCamera || /\bmax/i.test(media.camera.model ?? '');
const rolling = (media: Media, clip: TimelineClip) => shakes(media, clip) && clip.stabilize.rolling === true && !shutterDoneInCamera(media) && !!media.camera.readoutMs && media.turns === 0;

// The picture may be stored turned (camera held upright); sensors report the camera's own axes.
const Q = [0, 1, 2, 3].map((q) => rotZ((q * Math.PI) / 2));
const asShown = (media: Media, C: Mat3): Mat3 => (media.turns ? mulMat(mulMat(transpose(Q[media.turns & 3]!), C), Q[media.turns & 3]!) : C);

/** Stabilising turn of a regular clip (no horizon): picture directions → steady directions. */
const flatShake = (media: Media, clip: TimelineClip, t: number): Mat3 =>
  shakes(media, clip) ? asShown(media, media.stabilizer.correctionAt(t, { ...clip.stabilize, horizon: false, axisMap: DEFAULT_AXIS_MAP })) : IDENTITY;
/** Picture directions → the world-steady frame (fully locked and level when the camera's data allows). */
export const flatWorld = (media: Media, t: number): Mat3 => {
  const C = media.stabilizer.correctionAt(t, { ...WORLD_STABILIZE, axisMap: DEFAULT_AXIS_MAP });
  return !media.turns ? C : media.stabilizer.hasGravity ? mulMat(C, Q[media.turns & 3]!) : asShown(media, C);
};
/** Which way is down, in picture directions. */
const flatDown = (media: Media, t: number): Vec3 | null => {
  const g = media.stabilizer.gravityIn(t, { axisMap: DEFAULT_AXIS_MAP });
  return g && (media.turns ? mulVec(transpose(Q[media.turns & 3]!), g) : g);
};

/** What the sensors say about a moment of a regular clip. */
interface Moment { shake: Mat3; down: Vec3 | null }
const momentAt = (media: Media, clip: TimelineClip, t: number): Moment => ({ shake: flatShake(media, clip, t), down: levels(media, clip) ? flatDown(media, t) : null });

/**
 * Rolls a view about its own axis until the horizon is level, so it stays level wherever the
 * view is panned. (Tilt is left alone: regular clips have no picture to spare for it.) Looking
 * almost straight up or down there is no horizon: the leveling fades out.
 */
function levelTurn(down: Vec3, look: Pick<Look, 'yaw' | 'pitch'>, amount: number): Mat3 {
  const V = viewRotation(look.yaw * RAD, look.pitch * RAD, 0);
  const g = mulVec(transpose(V), down);
  const u = Math.max(0, Math.min(1, (Math.hypot(g[0], g[1]) - 0.1) / 0.25));
  const a = Math.atan2(g[0], -g[1]) * u * u * (3 - 2 * u) * amount;
  return mulMat(mulMat(V, rotZ(-a)), transpose(V));
}
/** How a limited correction is shared out: when the crop runs out, leveling gives way first. */
const shares = (media: Media, clip: TimelineClip, keep: number): { shake: number; level: number } =>
  !levels(media, clip) ? { shake: keep, level: 0 } : !shakes(media, clip) ? { shake: 1, level: keep } : { shake: Math.min(1, keep * 2), level: Math.max(0, keep * 2 - 1) };

/** The whole turn applied to a regular clip's picture for a view: picture directions → view frame. */
function flatTurn(media: Media, clip: TimelineClip, m: Moment, look: Pick<Look, 'yaw' | 'pitch'>, keep: number): Mat3 {
  const k = shares(media, clip, keep);
  const C = matPower(m.shake, k.shake);
  return m.down && k.level > 0 ? mulMat(levelTurn(mulVec(C, m.down), look, k.level), C) : C;
}

/**
 * Following a subject: aims where the limited stabilisation shows it, and moves the aim back
 * far enough that the view stays inside the picture (the subject goes off-centre there, instead
 * of the view zooming in to nothing). Returns how far it was moved.
 */
function steer(lens: SourceLens, view: FlatView, pic: number, scale: [number, number], look: Look, shake: Mat3, turn: (l: Look) => Mat3): { yaw: number; pitch: number } {
  const p = dirToPicture(lens, mulVec(transpose(shake), dirOf(look.yaw, look.pitch)));
  let ax = 0, ay = 0, aim = look;
  for (let k = 0; k < 4; k++) {
    aim = { ...look, ...anglesOf(mulVec(shake, pictureToDir(lens, ax, ay))) };
    const m = sampleMatrix(aim, turn(aim));
    let l = ax, r = ax, b = ay, u = ay;
    for (const [nx, ny] of BORDER) {
      const ray = flatRay(lens, view, pic, scale, nx, ny);
      if (!ray) continue;
      const q = dirToPicture(lens, mulVec(m, ray));
      l = Math.min(l, q.x); r = Math.max(r, q.x); b = Math.min(b, q.y); u = Math.max(u, q.y);
    }
    const into = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
    ax = into(p.x, -1 + (ax - l), 1 - (r - ax));
    ay = into(p.y, -1 + (ay - b), 1 - (u - ay));
  }
  // Nothing in the way: exactly where it was aimed.
  if (Math.abs(ax - p.x) < 1e-6 && Math.abs(ay - p.y) < 1e-6) return { yaw: 0, pitch: 0 };
  aim = { ...look, ...anglesOf(mulVec(shake, pictureToDir(lens, ax, ay))) };
  return { yaw: wrapDeg(aim.yaw - look.yaw), pitch: aim.pitch - look.pitch };
}
const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** The view with a subject's framing applied: re-aimed for a limited correction, and kept inside. */
function followed(media: Media, clip: TimelineClip, m: Moment, look: Look, w: number, keep: number, off: { yaw: number; pitch: number }): Look {
  if (w <= 0) return look;
  let { yaw, pitch } = look;
  const k = shares(media, clip, keep).shake;
  if (k < 0.9999) {
    // The same thing in the picture, seen with less of the stabilisation.
    const a = anglesOf(mulVec(mulMat(matPower(m.shake, k), transpose(m.shake)), dirOf(yaw, pitch)));
    yaw += wrapDeg(a.yaw - yaw) * w;
    pitch += (a.pitch - pitch) * w;
  }
  return { ...look, yaw: wrapDeg(yaw + off.yaw * w), pitch: Math.max(-90, Math.min(90, pitch + off.pitch * w)) };
}
/** Field of view wanted before any crop for movement. */
function wantFov(lens: SourceLens, view: FlatView, pic: number, scale: [number, number], look: Look, w: number): number {
  const own = w < 1 ? insideFov(lens, view, pic, scale, sampleMatrix(look, IDENTITY)) : 1;
  const all = w > 0 ? insideFov(lens, view, pic, scale, IDENTITY) : 1;
  return w <= 0 ? own : w >= 1 ? all : Math.exp(Math.log(own) * (1 - w) + Math.log(all) * w);
}
/** A calm curve that pushes at least as far as `x` asks, on whichever side. */
function calmOver(x: Float64Array, r: number): Float64Array {
  const pos = smoothUnder(x.map((v) => Math.min(0, -v)), r), neg = smoothUnder(x.map((v) => Math.min(0, v)), r);
  return x.map((_, i) => -pos[i]! + neg[i]!);
}

// --- Crop plans: how far to zoom at each moment so stabilisation never uncovers an edge ----------------
interface FlatPlan extends CropPlan { offYaw: Float64Array; offPitch: Float64Array }
interface Planned { plan: FlatPlan | null; t0: number; step: number; /** Something (an export) is waiting for it. */ waiting: number }
const plans = new Map<string, Planned>();
/** Plans being worked out, by plan. */
const jobs = new Map<string, { clipId: string; run: Generator<number, FlatPlan>; done: ((p: FlatPlan) => void)[] }>();
let planVersion = 0;
/** Goes up whenever a crop plan finishes (so the picture is redrawn with it). */
export const cropVersion = () => planVersion;

const viewKey = (l: Look) => `${l.yaw.toFixed(3)},${l.pitch.toFixed(3)},${l.roll.toFixed(3)},${l.fov.toFixed(3)},${l.fisheye.toFixed(3)}`;
const trackIds = new WeakMap<object, number>();
let trackCount = 0;
const trackId = (tr: object | undefined) => { if (!tr) return 0; let n = trackIds.get(tr); if (!n) trackIds.set(tr, (n = ++trackCount)); return n; };
/** A number for each motion source a file has had (it changes when motion is worked out from the picture). */
const stabIds = new WeakMap<object, number>();
let stabCount = 0;
export const motionId = (media: Media) => { let n = stabIds.get(media.stabilizer); if (!n) stabIds.set(media.stabilizer, (n = ++stabCount)); return n; };
function planKey(clip: TimelineClip, media: Media, outAspect: number) {
  const st = clip.stabilize;
  return [clip.id, media.path, motionId(media), clip.inUs, clip.outUs, outAspect.toFixed(2), clip.fit, clip.lensMode, clip.lensFix?.hfov ?? '', clip.lensFix?.bend ?? '', st.smoothing, st.strength ?? '', st.crop ?? 'auto', st.cropSpeed ?? '', st.maxCrop ?? '', st.cropAmount ?? '', rolling(media, clip), levels(media, clip), trackId(clip.track), viewKey(clip.look), clip.keyframes.map((k) => `${k.t}:${viewKey(k.look)}:${JSON.stringify(curveOf(k, "view"))}`).join(';')].join('|');
}
/** How far ahead a followed view starts moving away from an edge (µs). */
const STEER_US = 500_000;
function startPlan(clip: TimelineClip, media: Media, outAspect: number, key: string): Planned {
  const lens = clipLens(media, clip)!;
  const st = clip.stabilize;
  const step = Math.max(1e6 / 30, (clip.outUs - clip.inUs) / 5000);
  const n = Math.max(2, Math.ceil((clip.outUs - clip.inUs) / step) + 1);
  const at = (i: number) => Math.min(clip.outUs, clip.inUs + i * step);
  const scale = edgeScale(clip, media, outAspect);
  const pic = pictureAspect(media);
  const moments: Moment[] = [], wants: number[] = [];
  const moment = (i: number) => (moments[i] ??= momentAt(media, clip, at(i)));
  const weight = (i: number) => (clip.track ? trackWeight(clip.track, at(i)) : 0);
  const offYaw = new Float64Array(n), offPitch = new Float64Array(n);
  const looks: Look[] = [];
  const lookOf = (i: number) => (looks[i] ??= clipLookAt(clip, at(i)));
  // Rolling shutter moves the first and last rows a little further than the middle.
  const slack = rolling(media, clip) ? 0.985 : 0.997;
  const want = (i: number) => (wants[i] ??= wantFov(lens, flatView(clip, lookOf(i)), pic, scale, lookOf(i), weight(i)));
  const matrix = (i: number, keep: number) => {
    const l = followed(media, clip, moment(i), lookOf(i), weight(i), keep, { yaw: offYaw[i]!, pitch: offPitch[i]! });
    return sampleMatrix(l, flatTurn(media, clip, moment(i), l, keep));
  };
  const q: CropRequest = {
    n,
    want,
    fit: (i, keep) => Math.min(want(i), insideFov(lens, { ...flatView(clip, lookOf(i)), fov: want(i) }, pic, scale, matrix(i, keep)) * slack),
    mode: st.crop ?? 'auto',
    window: st.cropSpeed === 0 ? Infinity : ((st.cropSpeed ?? DEFAULT_CROP.cropSpeed) * 1e6) / step,
    maxCrop: st.maxCrop ?? DEFAULT_CROP.maxCrop,
    amount: st.cropAmount ?? DEFAULT_CROP.cropAmount,
  };
  function* run(): Generator<number, FlatPlan> {
    if (clip.track) {
      // Where the view has to be held back from the picture's edges, ahead of time and calmly.
      for (let i = 0; i < n; i++) {
        if (weight(i) > 0) {
          const o = steer(lens, { ...flatView(clip, lookOf(i)), fov: want(i) }, pic, scale, lookOf(i), moment(i).shake, (l) => flatTurn(media, clip, moment(i), l, 1));
          offYaw[i] = o.yaw;
          offPitch[i] = o.pitch;
        }
        if (i % 4 === 3) yield 0;
      }
      const r = Math.max(1, Math.round(STEER_US / step));
      offYaw.set(calmOver(offYaw, r));
      offPitch.set(calmOver(offPitch, r));
    }
    return { ...(yield* planCrop(q)), offYaw, offPitch };
  }
  const planned: Planned = { plan: null, t0: clip.inUs, step, waiting: 0 };
  plans.set(key, planned);
  if (plans.size > 60) for (const k of plans.keys()) { if (k !== key) { plans.delete(k); break; } }
  // A newer version of the clip makes its older plans pointless, unless an export is waiting for one.
  for (const [k, j] of jobs) if (j.clipId === clip.id && !plans.get(k)?.waiting) { jobs.delete(k); plans.delete(k); }
  jobs.set(key, { clipId: clip.id, run: run(), done: [(r) => { planned.plan = r; planVersion++; }] });
  pump();
  return planned;
}
let pumping = false;
/** Works on plans a few milliseconds at a time. */
function pump() {
  if (pumping) return;
  pumping = true;
  const turn = () => {
    // Gently, leaving the window most of its time (it may be playing); at full pace for an export.
    const urgent = [...jobs.keys()].some((k) => plans.get(k)?.waiting);
    const end = performance.now() + (urgent ? 12 : 4);
    while (jobs.size && performance.now() < end) {
      const [id, job] = jobs.entries().next().value!;
      const r = job.run.next();
      if (r.done) {
        if (jobs.get(id) === job) jobs.delete(id);
        job.done.forEach((f) => f(r.value));
      }
    }
    if (jobs.size) setTimeout(turn, [...jobs.keys()].some((k) => plans.get(k)?.waiting) ? 0 : 8);
    else pumping = false;
  };
  setTimeout(turn, 0);
}
const planFor = (clip: TimelineClip, media: Media, outAspect: number): Planned => {
  const key = planKey(clip, media, outAspect);
  return plans.get(key) ?? startPlan(clip, media, outAspect, key);
};
/** Waits until a clip's crop plan is ready (export and frame grabs must not start without it). */
export async function cropReady(clip: TimelineClip, media: Media, outAspect: number) {
  if (!planned(media, clip)) return;
  const key = planKey(clip, media, outAspect);
  let p = planFor(clip, media, outAspect);
  p.waiting++;
  try {
    for (;;) {
      if (p.plan) return;
      // (Its job was dropped before anyone waited: start it again.)
      if (!jobs.has(key) || plans.get(key) !== p) { p.waiting--; p = planFor(clip, media, outAspect); p.waiting++; }
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    p.waiting--;
  }
}

export interface FlatShot {
  /** What is really shown. */
  fov: number;
  yaw: number;
  pitch: number;
  /** The turn applied to the picture. */
  correction: Mat3;
  rows: Mat3[] | null;
  /** Share of the field of view given up. */
  crop: number;
  /** How much of the horizon leveling there was room for (1 = all). */
  level: number;
}
/** What is really shown of a regular clip at media time t. */
export function flatShot(clip: TimelineClip, media: Media, look: Look, t: number, outAspect: number): FlatShot | null {
  const lens = clipLens(media, clip);
  if (!lens) return null;
  const pic = pictureAspect(media), plan = planned(media, clip);
  const view = flatView(clip, look);
  const still = { yaw: look.yaw, pitch: look.pitch, correction: IDENTITY, rows: null, crop: 0, level: 1 };
  if (clip.fit !== 'fill' && !plan) return { ...still, fov: look.fov };
  const scale = edgeScale(clip, media, outAspect);
  const w = clip.track ? trackWeight(clip.track, t) : 0;
  const base = wantFov(lens, view, pic, scale, look, w);
  if (!plan) return { ...still, fov: base };
  const p = planFor(clip, media, outAspect);
  const x = (t - p.t0) / p.step;
  const { ratio, keep } = p.plan ? cropAt(p.plan, x) : { ratio: 1, keep: 1 };
  const m = momentAt(media, clip, t);
  const between = (a: Float64Array) => { const c = Math.max(0, Math.min(a.length - 1, x)), i = Math.floor(c), j = Math.min(a.length - 1, i + 1); return a[i]! + (a[j]! - a[i]!) * (c - i); };
  const off = w <= 0 ? { yaw: 0, pitch: 0 }
    : p.plan ? { yaw: between(p.plan.offYaw), pitch: between(p.plan.offPitch) }
    : steer(lens, { ...view, fov: base }, pic, scale, look, m.shake, (l) => flatTurn(media, clip, m, l, 1));
  const aimed = followed(media, clip, m, look, w, keep, off);
  const C = flatTurn(media, clip, m, aimed, keep);
  let rows: Mat3[] | null = null;
  if (rolling(media, clip)) {
    const ms = media.camera.readoutMs! * 1000;
    const turns = media.stabilizer.turnWithin(t, Array.from({ length: SHUTTER_ROWS }, (_, i) => (i / (SHUTTER_ROWS - 1) - 0.5) * ms), { axisMap: DEFAULT_AXIS_MAP });
    rows = turns && turns.map((d) => mulMat(C, d));
  }
  // The plan covers moments a 30th of a second apart; make sure in between too.
  let fov = base * ratio;
  for (const c of rows ? [C, rows[0]!, rows[SHUTTER_ROWS - 1]!] : [C]) fov = insideFov(lens, { ...view, fov }, pic, scale, sampleMatrix(aimed, c));
  return { fov, yaw: aimed.yaw, pitch: aimed.pitch, correction: C, rows, crop: 1 - fov / base, level: m.down ? shares(media, clip, keep).level : 1 };
}

/** The direction at an output point of a regular clip: in the picture, and in the world-steady frame. */
export function flatDirection(clip: TimelineClip, media: Media, look: Look, t: number, outAspect: number, nx: number, ny: number): { camera: Vec3; world: { yaw: number; pitch: number } } | null {
  const lens = clipLens(media, clip);
  const shot = lens && flatShot(clip, media, look, t, outAspect);
  if (!lens || !shot) return null;
  const pic = pictureAspect(media);
  const ray = flatRay(lens, { ...flatView(clip, look), fov: shot.fov }, pic, planeScale(outAspect, pic, clip.fit === 'fill' ? 'fill' : 'fit'), nx, ny);
  if (!ray) return null;
  const camera = mulVec(sampleMatrix({ yaw: shot.yaw, pitch: shot.pitch, roll: look.roll }, shot.correction), ray);
  return { camera, world: anglesOf(mulVec(flatWorld(media, t), camera)) };
}
/** Widest view a regular clip's picture can fill, with the lens chosen. */
export function roomFov(clip: TimelineClip, media: Media): number {
  const lens = clipLens(media, clip);
  if (!lens) return 170;
  return clip.lensMode === 'custom' ? insideFov(lens, { fov: 170, fisheye: clip.look.fisheye, lens: 'custom' }, pictureAspect(media), [1, 1], IDENTITY) : lens.hfov;
}
/** Following a subject starts with this share of that, so there is picture left to move into. */
export const FOLLOW_ROOM = 0.6;
/** Where a world-steady direction lands in a regular clip's picture (−1…1), and whether it was recorded. */
export function worldInPicture(media: Media, clip: TimelineClip, t: number): (yaw: number, pitch: number) => { x: number; y: number; inside: boolean } {
  const lens = clipLens(media, clip)!, back = transpose(flatWorld(media, t));
  return (yaw, pitch) => dirToPicture(lens, mulVec(back, dirOf(yaw, pitch)));
}
/** Draws an undistorted world-steady view of a regular clip (for the tracker; black where nothing was recorded). */
export function pushWorldView(r: ReframeRenderer, clip: TimelineClip, media: Media, t: number, frames: VideoFrame[], view: { yaw: number; pitch: number; fov: number }) {
  r.pushFrame({
    frames: frames as [VideoFrame, VideoFrame], mode: 'lens', view: { ...view, roll: 0, fisheye: 0, autoLens: true },
    correction: flatWorld(media, t), lens: clipLens(media, clip)!, outputLens: 'custom', camera: true, turns: media.turns,
  });
}
/** Field of view really shown: zoomed in just enough that nothing outside the picture appears. */
export const shownFov = (clip: TimelineClip, media: Media, look: Look, outAspect: number, t = clip.inUs): number => flatShot(clip, media, look, t, outAspect)?.fov ?? look.fov;

const untouched = (clip: TimelineClip, look: Look, lens: SourceLens) =>
  clip.lensMode !== 'custom' && Math.abs(look.yaw) < 1e-4 && Math.abs(look.pitch) < 1e-4 && Math.abs(look.roll) < 1e-4 && Math.abs(look.fov - lens.hfov) < 1e-3;

export function pushClipFrame(r: ReframeRenderer, clip: TimelineClip, media: Media, mediaUs: number, frames: VideoFrame[], opts: { raw?: boolean; showTiles?: boolean } = {}) {
  let look = clipLookAt(clip, mediaUs);
  const lens = clipLens(media, clip);
  // A regular clip nobody has reframed is drawn exactly as recorded.
  const plan = planned(media, clip);
  const throughLens = !!lens && !!clip.lensMode && (plan || !untouched(clip, look, lens));
  const mode: RenderMode = media.is360 ? (opts.raw ? 'raw' : '360') : throughLens ? 'lens' : 'flat';
  const shot = throughLens ? flatShot(clip, media, look, mediaUs, r.canvas.width / r.canvas.height) : null;
  if (shot) look = { ...look, fov: shot.fov, yaw: shot.yaw, pitch: shot.pitch };
  r.pushFrame({
    frames: frames as [VideoFrame, VideoFrame],
    mode,
    view: { yaw: look.yaw, pitch: look.pitch, roll: look.roll, fov: look.fov, fisheye: look.fisheye, autoLens: true },
    correction: mode === '360' ? media.stabilizer.correctionAt(mediaUs, { ...clip.stabilize, axisMap: DEFAULT_AXIS_MAP }) : shot?.correction,
    rowCorrections: shot?.rows ?? undefined,
    maskBars: plan && clip.fit !== 'fill',
    showTiles: opts.showTiles,
    fill: clip.fit === 'fill',
    lens: throughLens ? lens! : undefined,
    outputLens: clip.lensMode === 'custom' ? 'custom' : 'source',
    turns: media.turns,
    input: opts.raw ? undefined : inputFor(media, clip, frames[0]!),
    lenses: clip.lenses,
  });
  // (Settings switched off to compare are left out of what is shown.)
  return withOff(look, clip.off);
}

/**
 * `time` (µs of media time) animates grain and light leaks. `clip`: its curves, qualifier, film
 * look and noise reduction (left out when comparing with the original).
 */
export function presentLook(r: ReframeRenderer, look: Look, opts: { raw?: boolean; time?: number; clip?: TimelineClip | null } = {}) {
  const fx = look.fx;
  r.present({
    blendFrames: blurFrames(look.motionBlur), grade: look.grade, bypass: opts.raw, fx, time: (opts.time ?? 0) / 1e6,
    fx2: { bloom: fx.bloom, halation: fx.halation, vhs: fx.vhs, shake: fx.shake, rgbSplit: fx.rgbSplit },
    wheels: wheelsNeutral(look.wheels) ? null : wheelUniforms(look.wheels!),
    ...clipFinish(opts.clip),
  });
}

const baked = new WeakMap<object, { key: string; data: Float32Array; mode: number }>();
let bakes = 0;
const films = new Map<string, Lut3D>();
/** A clip's own finishing (not keyframed): curves, qualifier, film look, noise reduction. */
export function clipFinish(clip: TimelineClip | null | undefined): Pick<PresentInput, 'curves' | 'qualifier' | 'film' | 'denoise'> {
  if (!clip) return {};
  const off = new Set(clip.off ?? []);
  let curves: PresentInput['curves'] = null;
  if (clip.curves && !off.has('curves')) {
    let b = baked.get(clip.curves);
    if (!b) {
      const used = curvesUsed(clip.curves);
      baked.set(clip.curves, (b = { key: `c${++bakes}`, data: bakeCurves(clip.curves), mode: (used.tone ? 1 : 0) + (used.color ? 2 : 0) }));
    }
    if (b.mode) curves = b;
  }
  const q = clip.qualifier && !clip.qualifier.off && !off.has('qualifier') ? qualifierUniforms(clip.qualifier) : null;
  let film: PresentInput['film'] = null;
  if (clip.film && clip.film.mix > 0.001 && !off.has('film')) {
    let lut = films.get(clip.film.look);
    if (!lut) films.set(clip.film.look, (lut = filmLut(clip.film.look)));
    film = { key: clip.film.look, lut, mix: clip.film.mix };
  }
  const d = clip.denoise && !off.has('denoise') && denoiseOn(clip.denoise) ? { ...clip.denoise, frames: denoiseFrames(clip.denoise) } : null;
  return { curves, qualifier: q, film, denoise: d };
}

/** The same view with nothing done to the picture: no colour, LUT, sharpening, effects or motion blur. */
export const withoutEffects = (look: Look): Look => { const { wheels: _w, ...rest } = look; return { ...rest, grade: { ...NEUTRAL_GRADE, lutMix: 0 }, fx: NO_EFFECTS, motionBlur: 0 }; };

const mediaMotion = (clip: TimelineClip) => { const m = mediaNow(clip.mediaPath); return m ? motionId(m) : 0; };
/** Everything that changes the reframe pass (as opposed to grading), for change detection. */
export function reframeSignature(clip: TimelineClip, look: Look, extra: string) {
  return `${clip.id}|${look.yaw.toFixed(3)}|${look.pitch.toFixed(3)}|${look.roll.toFixed(3)}|${look.fov.toFixed(3)}|${look.fisheye.toFixed(4)}|${clip.stabilize.smoothing}:${clip.stabilize.strength ?? ''}|${clip.stabilize.horizon}|${clip.fit}|${clip.lensMode ?? ''}|${clip.stabilize.crop ?? ''}:${clip.stabilize.cropSpeed ?? ''}:${clip.stabilize.maxCrop ?? ''}:${clip.stabilize.cropAmount ?? ''}:${clip.stabilize.rolling ?? ''}|${clip.lenses ? JSON.stringify(clip.lenses) : ''}|${clip.lensLook ? `${clip.lensLook.fov},${clip.lensLook.fisheye}` : ''}|${clip.inputColor ?? ''}:${clip.wideColor ?? ''}|${clip.lensMode ? planVersion : 0}|${clip.lensFix ? `${clip.lensFix.hfov ?? ''},${clip.lensFix.bend ?? ''}` : ''}|${mediaMotion(clip)}|${extra}`;
}

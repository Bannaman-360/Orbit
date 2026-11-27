// Smart reframe: fits a clip into another frame shape (most often 9:16) and keeps the action in
// view, as editable keyframes.
// - Regular clips: what moves in the picture once the camera's own movement is taken out
//   (background.ts), or, when the camera is travelling forward, the point everything streams
//   away from (where it's heading). The picture fills the frame and pans (`look.pan`, or the view
//   for clips reframed through their lens).
// - 360 clips: the direction of travel, from GPS when the clip has it (lined up with where the
//   camera faced), or else where the camera faced, smoothed. The view is kept level and steady
//   (Locked) so it only turns where the path turns.
// - Clips following a tracked subject keep following it.

import { TrackDecoder } from '@ace/engine';
import { reachX } from '@ace/media360';
import { courseBetween, courseToWorld, pathAt, pathKeyframes, planPath, unwrapDegrees, type PathPoint, type TimelineClip } from '@ace/project';
import type { Shift } from './background';
import { interestBetween, N } from './interest';
import { clipLens, clipViewToWorld, ownLookAt } from './frameRender';
import type { Media } from './media';

/** Pictures analysed per second, and their size (square, the picture squeezed in). */
const RATE = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ReframeHow = 'motion' | 'heading' | 'gps' | 'camera' | 'tracked' | 'whole' | 'still';
export interface ReframeResult {
  patch: Partial<TimelineClip>;
  how: ReframeHow;
  /** Keyframes written. */
  keys: number;
  /** For checking: the measured path and the planned one (path units: picture −1…1 or degrees). */
  raw?: PathPoint[];
  planned?: PathPoint[];
}

/** Short note for the rider on what was followed. */
export function reframeNote(r: ReframeResult): string {
  switch (r.how) {
    case 'motion': return `Done: the frame follows what moves (${r.keys} keyframes).`;
    case 'heading': return `Done: the frame follows where you’re heading (${r.keys} keyframes).`;
    case 'gps': return `Done: the view follows your direction of travel from GPS, kept steady and level (${r.keys} keyframes).`;
    case 'camera': return `Done: the view follows where the camera faced, smoothed, kept steady and level (${r.keys} keyframes).`;
    case 'tracked': return 'Done: the frame is filled and keeps following the subject you tracked.';
    case 'whole': return 'This clip already fits the frame shape, so there is nothing to pan across.';
    case 'still': return 'Nothing clearly moved in this clip, so the frame stays in the middle.';
  }
}

/** Samples of the clip's first video track between in and out, about RATE a second. */
function sampleTimes(m: Media, c: TimelineClip): number[] {
  const all = m.tracks[0]!.samples.map((s) => s.timestamp).sort((a, b) => a - b).filter((t) => t >= c.inUs && t < c.outUs);
  const every = Math.max(1, Math.round(m.fps / RATE));
  return all.filter((_, i) => i % every === 0);
}

/** Measures where the interest is through a regular clip (picture −1…1 across and down). */
async function measurePicture(m: Media, c: TimelineClip, onProgress: (f: number) => void, signal: AbortSignal) {
  const times = sampleTimes(m, c);
  if (times.length < 3) throw new Error('This clip is too short to reframe.');
  const canvas = new OffscreenCanvas(N, N), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // (Shrunk smoothly: fine detail would otherwise shimmer and look like movement.)
  ctx.imageSmoothingQuality = 'high';
  const dec = new TrackDecoder(m.reader, m.tracks[0]!);
  dec.maxAhead = 8;
  dec.seek(times[0]!);
  const xs: PathPoint[] = [], ys: PathPoint[] = [], shifts: number[] = [];
  let prevColour: Float64Array[] | null = null;
  let prev: Float64Array | null = null, shift: Shift = { dx: 0, dy: 0, a: 0, b: 0 }, heading = 0;
  try {
    for (let i = 0; i < times.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      let f: VideoFrame | null = null;
      for (let tries = 0; ; tries++) {
        void dec.pump();
        f = dec.frameAt(times[i]!);
        if (f) break;
        if (tries > 3000) throw new Error(`Decoding stalled at ${(times[i]! / 1e6).toFixed(2)} s`);
        await sleep(2);
      }
      // Upright, squeezed into a square (measurements come back as shares of the picture).
      ctx.save();
      ctx.translate(N / 2, N / 2);
      ctx.rotate((m.turns * Math.PI) / 2);
      ctx.drawImage(f, -N / 2, -N / 2, N, N);
      ctx.restore();
      const px = ctx.getImageData(0, 0, N, N).data, gray = new Float64Array(N * N), rg = new Float64Array(N * N), bg = new Float64Array(N * N);
      for (let k = 0, j = 0; k < gray.length; k++, j += 4) { gray[k] = 0.299 * px[j]! + 0.587 * px[j + 1]! + 0.114 * px[j + 2]!; rg[k] = px[j]! - px[j + 1]!; bg[k] = px[j + 2]! - px[j + 1]!; }
      if (prev) {
        const r = interestBetween(gray, prev, shift, { cur: [rg, bg], prev: prevColour! });
        shift = r.shift;
        if (r.shift.a < -0.004) heading++;
        xs.push({ t: times[i]!, v: r.x, w: r.w });
        shifts.push(+r.shift.dx.toFixed(2));
        ys.push({ t: times[i]!, v: r.y, w: r.w });
      }
      prev = gray;
      prevColour = [rg, bg];
      if (i % 5 === 0) onProgress(i / times.length);
    }
  } finally {
    dec.close();
  }
  return { xs, ys, heading: heading / Math.max(1, xs.length), shifts };
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Measures the direction of travel of a 360 clip in its world-steady frame (degrees). */
function measureTravel(m: Media, c: TimelineClip): { path: PathPoint[]; how: ReframeHow } | null {
  if (!m.stabilizer.hasOrientation) return null;
  const step = 1e6 / RATE, times: number[] = [];
  for (let t = c.inUs; t < c.outUs; t += step) times.push(t);
  // Where the camera's front faced (its own view, not stabilised).
  const raw = { ...c, stabilize: { ...c.stabilize, smoothing: 'off' as const, horizon: false, lock: undefined } };
  const cam = unwrapDegrees(times.map((t) => clipViewToWorld(m, raw, t, 0, 0).yaw));
  const tel = m.telemetry;
  if (tel.hasGps) {
    const moving: number[] = [], course: number[] = [], camAt: number[] = [], courses: (number | null)[] = [];
    times.forEach((t, i) => {
      const a = tel.latLonAt(t - 500_000), b = tel.latLonAt(t + 500_000), v = tel.speedAt(t);
      const ok = a && b && v > 2.5;
      courses.push(ok ? courseBetween(a, b) : null);
      if (ok) { moving.push(i); course.push(courses[i]!); camAt.push(cam[i]!); }
    });
    const toWorld = moving.length >= 20 ? courseToWorld(camAt, course) : null;
    if (toWorld) {
      const yaw = unwrapDegrees(times.map((_, i) => (courses[i] !== null ? toWorld(courses[i]!) : wrap(cam[i]!))));
      return { path: times.map((t, i) => ({ t, v: yaw[i]!, w: courses[i] !== null ? 1 : 0.3 })), how: 'gps' };
    }
  }
  return { path: times.map((t, i) => ({ t, v: cam[i]! })), how: 'camera' };
}

/** The view's turn (degrees) that shows picture point x (−1…1) through the clip's lens, for clips reframed through it. */
function yawForX(m: Media, c: TimelineClip, x: number): number {
  const lens = clipLens(m, c);
  if (!lens) return 0;
  let lo = 0, hi = lens.hfov / 2;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (reachX(lens, mid) < Math.abs(x)) lo = mid; else hi = mid; }
  return Math.sign(x) * (lo + hi) / 2;
}

/** For checking: the camera shifts measured last time (picture pixels across, per step). */
export let lastShifts: number[] = [];

/** Works out the smart reframe of one clip for a frame of `outAspect` (width ÷ height). */
export async function smartReframe(c: TimelineClip, m: Media, outAspect: number, onProgress: (f: number) => void, signal: AbortSignal): Promise<ReframeResult> {
  if (m.is360) {
    const travel = measureTravel(m, c);
    onProgress(1);
    if (!travel) return { patch: {}, how: 'still', keys: 0 };
    const median = [...travel.path.map((p) => p.v)].sort((a, b) => a - b)[travel.path.length >> 1] ?? 0;
    const planned = planPath(travel.path, { sigmaUs: 1_200_000, dead: 12, tol: 3, minGapUs: 500_000, lo: -1e9, hi: 1e9, rest: median });
    // Locked and level: the view's turn is then the same as the world's, so the keyframes are the path.
    const steady: TimelineClip = { ...c, stabilize: { ...c.stabilize, smoothing: 'locked', horizon: true, lock: undefined } };
    const keyframes = pathKeyframes(steady, planned, (l, v) => ({ ...l, yaw: wrap(v) }));
    return { patch: { stabilize: steady.stabilize, keyframes }, how: travel.how, keys: planned.length, raw: travel.path, planned };
  }
  const fill: Partial<TimelineClip> = c.fit === 'fill' ? {} : { fit: 'fill' };
  if (c.track && c.lensMode) { onProgress(1); return { patch: fill, how: 'tracked', keys: 0 }; }
  const pic = m.width / m.height;
  // Which way there is picture to spare, and how much of it is seen (k).
  const across = pic > outAspect * 1.01, down = pic < outAspect * 0.99;
  if (!across && !down) { onProgress(1); return { patch: fill, how: 'whole', keys: 0 }; }
  const k = across ? outAspect / pic : pic / outAspect;
  const { xs, ys, heading, shifts } = await measurePicture(m, c, onProgress, signal);
  lastShifts = shifts;
  const raw = across ? xs : ys;
  if (!raw.some((p) => (p.w ?? 0) > 0.2)) return { patch: fill, how: 'still', keys: 0 };
  const room = 1 - k;
  const planned = planPath(raw, { sigmaUs: 700_000, dead: 0.1 * room + 0.02, tol: 0.03 * room + 0.005, minGapUs: 400_000, lo: -room, hi: room });
  onProgress(1);
  const how: ReframeHow = heading > 0.4 ? 'heading' : 'motion';
  if (c.lensMode && across) {
    // Through the lens: turn the view instead (the picture is drawn through it).
    const keyframes = pathKeyframes(c, planned, (l, v) => ({ ...l, yaw: yawForX(m, c, v) }));
    return { patch: { ...fill, keyframes }, how, keys: planned.length, raw, planned };
  }
  const keyframes = pathKeyframes(c, planned, (l, v) => ({ ...l, pan: { x: across ? v / room : l.pan?.x ?? 0, y: across ? l.pan?.y ?? 0 : v / room } }));
  // A clip without keyframes takes the first position as its own too.
  const look = c.keyframes.length ? c.look : { ...ownLookAt(c, c.inUs), pan: keyframes[0]?.look.pan };
  return { patch: { ...fill, keyframes, look }, how, keys: planned.length, raw, planned };
}

/** Value of the planned path at a media time (for checking). */
export const plannedAt = (r: ReframeResult, t: number) => (r.planned ? pathAt(r.planned, t) : NaN);

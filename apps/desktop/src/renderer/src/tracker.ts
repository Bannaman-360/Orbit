// Subject tracking for 360 clips. Renders a small undistorted view aimed at the subject,
// finds where the subject moved within it (MOSSE correlation tracker), re-aims, and repeats
// for every frame. Because the view is re-aimed each frame the subject always sits near the
// centre of a rectilinear patch, so 360 distortion and wrap-around never get in the way.

import { TrackDecoder } from '@ace/engine';
import { cameraRay, effectiveLens, Mosse, mulVec, ReframeRenderer, viewRotation, type Vec3 } from '@ace/media360';
import { DEFAULT_LOOK, NEUTRAL_GRADE, NO_EFFECTS, type Look, type TimelineClip, type TrackPoint } from '@ace/project';
import { clipViewToWorld, presentLook, pushClipFrame, WORLD_STABILIZE } from './frameRender';
import type { Media } from './media';

const RAD = Math.PI / 180;

/** Tracker settings (tuned on real footage; adjustable for testing). */
export const TRACKER = {
  /** Patch size, pixels (power of two). */
  N: 128,
  /**
   * 'gray' = brightness only (most accurate on real footage so far); 'rich' adds colour and
   * edge-direction channels (more robust to lighting changes, slower, a little less precise).
   */
  features: 'gray' as 'rich' | 'gray',
  /** How fast the subject's appearance is re-learned (0–1). */
  rate: 0.1,
  /** View width around the subject, as a multiple of its size (room to move between frames). */
  context: 3.5,
  /** Narrowest tracking view (degrees): small subjects still get some room to move. */
  minFov: 12,
  /** Widest tracking view (degrees): big subjects keep enough detail to be precise. */
  maxFov: 80,
  /** Aim where the subject is heading before looking (fraction of last step's motion). */
  predict: 0,
  /**
   * Motion channel: difference between this frame and the previous one seen from the same
   * direction. The view is world-steady, so a still background cancels out and only moving
   * things (the subject) remain — the tracker can't settle on background that doesn't move.
   * Weight of the motion channel vs. appearance (0 = off).
   */
  motion: 1,
  /**
   * For a moving subject (movement concentrated in its box, measured over the first frames:
   * inside ÷ outside above `movingFocus`) motion counts this much instead, and each step
   * pulls the aim towards the centre of the movement by `recentre`. On labelled footage of a
   * rider this took tracking from 35/82 to 82/82 points; things fixed to the camera or not
   * moving (focus < 1) need the plain weight above.
   */
  movingMotion: 3,
  movingFocus: 1.6,
  recentre: 0.1,
  /** Weight of the appearance (brightness) channel. */
  appearance: 1,
  /**
   * Wide search view as a last resort when the narrow view is unsure (see wideSearch).
   * Off: on real footage it never improved tracking (the narrow view already follows fast
   * passes once sizes are tracked) and, used freely, it picked wrong matches.
   */
  wide: false,
  /** Look wide when the narrow view's confidence is below this. */
  wideBelowPsr: 6,
  /** A wide-view match must be this much more confident than the narrow one to be taken. */
  wideMargin: 1.6,
  /** Zoom factors tried when checking the subject's size, and how much of a better one to adopt. */
  scaleSteps: [0.88, 0.94, 1.06, 1.13],
  scaleAdopt: 0.7,
  /** How much a match where nothing moves still counts (1 = motion doesn't veto at all). */
  priorFloor: 1,
  /**
   * Estimate size from the moving blob. Off: size comes from trying slightly zoomed views and
   * keeping the best match — steadier on real footage (the blob also catches ground streaming
   * past when both riders move).
   */
  blobSize: false,
  /** Fade the background outside the subject's box (strength 0–1; 0 = off). */
  focus: 0.85,
  /** Track every frame when the subject moves faster than this fraction of the view per step (else every other frame on 50/60 fps). */
  fastStep: 0.06,
};

/** Brightness, colour-difference and edge-direction feature channels from an RGBA patch. */
export function features(px: Uint8ClampedArray, N: number, kind: 'rich' | 'gray'): Float64Array[] {
  const n = N * N;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
  if (kind === 'gray') return [g];
  const c1 = new Float64Array(n), c2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4]!, gr = px[i * 4 + 1]!, b = px[i * 4 + 2]!;
    c1[i] = r - gr;
    c2[i] = (r + gr) / 2 - b;
  }
  // Edge directions: Sobel gradient, magnitude split into 4 unsigned orientation bins.
  const bins = [0, 1, 2, 3].map(() => new Float64Array(n));
  for (let y = 1; y < N - 1; y++)
    for (let x = 1; x < N - 1; x++) {
      const at = (dx: number, dy: number) => g[(y + dy) * N + x + dx]!;
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      const m = Math.hypot(gx, gy);
      if (m < 1e-6) continue;
      const th = Math.atan2(gy, gx);
      for (let k = 0; k < 4; k++) bins[k]![y * N + x] = m * Math.max(0, Math.cos(2 * (th - (k * Math.PI) / 4)));
    }
  // A light 3×3 blur makes edge channels tolerant of small shape changes (like HOG cells).
  const blur = (a: Float64Array) => {
    const o = new Float64Array(n);
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += a[(y + dy) * N + x + dx]!;
        o[y * N + x] = s / 9;
      }
    return o;
  };
  return [g, c1, c2, ...bins.map(blur)];
}
/** Below this confidence the subject is probably hidden or lost. */
const LOST_PSR = 5.5;
let N = 64;
/** A search result must be at least this sure to re-acquire a lost subject. */
const REACQUIRE_PSR = 8;
/** How long to keep going without seeing the subject before giving up. */
const COAST_US = 1_000_000;
const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** View direction (yaw/pitch, degrees) of a point on a rendered view of `look`. */
export function directionAt(look: Look, aspect: number, nx: number, ny: number): { yaw: number; pitch: number } | null {
  const lens = effectiveLens({ fov: look.fov, fisheye: look.fisheye, autoLens: true });
  const ray = cameraRay(lens.k, lens.fov, aspect, nx, ny);
  if (!ray) return null;
  return toYawPitch(mulVec(viewRotation(look.yaw * RAD, look.pitch * RAD, look.roll * RAD), ray));
}

const toYawPitch = (d: Vec3) => ({ yaw: Math.atan2(d[0], d[2]) / RAD, pitch: Math.asin(Math.max(-1, Math.min(1, d[1]))) / RAD });

/** Angle in degrees between two view points (for the size of the selection box). */
export function angleBetween(look: Look, aspect: number, a: [number, number], b: [number, number]): number {
  const lens = effectiveLens({ fov: look.fov, fisheye: look.fisheye, autoLens: true });
  const ra = cameraRay(lens.k, lens.fov, aspect, a[0], a[1]);
  const rb = cameraRay(lens.k, lens.fov, aspect, b[0], b[1]);
  if (!ra || !rb) return 20;
  return Math.acos(Math.max(-1, Math.min(1, ra[0] * rb[0] + ra[1] * rb[1] + ra[2] * rb[2]))) / RAD;
}

export interface TrackStart {
  clip: TimelineClip;
  media: Media;
  /** Media time to start tracking from. */
  startUs: number;
  /** Where the subject is, in the clip's own view (as seen on the preview). */
  yaw: number;
  pitch: number;
  /** Angular size of the subject (degrees). */
  sizeDeg: number;
}

export interface TrackOutcome {
  /** The subject's path in the world-steady frame (store as a 'world' track). */
  points: TrackPoint[];
  /** Media time where the subject was lost (tracking stopped early). */
  lostAt?: number;
  /** Confidence (PSR) per step, for diagnostics. */
  confidence?: number[];
  /** Raw motion-blob size per step (degrees; -1 = nothing moving), for diagnostics. */
  blobs?: number[];
  /** How often the wide view was searched / its result taken, for diagnostics. */
  wide?: { searched: number; taken: number };
  /** Movement inside the box ÷ outside it at the start, for diagnostics. */
  motionFocus?: number;
  probe?: number[];
  cancelled?: boolean;
}

export async function trackSubject(s: TrackStart, onProgress: (fraction: number) => void, signal: AbortSignal, debugPatches?: Float64Array[]): Promise<TrackOutcome> {
  const { clip, media } = s;
  N = TRACKER.N;
  const canvas = new OffscreenCanvas(N, N);
  const r = await ReframeRenderer.create(canvas);
  r.setLayout(media.layout);
  const read = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true })!;
  const decs = media.tracks.map((t) => new TrackDecoder(media.reader, t));
  // ~30 tracking steps per second is plenty for slow subjects (halves the work on 60 fps
  // footage); when the subject moves fast, every frame is tracked so it stays in view.
  const every = media.fps > 45 ? 2 : 1;
  const all = media.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
  const first = all.findIndex((t) => t >= s.startUs - 1);
  // One frame before the start too: the motion channel needs a previous frame to compare with.
  const times = all.slice(Math.max(0, first - (TRACKER.motion > 0 ? 1 : 0))).filter((t) => t < clip.outUs);
  const warmup = TRACKER.motion > 0 && first > 0 ? 1 : 0;
  decs.forEach((d) => { d.maxAhead = 6; d.seek(times[0] ?? s.startUs); });

  let { yaw, pitch } = clipViewToWorld(media, clip, times[0] ?? s.startUs, s.yaw, s.pitch);
  let fov = Math.max(TRACKER.minFov, Math.min(TRACKER.maxFov, s.sizeDeg * TRACKER.context));
  // The tracking view keeps the subject at a constant share of itself, so its width tells us
  // the subject's size: size = sizeDeg × fov / fov₀.
  const fov0 = fov;
  /** Current estimate of the subject's size (degrees across). */
  let sizeEst = s.sizeDeg;
  const sizeNow = () => sizeEst;
  /**
   * Size from the motion channel: the moving pixels near the centre form a blob whose spread
   * follows the subject's size. Calibrated against the user's box on the first measurements.
   */
  let blobToSize: number | null = null;
  const calib: number[] = [];
  const blobSize = (m: Float64Array, f: number): number | null => {
    let max = 0;
    for (let i = 0; i < m.length; i++) if (m[i]! > max) max = m[i]!;
    if (max < 6) return null; // nothing clearly moving
    const thr = max * 0.3, half = N / 2, lim = N * 0.45;
    let w = 0, sx = 0, sy = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (Math.abs(x - half) > lim || Math.abs(y - half) > lim) continue;
        const v = m[y * N + x]! - thr;
        if (v <= 0) continue;
        w += v; sx += v * x; sy += v * y;
      }
    if (w <= 0) return null;
    const cx = sx / w, cy = sy / w;
    let vx = 0, vy = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (Math.abs(x - half) > lim || Math.abs(y - half) > lim) continue;
        const v = m[y * N + x]! - thr;
        if (v <= 0) continue;
        vx += v * (x - cx) ** 2; vy += v * (y - cy) ** 2;
      }
    const spreadPx = Math.sqrt(Math.sqrt(vx / w) * Math.sqrt(vy / w));
    if (spreadPx < 0.8) return null;
    return (spreadPx * f) / N; // degrees
  };
  const updateSize = (patch: Float64Array[]) => {
    if (TRACKER.motion <= 0 || !TRACKER.blobSize) return false;
    const b = blobSize(patch[patch.length - 1]!, fov);
    blobLog?.push(b === null ? -1 : +b.toFixed(1));
    if (b === null) return false;
    if (blobToSize === null) {
      // Calibrate against the user's box from the median of the first measurements.
      calib.push(b);
      if (calib.length >= 8) blobToSize = s.sizeDeg / [...calib].sort((x, y) => x - y)[calib.length >> 1]!;
      return false;
    }
    const measured = Math.max(1, Math.min(150, b * blobToSize));
    // Smooth, and never jump more than 25% per step (one noisy frame can't yank the zoom).
    const ratio = Math.max(0.8, Math.min(1.25, measured / sizeEst));
    sizeEst *= ratio ** 0.35;
    fov = Math.max(TRACKER.minFov, Math.min(TRACKER.maxFov, sizeEst * TRACKER.context));
    return true;
  };
  // The subject fills about 1/context of the view; weight that part (see Mosse `target`).
  const mosse = new Mosse(N, TRACKER.rate, N / 16, 0.1, TRACKER.focus > 0 ? Math.min(1, (s.sizeDeg / fov) * 1.3) : 0, 1 - TRACKER.focus);
  const nApp = TRACKER.features === 'rich' ? 7 : 1;
  mosse.weights = [...Array(nApp).fill(TRACKER.appearance), ...(TRACKER.motion > 0 ? [TRACKER.motion] : [])];
  // Motion keeps its real strength: a still subject gives an empty channel, not amplified noise.
  // ~12 grey levels of change counts as "clearly moving".
  if (TRACKER.motion > 0) mosse.fixedScale[nApp] = 12;
  /** How concentrated movement is in the subject's box (see the probe below). */
  let motionFocus = 0;
  let moving = false;
  const points: TrackPoint[] = [];
  const confidence: number[] = [];
  let step = 0;
  let motionSized = false;
  let lastPsr = 99, wideUsed = 0, wideTaken = 0;
  const blobLog: number[] | undefined = debugPatches ? [] : undefined;
  let vel = { yaw: 0, pitch: 0 };
  let coastStart: { index: number; t: number } | null = null;

  // A bare clip in the world-steady frame (head turns already removed using the camera's
  // motion data), neutral colour, no effects, no blur. The tracker then only has to follow
  // the subject's own motion, and the path works with any stabilisation setting.
  const bare: TimelineClip = { ...clip, keyframes: [], track: undefined, stabilize: WORLD_STABILIZE };
  type Prev = { gray: Float64Array; yaw: number; pitch: number; fov: number; step: number };
  /** Renders an n×n view and returns its feature channels (+ motion vs. `pv`, same size). */
  const renderView = async (
    rend: ReframeRenderer, cnv: OffscreenCanvas, rd: OffscreenCanvasRenderingContext2D, n: number,
    t: number, frames: VideoFrame[], y: number, p: number, f: number, pv: Prev | null,
  ): Promise<Float64Array[]> => {
    rend.resetHistory();
    pushClipFrame(rend, { ...bare, look: { ...DEFAULT_LOOK, yaw: y, pitch: p, roll: 0, fov: f, fisheye: 0, grade: NEUTRAL_GRADE, fx: NO_EFFECTS } }, media, t, frames);
    presentLook(rend, { ...DEFAULT_LOOK, grade: NEUTRAL_GRADE, fx: NO_EFFECTS, motionBlur: 0 });
    const bmp = await createImageBitmap(cnv);
    rd.drawImage(bmp, 0, 0);
    bmp.close();
    const chans = features(rd.getImageData(0, 0, n, n).data, n, TRACKER.features);
    if (TRACKER.motion <= 0) return chans;
    // Motion channel against the previous frame, seen from (approximately) the same direction.
    const g = chans[0]!;
    const motion = new Float64Array(n * n);
    if (pv) {
      const pxPerDeg = n / 2 / Math.tan((f * RAD) / 2) * RAD;
      const sx = Math.round(wrapDeg(y - pv.yaw) * Math.cos(p * RAD) * pxPerDeg);
      const sy = Math.round(-(p - pv.pitch) * pxPerDeg);
      const scale = pv.fov / f;
      for (let yy = 0; yy < n; yy++)
        for (let xx = 0; xx < n; xx++) {
          // Where this pixel was in the previous view (shift for the aim change, scale for zoom).
          const px = Math.round((xx - n / 2 + sx) / scale + n / 2), py = Math.round((yy - n / 2 + sy) / scale + n / 2);
          const v = pv.gray[Math.min(n - 1, Math.max(0, py)) * n + Math.min(n - 1, Math.max(0, px))]!;
          motion[yy * n + xx] = Math.abs(g[yy * n + xx]! - v);
        }
    }
    // Light blur: one solid blob per moving thing, not edge speckle.
    const blurred = new Float64Array(n * n);
    for (let yy = 1; yy < n - 1; yy++)
      for (let xx = 1; xx < n - 1; xx++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += motion[(yy + dy) * n + xx + dx]!;
        blurred[yy * n + xx] = sum / 9;
      }
    return [...chans, blurred];
  };
  const patchAt = (t: number, frames: VideoFrame[], y: number, p: number, f: number) => renderView(r, canvas, read, N, t, frames, y, p, f, prev);

  // --- Wide search view: twice the angle and twice the pixels (same detail per degree, so the
  // same filter recognises the subject), searched in overlapping N×N sections. Used when the
  // subject moves fast or the narrow view is unsure, so fast subjects don't escape the view.
  const NW = N * 2;
  const wideCanvas = new OffscreenCanvas(NW, NW);
  const wideR = await ReframeRenderer.create(wideCanvas);
  wideR.setLayout(media.layout);
  const wideRead = new OffscreenCanvas(NW, NW).getContext('2d', { willReadFrequently: true })!;
  let prevWide: Prev | null = null;
  const crop = (ch: Float64Array, ox: number, oy: number) => {
    const out = new Float64Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[y * N + x] = ch[(oy + y) * NW + ox + x]!;
    return out;
  };
  /** Best match in a wide view around (y, p): direction and confidence. */
  const wideSearch = async (t: number, frames: VideoFrame[], y: number, p: number) => {
    const fw = Math.min(150, fov * 2);
    const pv = prevWide && step - prevWide.step <= 3 ? prevWide : null;
    const chans = await renderView(wideR, wideCanvas, wideRead, NW, t, frames, y, p, fw, pv);
    prevWide = { gray: chans[0]!, yaw: y, pitch: p, fov: fw, step };
    let best: { yaw: number; pitch: number; psr: number } | null = null;
    for (const oy of [0, N / 2, N]) for (const ox of [0, N / 2, N]) {
      const res = mosse.find(chans.map((c) => crop(c, ox, oy)));
      const px = ox + N / 2 + res.dx, py = oy + N / 2 + res.dy;
      const d = directionAt({ ...DEFAULT_LOOK, yaw: y, pitch: p, roll: 0, fov: fw, fisheye: 0 }, 1, (px - NW / 2) / (NW / 2), -(py - NW / 2) / (NW / 2));
      if (d && (!best || res.psr > best.psr)) best = { ...d, psr: res.psr };
    }
    return best;
  };

  /**
   * "Where is something moving" weights for the response: a blurred, normalised motion map
   * with a small floor. Null when nothing in view is clearly moving (still subject).
   */
  const motionPrior = (patch: Float64Array[]): Float64Array | null => {
    if (TRACKER.motion <= 0 || !prev || TRACKER.priorFloor >= 1) return null;
    const m = patch[patch.length - 1]!;
    let max = 0;
    for (let i = 0; i < m.length; i++) if (m[i]! > max) max = m[i]!;
    if (max < 8) return null;
    // Spread each moving pixel over a few pixels so the subject's whole area counts.
    const r = 3, out = new Float64Array(N * N);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let s0 = 0, c = 0;
        for (let dy = -r; dy <= r; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= N) continue;
          for (let dx = -r; dx <= r; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= N) continue;
            s0 += m[yy * N + xx]!; c++;
          }
        }
        out[y * N + x] = s0 / c;
      }
    let omax = 0;
    for (let i = 0; i < out.length; i++) if (out[i]! > omax) omax = out[i]!;
    const fl = TRACKER.priorFloor;
    for (let i = 0; i < out.length; i++) out[i] = fl + (1 - fl) * Math.sqrt(out[i]! / omax);
    return out;
  };
  /** The previous step's final patch (brightness) and where it was aimed. */
  let prev: Prev | null = null;
  const remember = (patch: Float64Array[], y: number, p: number, f: number) => {
    prev = { gray: patch[0]!, yaw: y, pitch: p, fov: f, step };
  };
  /** Moves the aim to where (dx, dy) pixels of the current patch point. */
  const reaim = (dx: number, dy: number) => {
    const d = directionAt({ ...DEFAULT_LOOK, yaw, pitch, roll: 0, fov, fisheye: 0 }, 1, dx / (N / 2), -dy / (N / 2));
    if (d) ({ yaw, pitch } = d);
  };

  let probeLog: number[] = [];
  const framesFor = async (t: number): Promise<VideoFrame[]> => {
    for (let tries = 0; ; tries++) {
      for (const d of decs) void d.pump();
      const frames = decs.map((d) => d.frameAt(t));
      if (frames.every(Boolean)) return frames as VideoFrame[];
      if (tries > 3000) throw new Error(`Decoding stalled at ${(t / 1e6).toFixed(2)}s`);
      await sleep(2);
    }
  };

  try {
    // Probe: over the first few frames, is the box what moves, or does everything move?
    if (TRACKER.motion > 0 && times.length > 8) {
      let inS = 0, inC = 0, outS = 0, outC = 0;
      const rad = Math.max(2, ((s.sizeDeg / fov) * N) / 2);
      for (let k = 0; k < 6; k++) {
        const fr = await framesFor(times[k]!);
        const pt = await patchAt(times[k]!, fr, yaw, pitch, fov);
        if (prev) {
          const m = pt[pt.length - 1]!;
          for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
            const d = Math.hypot(x - N / 2, y - N / 2);
            if (d <= rad) { inS += m[y * N + x]!; inC++; } else if (d > rad * 1.3) { outS += m[y * N + x]!; outC++; }
          }
        }
        remember(pt, yaw, pitch, fov);
      }
      const inMean = inS / Math.max(1, inC);
      motionFocus = inC && outC ? inS / inC / Math.max(0.5, outS / outC) : 0;
      moving = inMean > 1.5 && motionFocus > TRACKER.movingFocus;
      if (moving) mosse.weights[nApp] = TRACKER.movingMotion;
      probeLog = [inS / Math.max(1, inC), outS / Math.max(1, outC)];
      prev = null;
      decs.forEach((d) => d.seek(times[0]!));
    }
    for (let i = 0; i < times.length; i++) {
      if (signal.aborted) return { points, cancelled: true };
      const t = times[i]!;
      const fast = Math.hypot(vel.yaw, vel.pitch) > fov * TRACKER.fastStep;
      if (i > warmup && (i - warmup) % every !== 0 && !fast && !coastStart) continue;
      step++;
      const fr = await framesFor(t);
      if (i < warmup) {
        remember(await patchAt(t, fr, yaw, pitch, fov), yaw, pitch, fov);
        continue;
      }
      if (i === warmup) {
        const p0 = await patchAt(t, fr, yaw, pitch, fov);
        mosse.init(p0);
        remember(p0, yaw, pitch, fov);
        points.push({ t, yaw, pitch, size: sizeNow() });
        continue;
      }
      // Find the subject, re-aim, and look again until the correction is tiny. If the first
      // look is unsure (something passing in front), don't trust it: coast instead.
      let psr = 0;
      const before = { yaw, pitch };
      // Pre-aim along the subject's recent motion so fast movers stay inside the view.
      if (TRACKER.predict > 0 && !coastStart) {
        yaw += vel.yaw * TRACKER.predict;
        pitch = Math.max(-89, Math.min(89, pitch + vel.pitch * TRACKER.predict));
      }
      for (let pass = 0; pass < 3; pass++) {
        const pt = await patchAt(t, fr, yaw, pitch, fov);
        const res = mosse.find(pt, motionPrior(pt) ?? undefined);
        psr = res.psr;
        if (pass === 0 && TRACKER.wide && (psr < TRACKER.wideBelowPsr || lastPsr < TRACKER.wideBelowPsr)) {
          // Fast or unsure: look in the wide view too; take it only if clearly better.
          const w = await wideSearch(t, fr, yaw, pitch);
          wideUsed++;
          if (w && w.psr > Math.max(psr * TRACKER.wideMargin, LOST_PSR)) {
            yaw = w.yaw;
            pitch = w.pitch;
            psr = w.psr;
            wideTaken++;
            continue; // refine in the narrow view from the new aim
          }
        }
        if (psr < LOST_PSR) break;
        reaim(res.dx, res.dy);
        if (Math.hypot(res.dx, res.dy) < 0.3) break;
      }
      // Small drifts add up unnoticed (the filter re-learns whatever is centred): pull the aim
      // gently towards the middle of the movement around the subject.
      if (moving && TRACKER.recentre > 0 && psr >= LOST_PSR) {
        const m = (await patchAt(t, fr, yaw, pitch, fov)).at(-1)!;
        const rad = Math.max(4, Math.min(N * 0.4, (sizeEst / fov) * N * 0.75));
        let max = 0;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x - N / 2, y - N / 2) <= rad) max = Math.max(max, m[y * N + x]!);
        if (max > 8) {
          let w = 0, sx = 0, sy = 0;
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            if (Math.hypot(x - N / 2, y - N / 2) > rad) continue;
            const v = m[y * N + x]! - max * 0.3;
            if (v > 0) { w += v; sx += v * (x - N / 2); sy += v * (y - N / 2); }
          }
          if (w > 0) reaim((sx / w) * TRACKER.recentre, (sy / w) * TRACKER.recentre);
        }
      }
      lastPsr = psr;
      confidence.push(+psr.toFixed(1));
      if (psr < LOST_PSR) {
        // Unsure: search a 3×3 grid of nearby views (half a view apart) around where the
        // subject should be; snap back if one of them clearly finds it.
        const guess = { yaw: before.yaw + vel.yaw, pitch: before.pitch + vel.pitch };
        let found: { yaw: number; pitch: number; psr: number } | null = null;
        for (const oy of [-0.7, 0, 0.7]) for (const ox of [-0.7, 0, 0.7]) {
          const d = directionAt({ ...DEFAULT_LOOK, yaw: guess.yaw, pitch: guess.pitch, roll: 0, fov, fisheye: 0 }, 1, ox, oy);
          if (!d) continue;
          const pt = await patchAt(t, fr, d.yaw, d.pitch, fov);
          const res = mosse.find(pt, motionPrior(pt) ?? undefined);
          if (res.psr > (found?.psr ?? REACQUIRE_PSR)) {
            ({ yaw, pitch } = d);
            reaim(res.dx, res.dy);
            found = { yaw, pitch, psr: res.psr };
          }
        }
        if (found) {
          ({ yaw, pitch } = found);
          psr = found.psr;
          confidence[confidence.length - 1] = +psr.toFixed(1);
        }
      }
      if (psr < LOST_PSR) {
        // Blocked or unsure: keep moving the way the subject was going (slowing down), and
        // give up only after COAST_US without seeing it again.
        ({ yaw, pitch } = before);
        yaw += vel.yaw * 0.9;
        pitch += vel.pitch * 0.9;
        vel = { yaw: vel.yaw * 0.9, pitch: vel.pitch * 0.9 };
        coastStart ??= { index: points.length, t };
        if (t - coastStart.t > COAST_US) {
          return { points: points.slice(0, coastStart.index), lostAt: coastStart.t, confidence, blobs: blobLog, wide: { searched: wideUsed, taken: wideTaken }, motionFocus, probe: probeLog };
        }
        points.push({ t, yaw, pitch, size: sizeNow() });
        continue;
      }
      if (coastStart) {
        // Found it again: replace the guessed stretch with a straight line between the last
        // sure point and this one.
        const a0 = points[coastStart.index - 1];
        if (a0) {
          for (let k = coastStart.index; k < points.length; k++) {
            const f = (points[k]!.t - a0.t) / (t - a0.t);
            points[k] = { t: points[k]!.t, yaw: a0.yaw + wrapDeg(yaw - a0.yaw) * f, pitch: a0.pitch + (pitch - a0.pitch) * f, size: (a0.size ?? sizeEst) * (sizeEst / (a0.size ?? sizeEst)) ** f };
          }
        }
        coastStart = null;
      }
      const prev = points[points.length - 1];
      if (prev) vel = { yaw: wrapDeg(yaw - prev.yaw), pitch: pitch - prev.pitch };
      // Every few steps, check whether the subject got bigger or smaller.
      if (!motionSized && step % 2 === 0 && psr > 6) {
        let best = { f: fov, psr };
        for (const k of TRACKER.scaleSteps) {
          const f = Math.max(TRACKER.minFov, Math.min(TRACKER.maxFov, fov * k));
          if (f === fov) continue;
          const p = mosse.find(await patchAt(t, fr, yaw, pitch, f)).psr;
          if (p > best.psr * 1.02) best = { f, psr: p };
        }
        fov = fov + (best.f - fov) * TRACKER.scaleAdopt;
        sizeEst = (s.sizeDeg * fov) / fov0;
      }
      // Learn the subject's new appearance (only when confident, so we don't learn background).
      {
        const patch = await patchAt(t, fr, yaw, pitch, fov);
        if (psr > 7) mosse.update(patch);
        remember(patch, yaw, pitch, fov);
        motionSized = updateSize(patch);
        debugPatches?.push(patch[patch.length - 1]!);
      }
      points.push({ t, yaw, pitch, size: sizeNow() });
      if (i % 5 === 0) onProgress(i / times.length);
    }
    return { points, confidence, blobs: blobLog, wide: { searched: wideUsed, taken: wideTaken }, motionFocus, probe: probeLog };
  } finally {
    wideR.destroy();
    decs.forEach((d) => d.close());
    r.destroy();
  }
}

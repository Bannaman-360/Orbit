// Stabilising clips that have no motion data: the camera's turns are worked out from the picture
// (optical flow, see packages/media360/src/flow.ts) and given to the clip as if the camera had
// recorded them, so the usual smoothing, crop planning and horizon tools all work on them.
// The result is kept on this computer, so it is worked out once per file.

import { TrackDecoder } from '@ace/engine';
import { matToQuat, mulMat, quatToMat, rotZ, transpose, type Mat3 } from '@ace/media360';
import { Stabilizer, type OrientationData } from '@ace/telemetry';
import { ace } from './api';
import type { Media } from './media';

/** Width the frames are analysed at. */
const ANALYSIS_W = 480;
/** Seconds analysed either side of the clip (smoothing looks a little beyond its ends). */
const MARGIN_US = 1_000_000;
const FILE_VERSION = 1;

/** One run of analysed frames: times (µs) and the camera's orientation (picture-steady axes), 4 numbers each. */
export interface FlowSegment { t: number[]; q: number[] }
interface FlowFile { version: number; segments: FlowSegment[] }

const segments = new Map<string, FlowSegment[]>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether a clip can be stabilised from its picture: a regular clip without the camera's motion data. */
export const canAnalyse = (m: Media | null | undefined): m is Media => !!m && !!m.lens && !m.is360 && (!m.stabilizer.hasOrientation || motionFromPicture(m));
/** Its motion was worked out from the picture. */
export const motionFromPicture = (m: Media) => !!segments.get(m.path)?.length;
/** Whether the part of the file from…to has been analysed. */
export const analysed = (m: Media, fromUs: number, toUs: number) => (segments.get(m.path) ?? []).some((s) => s.t[0]! <= fromUs + 50_000 && s.t[s.t.length - 1]! >= toUs - 50_000);

// (The camera's own axes and the picture's differ when the picture is stored turned; see frameRender.ts.)
const P: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, 1];

/** Joins the analysed runs into orientation data: between runs the camera is taken to hold still. */
export function flowOrientation(segs: FlowSegment[], turns: number): OrientationData {
  const Q = rotZ(((turns & 3) * Math.PI) / 2);
  const cori: OrientationData['cori'] = [];
  let carry: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const s of [...segs].sort((a, b) => a.t[0]! - b.t[0]!)) {
    let last = carry;
    for (let i = 0; i < s.t.length; i++) {
      const R = mulMat(carry, quatToMat([s.q[i * 4]!, s.q[i * 4 + 1]!, s.q[i * 4 + 2]!, s.q[i * 4 + 3]!]));
      // Picture axes → the camera's, then into the convention of recorded orientation (CORI).
      const cam = mulMat(mulMat(Q, R), transpose(Q));
      cori.push({ t: s.t[i]!, q: matToQuat(mulMat(mulMat(P, cam), P)) });
      last = R;
    }
    carry = last;
  }
  return { grav: [], cori, streams: ['picture motion'] };
}

function use(m: Media) {
  const segs = segments.get(m.path);
  if (!segs?.length) return;
  m.stabilizer = new Stabilizer(flowOrientation(segs, m.turns));
}

/** Loads motion worked out earlier for this file (when it has none of its own). */
export async function loadPictureMotion(m: Media): Promise<boolean> {
  if (m.is360 || !m.lens || m.stabilizer.hasOrientation) return false;
  try {
    const { path, exists } = await ace.motionPath(m.path);
    if (!exists) return false;
    const f = JSON.parse(new TextDecoder().decode(await ace.readAll(path))) as FlowFile;
    if (f.version !== FILE_VERSION || !Array.isArray(f.segments) || !f.segments.length) return false;
    segments.set(m.path, f.segments.filter((s) => Array.isArray(s.t) && Array.isArray(s.q) && s.q.length === s.t.length * 4 && s.t.length > 1));
    use(m);
    return true;
  } catch {
    return false;
  }
}

/**
 * Works out how the camera turned over part of a file, frame by frame. Returns the run
 * (orientation relative to its first frame, in the picture's axes). `onProgress`: 0–1.
 */
export async function measureMotion(m: Media, fromUs: number, toUs: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<FlowSegment & { lost: number }> {
  if (!m.lens) throw new Error('Only regular clips can be stabilised from their picture.');
  const track = m.tracks[0]!;
  const all = track.samples.map((s) => s.timestamp).sort((a, b) => a - b);
  // About 60 pictures a second is plenty (high-frame-rate footage skips some).
  const every = Math.max(1, Math.round(m.fps / 60));
  const times = all.filter((t) => t >= fromUs && t <= toUs).filter((_, i) => i % every === 0);
  if (times.length < 2) throw new Error('This part of the clip is too short to work out its motion.');
  const W = ANALYSIS_W, H = Math.max(16, Math.round((ANALYSIS_W * m.height) / m.width));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const worker = new Worker(new URL('./flowWorker.ts', import.meta.url), { type: 'module' });
  const results = new Map<number, { q: [number, number, number, number] | null; inliers: number }>();
  let wake: (() => void) | null = null;
  worker.onmessage = (e: MessageEvent<{ id: number; q: [number, number, number, number] | null; inliers: number }>) => { results.set(e.data.id, e.data); wake?.(); };
  worker.postMessage({ kind: 'start', lens: m.lens, w: W, h: H });
  const dec = new TrackDecoder(m.reader, track);
  dec.maxAhead = 8;
  dec.seek(times[0]!);
  const t: number[] = [], q: number[] = [];
  let R: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let lastTurn: Mat3 | null = null;
  let lost = 0, sent = 0, got = 0;
  const take = (i: number) => {
    const r = results.get(i)!;
    results.delete(i);
    if (i === 0) { t.push(times[0]!); q.push(1, 0, 0, 0); return; }
    // b = M·a: directions in this frame from those in the one before. The camera turned by Mᵀ.
    let M: Mat3 | null = r.q ? quatToMat(r.q) : null;
    if (!M) {
      lost++;
      // Nothing to go on: keep turning as before, a little less each time.
      M = lastTurn ? quatToMat(halfway(matToQuat(lastTurn))) : null;
    }
    if (M) { R = mulMat(R, transpose(M)); lastTurn = M; }
    t.push(times[i]!);
    const qq = matToQuat(R);
    q.push(qq[0], qq[1], qq[2], qq[3]);
  };
  try {
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      let f: VideoFrame | null = null;
      for (let tries = 0; ; tries++) {
        void dec.pump();
        f = dec.frameAt(times[i]!);
        if (f) break;
        if (tries > 3000) throw new Error(`Decoding stalled at ${(times[i]! / 1e6).toFixed(2)} s`);
        await sleep(2);
      }
      // Drawn upright, the way the lens describes the picture.
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate((m.turns * Math.PI) / 2);
      const sw = m.turns % 2 ? H : W, sh = m.turns % 2 ? W : H;
      ctx.drawImage(f, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
      const px = ctx.getImageData(0, 0, W, H).data;
      const gray = new Float32Array(W * H);
      for (let k = 0, j = 0; k < gray.length; k++, j += 4) gray[k] = 0.299 * px[j]! + 0.587 * px[j + 1]! + 0.114 * px[j + 2]!;
      worker.postMessage({ kind: 'frame', id: i, gray }, [gray.buffer]);
      sent++;
      // Results come back in order; keep a few frames in flight.
      while (results.has(got) || sent - got > 4) {
        if (results.has(got)) { take(got++); continue; }
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
      if (i % 15 === 0) onProgress(i / times.length);
    }
    while (got < sent) {
      if (results.has(got)) { take(got++); continue; }
      await new Promise<void>((r) => { wake = r; });
      wake = null;
    }
  } finally {
    dec.close();
    worker.terminate();
  }
  onProgress(1);
  return { t, q, lost };
}

/** Half of a turn (for carrying on through frames that can't be measured). */
function halfway(q: [number, number, number, number]): [number, number, number, number] {
  const w = q[0] + 1, n = Math.hypot(w, q[1], q[2], q[3]) || 1;
  return [w / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * Works out the motion of the part of a file a clip uses (with a margin) and gives it to the
 * file: from then on it stabilises like footage with motion data. Kept on this computer.
 */
export async function stabiliseFromPicture(m: Media, inUs: number, outUs: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<{ lost: number; frames: number }> {
  const from = Math.max(0, inUs - MARGIN_US), to = Math.min(m.durationUs, outUs + MARGIN_US);
  const seg = await measureMotion(m, from, to, onProgress, signal);
  const kept = (segments.get(m.path) ?? []).filter((s) => s.t[s.t.length - 1]! < from || s.t[0]! > to);
  const segs = [...kept, { t: seg.t, q: seg.q }].sort((a, b) => a.t[0]! - b.t[0]!);
  segments.set(m.path, segs);
  use(m);
  try {
    const { path } = await ace.motionPath(m.path);
    // (Rounded: the file stays small.)
    const round = (s: FlowSegment): FlowSegment => ({ t: s.t, q: s.q.map((v) => Math.round(v * 1e6) / 1e6) });
    await ace.writeFile(path, JSON.stringify({ version: FILE_VERSION, segments: segs.map(round) } satisfies FlowFile));
  } catch { /* kept for this session only */ }
  return { lost: seg.lost, frames: seg.t.length };
}

/** Forgets the motion worked out for a file (back to no motion data). */
export async function forgetPictureMotion(m: Media) {
  segments.delete(m.path);
  m.stabilizer = new Stabilizer(null);
  try { const { path } = await ace.motionPath(m.path); await ace.writeFile(path, JSON.stringify({ version: FILE_VERSION, segments: [] })); } catch { /* nothing kept */ }
}

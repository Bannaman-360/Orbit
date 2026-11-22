// One rendering step shared by preview, export and frame grabs, so they always match.

import { NO_EFFECTS, NEUTRAL_GRADE, applyTrack, blurFrames, lookAt, type Look, type TimelineClip } from '@ace/project';
import { DEFAULT_AXIS_MAP } from '@ace/telemetry';
import type { ReframeRenderer, RenderMode } from '@ace/media360';
import { mediaNow, type Media } from './media';
import { frameShare, mulMat, mulVec, transpose, type Vec3 } from '@ace/media360';

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
  if (!media.is360) return { yaw, pitch };
  const Cw = media.stabilizer.correctionAt(t, { ...WORLD_STABILIZE, axisMap: DEFAULT_AXIS_MAP });
  const Cc = media.stabilizer.correctionAt(t, { ...clip.stabilize, axisMap: DEFAULT_AXIS_MAP });
  return anglesOf(mulVec(mulMat(Cc, transpose(Cw)), dirOf(yaw, pitch)));
}
export function clipViewToWorld(media: Media, clip: TimelineClip, t: number, yaw: number, pitch: number) {
  if (!media.is360) return { yaw, pitch };
  const Cw = media.stabilizer.correctionAt(t, { ...WORLD_STABILIZE, axisMap: DEFAULT_AXIS_MAP });
  const Cc = media.stabilizer.correctionAt(t, { ...clip.stabilize, axisMap: DEFAULT_AXIS_MAP });
  return anglesOf(mulVec(mulMat(Cw, transpose(Cc)), dirOf(yaw, pitch)));
}

/** The clip's look at a media time: keyframes, then subject tracking (pan/tilt). */
export function clipLookAt(clip: TimelineClip, mediaUs: number): Look {
  const look = lookAt(clip.keyframes, clip.look, mediaUs);
  if (!clip.track) return look;
  const media = mediaNow(clip.mediaPath);
  return applyTrack(look, clip.track, mediaUs, media ? (y, p, t) => worldToClipView(media, clip, t, y, p) : undefined, frameShare);
}

/** The clip's own look (keyframes or settings), without what tracking does to it. */
export const ownLookAt = (clip: TimelineClip, mediaUs: number): Look => lookAt(clip.keyframes, clip.look, mediaUs);

export function pushClipFrame(r: ReframeRenderer, clip: TimelineClip, media: Media, mediaUs: number, frames: VideoFrame[], opts: { raw?: boolean; showTiles?: boolean } = {}) {
  const look = clipLookAt(clip, mediaUs);
  const mode: RenderMode = media.is360 ? (opts.raw ? 'raw' : '360') : 'flat';
  r.pushFrame({
    frames: frames as [VideoFrame, VideoFrame],
    mode,
    view: { yaw: look.yaw, pitch: look.pitch, roll: look.roll, fov: look.fov, fisheye: look.fisheye, autoLens: true },
    correction: mode === '360' ? media.stabilizer.correctionAt(mediaUs, { ...clip.stabilize, axisMap: DEFAULT_AXIS_MAP }) : undefined,
    showTiles: opts.showTiles,
    fill: clip.fit === 'fill',
  });
  return look;
}

/** `time` (µs of media time) animates grain and light leaks. */
export function presentLook(r: ReframeRenderer, look: Look, opts: { raw?: boolean; time?: number } = {}) {
  r.present({ blendFrames: blurFrames(look.motionBlur), grade: look.grade, bypass: opts.raw, fx: look.fx, time: (opts.time ?? 0) / 1e6 });
}

/** The same view with nothing done to the picture: no colour, LUT, sharpening, effects or motion blur. */
export const withoutEffects = (look: Look): Look => ({ ...look, grade: { ...NEUTRAL_GRADE, lutMix: 0 }, fx: NO_EFFECTS, motionBlur: 0 });

/** Everything that changes the reframe pass (as opposed to grading), for change detection. */
export function reframeSignature(clip: TimelineClip, look: Look, extra: string) {
  return `${clip.id}|${look.yaw.toFixed(3)}|${look.pitch.toFixed(3)}|${look.roll.toFixed(3)}|${look.fov.toFixed(3)}|${look.fisheye.toFixed(4)}|${clip.stabilize.smoothing}:${clip.stabilize.strength ?? ''}|${clip.stabilize.horizon}|${clip.fit}|${extra}`;
}

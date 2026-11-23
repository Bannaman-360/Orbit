// The edit: an ordered row of video clips (360 or flat) plus a music track.
//
// Times: "media time" is a position inside a source file; "timeline time" is a
// position in the finished edit. Both are microseconds. A clip shows media
// [inUs, outUs) and lasts (outUs − inUs) / speed on the timeline (see speed.ts for ramps).

import type { Keyframe } from './keyframes';
import { DEFAULT_LOOK, NEUTRAL_GRADE, NO_EFFECTS, type Look } from './look';
import { fixOverlay, type Overlay } from './overlays';
import { fixSpeedKeys, localAt, mediaAt, playLength, type SpeedKey } from './speed';
import type { ClipTrack } from './track';
import type { LensLook } from './lensLook';

export type TransitionKind =
  | 'crossfade' | 'dip-black' | 'dip-white' | 'flash' | 'blur'
  | 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down' | 'barn-door' | 'iris' | 'diagonal' | 'clock'
  | 'slide-left' | 'slide-right' | 'push-up' | 'push-down' | 'cover-left' | 'whip-left' | 'whip-right'
  | 'zoom' | 'zoom-through' | 'spin';

/** Transitions, grouped for the picker. */
export const TRANSITION_GROUPS: [string, [TransitionKind, string][]][] = [
  ['Fades', [['crossfade', 'Crossfade'], ['dip-black', 'Dip to black'], ['dip-white', 'Dip to white'], ['flash', 'Flash'], ['blur', 'Blur dissolve']]],
  ['Wipes', [['wipe-left', 'Wipe left'], ['wipe-right', 'Wipe right'], ['wipe-up', 'Wipe up'], ['wipe-down', 'Wipe down'], ['barn-door', 'Barn door'], ['iris', 'Iris'], ['diagonal', 'Diagonal'], ['clock', 'Clock']]],
  ['Motion', [['slide-left', 'Slide left'], ['slide-right', 'Slide right'], ['push-up', 'Push up'], ['push-down', 'Push down'], ['cover-left', 'Cover'], ['whip-left', 'Whip pan left'], ['whip-right', 'Whip pan right']]],
  ['Camera', [['zoom', 'Zoom in'], ['zoom-through', 'Zoom through'], ['spin', 'Spin']]],
];

export const TRANSITIONS: [TransitionKind, string][] = TRANSITION_GROUPS.flatMap(([, list]) => list);

/** How a clip enters from the one before it. The two clips overlap by `durationUs`. */
export interface Transition {
  kind: TransitionKind;
  durationUs: number;
}

export type Smoothing = 'off' | 'low' | 'medium' | 'high' | 'locked' | 'custom';

export interface StabilizeSettings {
  smoothing: Smoothing;
  /** Smoothing window (σ, seconds) used when smoothing is 'custom'. */
  strength?: number;
  horizon: boolean;
  /** Regular clips: how the picture is cropped to hide the moving edges. Missing = automatic. */
  crop?: 'auto' | 'manual';
  /** Automatic: seconds the zoom takes to change (0 = one zoom for the whole clip). */
  cropSpeed?: number;
  /** Automatic: most of the field of view it may give up (0–0.8). */
  maxCrop?: number;
  /** Manual: share of the field of view given up. */
  cropAmount?: number;
  /** Regular clips: undo the wobble of the sensor's rolling shutter. Missing = off. */
  rolling?: boolean;
}

export const DEFAULT_CROP = { cropSpeed: 2, maxCrop: 0.35, cropAmount: 0.1 };

export interface Framing {
  label: string;
  /** Output aspect ratio, width / height. */
  aspect: number;
}

export const FRAMINGS: Framing[] = [
  { label: '16:9', aspect: 16 / 9 },
  { label: '9:16', aspect: 9 / 16 },
  { label: '1:1', aspect: 1 },
  { label: '4:5', aspect: 4 / 5 },
  { label: '4:3', aspect: 4 / 3 },
  { label: '21:9', aspect: 21 / 9 },
];

export const framingAspect = (label: string) => FRAMINGS.find((f) => f.label === label)?.aspect ?? 16 / 9;

/** What a clip's recorded values mean. 'raw' = not converted (for a LUT made for the camera). */
export type InputChoice = 'auto' | 'standard' | 'gplog' | 'gplog2' | 'flat' | 'hlg' | 'raw';

export interface TimelineClip {
  id: string;
  mediaPath: string;
  inUs: number;
  outUs: number;
  /** Playback speed, 0.1–8 (when there is no ramp). */
  speed: number;
  /** A speed ramp (see speed.ts). */
  speedKeys?: SpeedKey[];
  /** The clip's sound is silent where it plays slower than this. Missing = never. */
  muteBelow?: number;
  /** At other speeds the sound keeps its pitch (stretched in time). Missing = yes. */
  keepPitch?: boolean;
  /** Base look (used when there are no keyframes). */
  look: Look;
  /** Keyframe times are media times, so they stay put when the clip is trimmed or split. */
  keyframes: Keyframe[];
  stabilize: StabilizeSettings;
  /** Volume of the clip's own audio, 0–1.5. */
  volume: number;
  /** Non-360 clips: crop to fill the frame, or fit inside it with bars. */
  fit: 'fill' | 'fit';
  /**
   * Regular clips: which lens the view uses. Missing = never reframed, so the clip is shown
   * exactly as recorded and its look's view settings are ignored.
   */
  lensMode?: 'source' | 'custom';
  /** Regular clips: the user's correction of the detected lens. */
  lensFix?: { hfov?: number; bend?: number };
  /** Transition from the previous clip into this one (ignored on the first clip). */
  transitionIn?: Transition;
  /** Missing = auto. */
  inputColor?: InputChoice;
  /** The fisheye follows the field of view to keep this look (see lensLook.ts). Missing = a fixed fisheye. */
  lensLook?: LensLook;
  /** 360 clips: corrections for each lens (see lensMatch.ts). */
  lenses?: { front?: Record<string, number>; back?: Record<string, number> };
  /** The camera recorded wide (Rec.2020) colours. Missing = as the file says. */
  wideColor?: boolean;
  /** The clip's sound was moved to the audio track (see detachAudio). */
  audioDetached?: boolean;
  /** Subject tracking: pan/tilt follow this path (see track.ts). */
  track?: ClipTrack;
}

export interface AudioClip {
  id: string;
  path: string;
  /** Where the music starts on the timeline. */
  startUs: number;
  /** Part of the audio file used. */
  inUs: number;
  outUs: number;
  volume: number;
  fadeInUs: number;
  fadeOutUs: number;
  /** Playback speed (detached clip audio keeps its clip's speed). */
  speed?: number;
  speedKeys?: SpeedKey[];
  muteBelow?: number;
  keepPitch?: boolean;
  /** Set when this is a video clip's own sound, detached onto the audio track. */
  linkedClipId?: string;
}

export interface Timeline {
  version: 1;
  clips: TimelineClip[];
  audio: AudioClip[];
  framing: string;
  /** LUT (.cube) available to all clips; each clip's grade sets how strongly it applies. */
  lutPath: string | null;
  /** Text and telemetry overlays drawn on top of the video. */
  overlays: Overlay[];
}

export const MIN_CLIP_US = 100_000;

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const emptyTimeline = (): Timeline => ({ version: 1, clips: [], audio: [], framing: '16:9', lutPath: null, overlays: [] });

export function newClip(mediaPath: string, durationUs: number, is360: boolean): TimelineClip {
  return {
    id: newId('c'),
    mediaPath,
    inUs: 0,
    outUs: durationUs,
    speed: 1,
    look: { ...DEFAULT_LOOK, fov: is360 ? 100 : 100 },
    keyframes: [],
    stabilize: { smoothing: is360 ? 'medium' : 'off', horizon: is360 },
    volume: 1,
    fit: 'fill',
  };
}

export const clipDuration = (c: TimelineClip) => playLength(c);

/** Overlap between clip i and the one before it (its transition, limited to half of either clip). */
export function transitionUs(tl: Timeline, i: number): number {
  const c = tl.clips[i];
  if (!c?.transitionIn || i === 0) return 0;
  const prev = tl.clips[i - 1]!;
  return Math.max(0, Math.min(c.transitionIn.durationUs, clipDuration(c) / 2, clipDuration(prev) / 2));
}

/** Timeline start of each clip (a transition pulls a clip back over the end of the previous one). */
export function clipStarts(tl: Timeline): number[] {
  const out: number[] = [];
  let t = 0;
  tl.clips.forEach((c, i) => {
    if (i > 0) t -= transitionUs(tl, i);
    out.push(t);
    t += clipDuration(c);
  });
  return out;
}

export function timelineDuration(tl: Timeline): number {
  if (!tl.clips.length) return 0;
  const starts = clipStarts(tl);
  const last = tl.clips.length - 1;
  return starts[last]! + clipDuration(tl.clips[last]!);
}

export interface Located {
  index: number;
  clip: TimelineClip;
  /** Timeline time where the clip starts. */
  startUs: number;
  /** Media time inside the clip's source file. */
  mediaUs: number;
}

const locatedAt = (tl: Timeline, i: number, start: number, T: number): Located => {
  const c = tl.clips[i]!;
  const local = Math.max(0, Math.min(clipDuration(c), T - start));
  return { index: i, clip: c, startUs: start, mediaUs: Math.min(c.outUs - 1, mediaAt(c, local)) };
};

/** Which clip is at timeline time T, and the media time it shows. During a transition this is the outgoing clip. */
export function locate(tl: Timeline, T: number): Located | null {
  const starts = clipStarts(tl);
  for (let i = 0; i < tl.clips.length; i++) {
    if (T < starts[i]! + clipDuration(tl.clips[i]!) || i === tl.clips.length - 1) return locatedAt(tl, i, starts[i]!, T);
  }
  return null;
}

/** What is on screen at T: one clip, or two during a transition (b = incoming, progress 0 → 1). */
export interface Layers {
  a: Located;
  b?: Located;
  transition?: Transition;
  progress: number;
}

export function layersAt(tl: Timeline, T: number): Layers | null {
  const a = locate(tl, T);
  if (!a) return null;
  const i = a.index + 1;
  const next = tl.clips[i];
  if (!next) return { a, progress: 0 };
  const starts = clipStarts(tl);
  const d = transitionUs(tl, i);
  if (d <= 0 || T < starts[i]!) return { a, progress: 0 };
  return { a, b: locatedAt(tl, i, starts[i]!, T), transition: next.transitionIn, progress: Math.min(1, (T - starts[i]!) / d) };
}

export const mediaToTimeline = (startUs: number, c: TimelineClip, mediaUs: number) => startUs + localAt(c, mediaUs);

const replaceClip = (tl: Timeline, id: string, f: (c: TimelineClip) => TimelineClip | TimelineClip[]): Timeline => ({
  ...tl,
  clips: tl.clips.flatMap((c) => (c.id === id ? f(c) : [c])),
});

export const updateClip = (tl: Timeline, id: string, patch: Partial<TimelineClip>) => replaceClip(tl, id, (c) => ({ ...c, ...patch }));

/** Changes a clip's speed or ramp; its sound, if detached, goes along. */
export function setClipSpeed(tl: Timeline, id: string, patch: Partial<Pick<TimelineClip, 'speed' | 'speedKeys' | 'muteBelow' | 'keepPitch'>>): Timeline {
  const next = updateClip(tl, id, patch);
  return next.audio.some((a) => a.linkedClipId === id) ? { ...next, audio: next.audio.map((a) => (a.linkedClipId === id ? { ...a, ...patch } : a)) } : next;
}

/**
 * After a clip got longer or shorter (speed, ramp, trim): text, gauges and detached clip sound
 * stay with the pictures they belonged to. Things after the clip move by the change; edges inside
 * it stay on the same moment of the recording. Music stays where it is, on its beat.
 */
export function rippleItems(before: Timeline, after: Timeline, clipId: string): Timeline {
  const i = before.clips.findIndex((c) => c.id === clipId), j = after.clips.findIndex((c) => c.id === clipId);
  if (i < 0 || j < 0) return after;
  const a = before.clips[i]!, b = after.clips[j]!;
  const s0 = clipStarts(before)[i]!, e0 = s0 + clipDuration(a), s1 = clipStarts(after)[j]!, e1 = s1 + clipDuration(b);
  if (Math.abs(s0 - s1) < 1 && Math.abs(e0 - e1) < 1 && a.inUs === b.inUs && a.outUs === b.outUs) return after;
  const move = (T: number) => {
    if (T <= s0) return T;
    if (T >= e0) return T + (e1 - e0);
    const m = mediaAt(a, T - s0);
    return m <= b.inUs ? s1 : m >= b.outUs ? e1 : s1 + localAt(b, m);
  };
  const MIN = 200_000;
  const total = timelineDuration(after);
  return {
    ...after,
    overlays: after.overlays.map((o) => {
      const st = move(o.startUs), en = Math.max(st + MIN, move(o.endUs));
      return st === o.startUs && en === o.endUs ? o : { ...o, startUs: Math.min(st, Math.max(0, total - MIN)), endUs: Math.min(en, Math.max(total, st + MIN)) };
    }),
    audio: after.audio.map((x) => (x.linkedClipId && x.linkedClipId !== clipId && x.startUs >= e0 ? { ...x, startUs: move(x.startUs) } : x)),
  };
}

export function addClip(tl: Timeline, clip: TimelineClip, index = tl.clips.length): Timeline {
  const clips = [...tl.clips];
  clips.splice(index, 0, clip);
  return { ...tl, clips };
}

/** Splits the clip under timeline time T in two. */
export function splitAt(tl: Timeline, T: number): Timeline {
  const at = locate(tl, T);
  if (!at) return tl;
  const { clip, mediaUs } = at;
  if (mediaUs - clip.inUs < MIN_CLIP_US || clip.outUs - mediaUs < MIN_CLIP_US) return tl;
  return replaceClip(tl, clip.id, (c) => [{ ...c, outUs: mediaUs }, { ...c, id: newId('c'), inUs: mediaUs }]);
}

export const removeClip = (tl: Timeline, id: string): Timeline => ({ ...tl, clips: tl.clips.filter((c) => c.id !== id) });

/**
 * Splits the clip under timeline time T and deletes the part of that clip on one side
 * (like "delete left / delete right" in Insta360 Studio). Other clips are untouched.
 */
export function deleteSideAt(tl: Timeline, T: number, side: 'left' | 'right'): Timeline {
  const at = locate(tl, T);
  if (!at) return tl;
  const { clip, mediaUs } = at;
  if (side === 'left') {
    if (clip.outUs - mediaUs < MIN_CLIP_US) return tl;
    return replaceClip(tl, clip.id, (c) => ({ ...c, inUs: mediaUs }));
  }
  if (mediaUs - clip.inUs < MIN_CLIP_US) return tl;
  return replaceClip(tl, clip.id, (c) => ({ ...c, outUs: mediaUs }));
}

export function moveClip(tl: Timeline, id: string, toIndex: number): Timeline {
  const from = tl.clips.findIndex((c) => c.id === id);
  if (from < 0) return tl;
  const clips = [...tl.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(clips.length, toIndex)), 0, c!);
  return { ...tl, clips };
}

export function duplicateClip(tl: Timeline, id: string): Timeline {
  const i = tl.clips.findIndex((c) => c.id === id);
  if (i < 0) return tl;
  return addClip(tl, { ...tl.clips[i]!, id: newId('c') }, i + 1);
}

/** Sets a clip's in/out points (media time), clamped to the source and a minimum length. */
export function trimClip(tl: Timeline, id: string, inUs: number, outUs: number, mediaDurationUs: number): Timeline {
  return replaceClip(tl, id, (c) => {
    const i = Math.max(0, Math.min(inUs, mediaDurationUs - MIN_CLIP_US));
    const o = Math.min(mediaDurationUs, Math.max(outUs, i + MIN_CLIP_US));
    return { ...c, inUs: i, outUs: o };
  });
}

// --- Music ---------------------------------------------------------------

export function newAudioClip(path: string, durationUs: number, startUs = 0): AudioClip {
  return { id: newId('a'), path, startUs, inUs: 0, outUs: durationUs, volume: 0.8, fadeInUs: 0, fadeOutUs: 1_500_000, speed: 1 };
}

/** Moves a video clip's own sound onto the audio track, where it can be moved, trimmed and faded. */
export function detachAudio(tl: Timeline, clipId: string): Timeline {
  const i = tl.clips.findIndex((c) => c.id === clipId);
  const c = tl.clips[i];
  if (!c || c.audioDetached) return tl;
  const start = clipStarts(tl)[i]!;
  const a: AudioClip = {
    id: newId('a'), path: c.mediaPath, startUs: start, inUs: c.inUs, outUs: c.outUs,
    volume: c.volume, fadeInUs: 0, fadeOutUs: 0, speed: c.speed, linkedClipId: c.id, ...(c.speedKeys ? { speedKeys: c.speedKeys } : {}), ...(c.muteBelow ? { muteBelow: c.muteBelow } : {}), ...(c.keepPitch === false ? { keepPitch: false } : {}),
  };
  return { ...updateClip(tl, c.id, { audioDetached: true }), audio: [...tl.audio, a] };
}

/** Puts a detached sound back on its clip (removes it from the audio track). */
export function reattachAudio(tl: Timeline, clipId: string): Timeline {
  const linked = tl.audio.find((a) => a.linkedClipId === clipId);
  return {
    ...updateClip(tl, clipId, { audioDetached: false, ...(linked ? { volume: linked.volume } : {}) }),
    audio: tl.audio.filter((a) => a.linkedClipId !== clipId),
  };
}

export const updateAudio = (tl: Timeline, id: string, patch: Partial<AudioClip>): Timeline => ({
  ...tl,
  audio: tl.audio.map((a) => (a.id === id ? { ...a, ...patch } : a)),
});

export const removeAudio = (tl: Timeline, id: string): Timeline => ({ ...tl, audio: tl.audio.filter((a) => a.id !== id) });

/** Timeline range an audio clip covers, cut at the end of the video. */
export function audioSpan(tl: Timeline, a: AudioClip): { start: number; end: number } {
  const end = Math.min(a.startUs + playLength(a), timelineDuration(tl));
  return { start: a.startUs, end: Math.max(a.startUs, end) };
}

/** Rows for drawing items that may overlap in time: each item gets the first free row. */
export function assignLanes<T extends { id: string }>(items: T[], span: (x: T) => { start: number; end: number }): Map<string, number> {
  const ends: number[] = [];
  const lanes = new Map<string, number>();
  for (const it of [...items].sort((a, b) => span(a).start - span(b).start)) {
    const { start, end } = span(it);
    let lane = ends.findIndex((e) => e <= start);
    if (lane < 0) lane = ends.length;
    ends[lane] = end;
    lanes.set(it.id, lane);
  }
  return lanes;
}

// --- Saving -----------------------------------------------------------------

const fixLook = (l?: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...l, grade: { ...NEUTRAL_GRADE, ...(l?.grade ?? {}) }, fx: { ...NO_EFFECTS, ...(l?.fx ?? {}) } });

/** Accepts anything previously saved and returns a complete, current timeline. */
export function loadTimeline(raw: unknown): Timeline {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Timeline>;
  const base = emptyTimeline();
  return {
    ...base,
    ...p,
    version: 1,
    clips: (p.clips ?? []).map((c) => ({
      ...newClip(c.mediaPath, c.outUs ?? 0, true),
      ...c,
      look: fixLook(c.look),
      keyframes: (c.keyframes ?? []).map((k) => ({ ...k, easing: k.easing ?? 'smooth', look: fixLook(k.look) })),
      stabilize: { ...{ smoothing: 'off' as const, horizon: false }, ...(c.stabilize ?? {}) },
      ...(c.speedKeys ? { speedKeys: fixSpeedKeys(c.speedKeys) } : {}),
    })),
    audio: (p.audio ?? []).map((a) => ({ ...newAudioClip(a.path, a.outUs ?? 0), ...a, ...(a.speedKeys ? { speedKeys: fixSpeedKeys(a.speedKeys) } : {}) })),
    overlays: (p.overlays ?? []).map(fixOverlay),
  };
}

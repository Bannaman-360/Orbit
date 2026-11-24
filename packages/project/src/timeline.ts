// The edit: an ordered row of video clips (360 or flat) plus a music track.
//
// Times: "media time" is a position inside a source file; "timeline time" is a
// position in the finished edit. Both are microseconds. A clip shows media
// [inUs, outUs) and lasts (outUs − inUs) / speed on the timeline (see speed.ts for ramps).

import type { Keyframe } from './keyframes';
import { DEFAULT_LOOK, NEUTRAL_GRADE, NO_EFFECTS, type Look } from './look';
import { fixOverlay, type Overlay } from './overlays';
import { fixSpeedKeys, localAt, mediaAt, playLength, speedAt, type SpeedKey } from './speed';
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
  /** How jumps are found in this clip (G below which it's in the air, shortest jump in ms). Missing = defaults. */
  airtime?: { below?: number; minMs?: number; shape?: boolean; joinMs?: number };
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

/** A note at a point in time (M key). Colours are a small fixed set, like Finder tags. */
export interface Marker {
  id: string;
  /** Timeline time, µs. */
  t: number;
  note: string;
  color: MarkerColor;
}
export type MarkerColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray';
export const MARKER_COLORS: MarkerColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

/** Project format version written by this app. Older ones are upgraded by `loadTimeline`. */
export const TIMELINE_VERSION = 2;

export interface Timeline {
  version: typeof TIMELINE_VERSION;
  clips: TimelineClip[];
  audio: AudioClip[];
  framing: string;
  /** LUT (.cube) available to all clips; each clip's grade sets how strongly it applies. */
  lutPath: string | null;
  /** Text and telemetry overlays drawn on top of the video. */
  overlays: Overlay[];
  /** Notes at points in time. */
  markers: Marker[];
}

export const MIN_CLIP_US = 100_000;

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const emptyTimeline = (): Timeline => ({ version: TIMELINE_VERSION, clips: [], audio: [], framing: '16:9', lutPath: null, overlays: [], markers: [] });

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
    // Markers stay on the picture they mark.
    markers: after.markers.map((m) => { const t = Math.max(0, Math.round(move(m.t))); return t === m.t ? m : { ...m, t }; }),
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
    // Version 1 (before markers) has nothing to convert: missing parts get their defaults.
    version: TIMELINE_VERSION,
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
    markers: (p.markers ?? []).filter((m) => m && Number.isFinite(m.t)).map((m) => ({ id: m.id || newId('m'), t: Math.max(0, m.t), note: String(m.note ?? ''), color: MARKER_COLORS.includes(m.color) ? m.color : 'blue' })).sort((a, b) => a.t - b.t),
  };
}

// --- Pro trims -----------------------------------------------------------------
// The main row is magnetic, so a plain trim is always a ripple. These keep the length of the
// edit (roll, slip) or of the clip (slip, slide) instead. Times in µs; `dur` gives each file's
// length so nothing runs past the end of its media.

/** Media time `d` of timeline time away from `mediaUs` (before the in point too). */
function mediaShift(c: TimelineClip, d: number): number {
  return d >= 0 ? mediaAt(c, d) : c.inUs + d * speedAt(c, c.inUs);
}

/**
 * Moves the cut after clip `leftId` by `d` (timeline µs): the clip before it gets longer, the one
 * after shorter, or the other way round. The edit keeps its length. Returns the new timeline and
 * how far the cut actually moved (limited by the media either side has).
 */
export function rollCut(tl: Timeline, leftId: string, d: number, dur: (path: string) => number): { tl: Timeline; moved: number } {
  const i = tl.clips.findIndex((c) => c.id === leftId);
  const a = tl.clips[i], b = tl.clips[i + 1];
  if (!a || !b) return { tl, moved: 0 };
  const lenA = playLength(a), lenB = playLength(b);
  // How far it can go: the left clip has media up to its file's end, the right one back to 0.
  const maxRight = Math.min(localAt(a, dur(a.mediaPath)) - lenA, lenB - MIN_CLIP_US);
  const maxLeft = Math.min(lenA - MIN_CLIP_US, b.inUs / Math.max(1e-6, speedAt(b, b.inUs)));
  const m = Math.max(-maxLeft, Math.min(maxRight, d));
  if (Math.abs(m) < 1) return { tl, moved: 0 };
  const out = mediaAt(a, lenA + m);
  const inn = mediaShift(b, m);
  const clips = [...tl.clips];
  clips[i] = { ...a, outUs: Math.round(out) };
  clips[i + 1] = { ...b, inUs: Math.round(Math.max(0, inn)) };
  return { tl: { ...tl, clips }, moved: m };
}

/**
 * Shows a different part of the same clip: in and out move together by `d` (media µs), so the
 * clip keeps its place and length. Keyframes and tracking stay on the picture they belong to;
 * a speed ramp stays where it is in the clip.
 */
export function slipClip(tl: Timeline, id: string, d: number, dur: (path: string) => number): Timeline {
  return replaceClip(tl, id, (c) => {
    const m = Math.max(-c.inUs, Math.min(dur(c.mediaPath) - c.outUs, d));
    if (!m) return c;
    return { ...c, inUs: c.inUs + m, outUs: c.outUs + m, ...(c.speedKeys ? { speedKeys: c.speedKeys.map((k) => ({ ...k, t: k.t + m })) } : {}) };
  });
}

/**
 * Moves a clip along the row by `d` (timeline µs) without changing it: the clip before gets
 * longer and the one after shorter (or the reverse). The edit keeps its length.
 */
export function slideClip(tl: Timeline, id: string, d: number, dur: (path: string) => number): Timeline {
  const i = tl.clips.findIndex((c) => c.id === id);
  const prev = tl.clips[i - 1], next = tl.clips[i + 1];
  if (i < 0 || !prev) return tl;
  // The clip before has media up to its file's end, and can't get shorter than the minimum…
  const lenP = playLength(prev);
  let lo = -(lenP - MIN_CLIP_US), hi = localAt(prev, dur(prev.mediaPath)) - lenP;
  // …and the clip after starts later (shorter) or earlier (needs media before its in point).
  if (next) {
    hi = Math.min(hi, playLength(next) - MIN_CLIP_US);
    lo = Math.max(lo, -next.inUs / Math.max(1e-6, speedAt(next, next.inUs)));
  }
  const m = Math.max(lo, Math.min(hi, d));
  if (Math.abs(m) < 1) return tl;
  return {
    ...tl,
    clips: tl.clips.map((c, k) => {
      if (k === i - 1) return { ...c, outUs: Math.round(mediaAt(c, lenP + m)) };
      if (k === i + 1) return { ...c, inUs: Math.round(Math.max(0, mediaShift(c, m))) };
      return c;
    }),
  };
}

// --- Three-point editing -------------------------------------------------------

/** Where on the main row a clip placed at T goes (cutting the clip under T in two first). */
function cutAt(tl: Timeline, T: number): { tl: Timeline; index: number } {
  const total = timelineDuration(tl);
  if (T >= total - 1) return { tl, index: tl.clips.length };
  const cut = splitAt(tl, T);
  const starts = clipStarts(cut);
  let index = starts.findIndex((s) => s >= T - 1000);
  if (index < 0) index = cut.clips.length;
  return { tl: cut, index };
}

/**
 * Insert: the clip goes in at T and everything after moves later to make room (titles, gauges,
 * markers and a clip's own sound move with their pictures; music stays).
 */
export function insertClipAt(tl: Timeline, clip: TimelineClip, T: number): Timeline {
  const { tl: cut, index } = cutAt(tl, T);
  const len = playLength(clip);
  const after = (t: number) => (t >= T - 1000 ? t + len : t);
  return {
    ...addClip(cut, clip, index),
    overlays: cut.overlays.map((o) => (o.startUs >= T - 1000 ? { ...o, startUs: o.startUs + len, endUs: o.endUs + len } : o)),
    markers: cut.markers.map((m) => ({ ...m, t: after(m.t) })),
    audio: cut.audio.map((a) => (a.linkedClipId && a.startUs >= T - 1000 ? { ...a, startUs: a.startUs + len } : a)),
  };
}

/** Overwrite: the clip replaces whatever is on the main row from T for its length. */
export function overwriteClipAt(tl: Timeline, clip: TimelineClip, T: number): Timeline {
  const len = playLength(clip);
  const first = cutAt(tl, T);
  const second = cutAt(first.tl, T + len);
  // The clips between the two cuts are covered by the new one.
  const keep = second.tl.clips.filter((_, i) => i < first.index || i >= second.index);
  const removed = new Set(second.tl.clips.filter((_, i) => i >= first.index && i < second.index).map((c) => c.id));
  const clips = [...keep.slice(0, first.index), clip, ...keep.slice(first.index)];
  return { ...second.tl, clips, audio: second.tl.audio.filter((a) => !a.linkedClipId || !removed.has(a.linkedClipId)) };
}

// --- Markers ------------------------------------------------------------------

export function addMarker(tl: Timeline, t: number, note = '', color: MarkerColor = 'blue'): { tl: Timeline; id: string } {
  const id = newId('m');
  return { tl: { ...tl, markers: [...tl.markers, { id, t: Math.max(0, Math.round(t)), note, color }].sort((a, b) => a.t - b.t) }, id };
}
export const updateMarker = (tl: Timeline, id: string, patch: Partial<Omit<Marker, 'id'>>): Timeline => ({
  ...tl,
  markers: tl.markers.map((m) => (m.id === id ? { ...m, ...patch, t: Math.max(0, Math.round(patch.t ?? m.t)) } : m)).sort((a, b) => a.t - b.t),
});
export const removeMarker = (tl: Timeline, id: string): Timeline => ({ ...tl, markers: tl.markers.filter((m) => m.id !== id) });
/** The marker nearest to t within `withinUs`, if any. */
export function markerNear(tl: Timeline, t: number, withinUs: number): Marker | undefined {
  let best: Marker | undefined;
  for (const m of tl.markers) if (Math.abs(m.t - t) <= withinUs && (!best || Math.abs(m.t - t) < Math.abs(best.t - t))) best = m;
  return best;
}
/**
 * YouTube chapters from the markers: "0:00 Intro" lines. YouTube needs the first at 0:00, at
 * least three, each 10 s or longer; the result says which rule isn't met.
 */
export function youtubeChapters(tl: Timeline): { text: string; problem?: string } {
  const fmt = (us: number) => {
    const s = Math.floor(us / 1e6), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };
  const list = [...tl.markers].sort((a, b) => a.t - b.t);
  const rows = list.map((m, i) => `${fmt(m.t)} ${m.note.split('\n')[0]?.trim() || `Chapter ${i + 1}`}`);
  let problem: string | undefined;
  if (!list.length || list[0]!.t >= 1e6) problem = 'YouTube needs the first chapter at 0:00: add a marker at the start.';
  else if (list.length < 3) problem = 'YouTube needs at least three chapters.';
  else if (list.some((m, i) => i > 0 && m.t - list[i - 1]!.t < 10e6)) problem = 'YouTube needs chapters at least 10 seconds apart.';
  return { text: rows.join('\n'), problem };
}

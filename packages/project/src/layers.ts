// Video tracks above the main row (V2–V6), and what is on screen at a moment: the main row
// (one clip, or two during a transition) with the clips on the tracks drawn over it.
//
// Clips on the tracks have their own start time. Two clips on one track never overlap.

import { IDENTITY_XF, xfOf, type Look, type Transform } from './look';
import { mediaAt, playLength } from './speed';
import {
  layersAt, MAX_TRACKS, MIN_CLIP_US, newId, timelineDuration,
  type ConnectedClip, type Located, type Timeline, type TimelineClip, type Transition, type VideoTrack,
} from './timeline';

/** Track name as shown: V1 is the main row, V2 the lowest track above it. */
export const trackName = (tl: Timeline, trackId: string) => `V${tl.tracks.findIndex((t) => t.id === trackId) + 2}`;

export function addTrack(tl: Timeline): { tl: Timeline; id: string | null } {
  if (tl.tracks.length >= MAX_TRACKS) return { tl, id: null };
  const id = newId('t');
  return { tl: { ...tl, tracks: [...tl.tracks, { id }] }, id };
}

export const updateTrack = (tl: Timeline, id: string, patch: Partial<Omit<VideoTrack, 'id'>>): Timeline => ({
  ...tl,
  tracks: tl.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
});

/** Removes a track and everything on it. */
export const removeTrack = (tl: Timeline, id: string): Timeline => ({
  ...tl,
  tracks: tl.tracks.filter((t) => t.id !== id),
  connected: tl.connected.filter((c) => c.trackId !== id),
});

/** Removes the empty tracks at the top (the ones that were added for a clip that left). */
export function trimEmptyTracks(tl: Timeline): Timeline {
  const tracks = [...tl.tracks];
  while (tracks.length && !tl.connected.some((c) => c.trackId === tracks[tracks.length - 1]!.id)) tracks.pop();
  return tracks.length === tl.tracks.length ? tl : { ...tl, tracks };
}

export const connectedSpan = (c: ConnectedClip) => ({ start: c.startUs, end: c.startUs + playLength(c) });

/** Whether [start, end) on a track is free (ignoring the clip `except`). */
export function trackFree(tl: Timeline, trackId: string, start: number, end: number, except?: string): boolean {
  return !tl.connected.some((c) => c.trackId === trackId && c.id !== except && c.startUs < end - 1 && connectedSpan(c).end > start + 1);
}

/**
 * Puts a clip on a track at `startUs`: the track asked for if it is free there, else the lowest free
 * track above it, adding tracks as needed. Returns null when every track is taken there.
 */
export function placeConnected(tl: Timeline, clip: TimelineClip, startUs: number, trackId?: string): { tl: Timeline; id: string } | null {
  const start = Math.max(0, Math.round(startUs));
  const end = start + playLength(clip);
  let from = trackId ? Math.max(0, tl.tracks.findIndex((t) => t.id === trackId)) : 0;
  let next = tl;
  for (;;) {
    while (next.tracks.length <= from) {
      const added = addTrack(next);
      if (!added.id) return null;
      next = added.tl;
    }
    const t = next.tracks[from]!;
    if (trackFree(next, t.id, start, end)) {
      const id = clip.id.startsWith('v') ? clip.id : newId('v');
      const { trackId: _t, startUs: _s, ...plain } = clip as Partial<ConnectedClip> & TimelineClip;
      return { tl: { ...next, connected: [...next.connected, { ...plain, id, trackId: t.id, startUs: start }] }, id };
    }
    from++;
    if (from >= MAX_TRACKS) return null;
  }
}

/**
 * Moves a clip on the tracks to a new start time and track. Refused (the timeline comes back
 * unchanged) when the place is taken, the track is locked, or the clip's own track is locked.
 */
export function moveConnected(tl: Timeline, id: string, startUs: number, trackId?: string): Timeline {
  const c = tl.connected.find((x) => x.id === id);
  if (!c) return tl;
  const to = trackId ?? c.trackId;
  const track = tl.tracks.find((t) => t.id === to), own = tl.tracks.find((t) => t.id === c.trackId);
  if (!track || track.locked || own?.locked) return tl;
  const start = Math.max(0, Math.round(startUs));
  if (!trackFree(tl, to, start, start + playLength(c), id)) return tl;
  return { ...tl, connected: tl.connected.map((x) => (x.id === id ? { ...x, startUs: start, trackId: to } : x)) };
}

export const removeConnected = (tl: Timeline, id: string): Timeline => ({ ...tl, connected: tl.connected.filter((c) => c.id !== id) });

/** Splits the clip on the tracks at timeline time T in two. */
export function splitConnected(tl: Timeline, id: string, T: number): Timeline {
  const c = tl.connected.find((x) => x.id === id);
  if (!c || tl.tracks.find((t) => t.id === c.trackId)?.locked) return tl;
  const local = T - c.startUs;
  if (local < MIN_CLIP_US || playLength(c) - local < MIN_CLIP_US) return tl;
  const m = Math.round(mediaAt(c, local));
  const left: ConnectedClip = { ...c, outUs: m };
  const right: ConnectedClip = { ...c, id: newId('v'), inUs: m, startUs: c.startUs + playLength(left) };
  return { ...tl, connected: tl.connected.flatMap((x) => (x.id === id ? [left, right] : [x])) };
}

/**
 * Cuts the track clip at timeline time T and deletes the part on one side. The part that stays
 * keeps its place in time (deleting left moves the clip's start to T).
 */
export function deleteSideConnected(tl: Timeline, id: string, T: number, side: 'left' | 'right'): Timeline {
  const c = tl.connected.find((x) => x.id === id);
  if (!c || tl.tracks.find((t) => t.id === c.trackId)?.locked) return tl;
  const local = T - c.startUs;
  if (local < MIN_CLIP_US || playLength(c) - local < MIN_CLIP_US) return tl;
  const m = Math.round(mediaAt(c, local));
  const next: ConnectedClip = side === 'left' ? { ...c, inUs: m, startUs: Math.round(T) } : { ...c, outUs: m };
  return { ...tl, connected: tl.connected.map((x) => (x.id === id ? next : x)) };
}

/** Copies a main-row or track clip onto the lowest free track at T. */
export function connectCopy(tl: Timeline, clip: TimelineClip, T: number, trackId?: string) {
  return placeConnected(tl, { ...clip, id: newId('v') }, T, trackId);
}

// --- What is on screen --------------------------------------------------------------

/** One picture on screen. */
export interface StackLayer extends Located {
  /** 0 = main row, 1 = V2, … */
  track: number;
  /** Main row during a transition: which side this is. */
  role?: 'out' | 'in';
}

export interface Stack {
  /** Bottom first: the main row (one or two clips), then V2, V3… */
  layers: StackLayer[];
  /** Main-row transition, if one is under way. */
  transition?: Transition;
  progress: number;
}

/** The clips on the tracks above the main row visible at T (shown tracks only), lowest first. */
export function connectedAt(tl: Timeline, T: number): StackLayer[] {
  const out: StackLayer[] = [];
  const end = timelineDuration(tl);
  tl.tracks.forEach((t, ti) => {
    if (t.hidden) return;
    for (const c of tl.connected) {
      if (c.trackId !== t.id) continue;
      const { start, end: e } = connectedSpan(c);
      if (T < start || T >= e || T >= end) continue;
      const local = T - start;
      out.push({ index: tl.connected.indexOf(c), clip: c, startUs: start, mediaUs: Math.min(c.outUs - 1, mediaAt(c, local)), track: ti + 1 });
    }
  });
  return out;
}

/** A track clip as the clip being edited at T (the playhead held inside it). */
export function layerLocated(tl: Timeline, c: ConnectedClip, T: number): StackLayer {
  const local = Math.max(0, Math.min(playLength(c) - 1, T - c.startUs));
  return { index: tl.connected.indexOf(c), clip: c, startUs: c.startUs, mediaUs: Math.min(c.outUs - 1, mediaAt(c, local)), track: tl.tracks.findIndex((t) => t.id === c.trackId) + 1 };
}

/** Everything on screen at timeline time T, bottom first. */
export function stackAt(tl: Timeline, T: number): Stack | null {
  const L = layersAt(tl, T);
  if (!L) return null;
  const main: StackLayer[] = L.b ? [{ ...L.a, track: 0, role: 'out' }, { ...L.b, track: 0, role: 'in' }] : [{ ...L.a, track: 0 }];
  return { layers: [...main, ...connectedAt(tl, T)], transition: L.transition, progress: L.progress };
}

// --- Layout templates ------------------------------------------------------------

/** A place in the frame: left, top, width, height as fractions of the frame. */
export type Cell = [number, number, number, number];

export interface LayoutTemplate {
  id: string;
  label: string;
  /** Bottom layer first (the main row). */
  cells: Cell[];
  /** How a clip fills its cell: 'fill' crops to fill it, 'fit' keeps the whole picture. */
  fill: 'fill' | 'fit';
}

const PIP = 0.3, M = 0.04;
const pip = (x: number, y: number): Cell => [x ? 1 - M - PIP : M, y ? 1 - M - PIP : M, PIP, PIP];
const FULL: Cell = [0, 0, 1, 1];

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  { id: 'pip-tl', label: 'Picture in picture, top left', cells: [FULL, pip(0, 0)], fill: 'fit' },
  { id: 'pip-tr', label: 'Picture in picture, top right', cells: [FULL, pip(1, 0)], fill: 'fit' },
  { id: 'pip-bl', label: 'Picture in picture, bottom left', cells: [FULL, pip(0, 1)], fill: 'fit' },
  { id: 'pip-br', label: 'Picture in picture, bottom right', cells: [FULL, pip(1, 1)], fill: 'fit' },
  { id: 'split-h', label: 'Side by side', cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], fill: 'fill' },
  { id: 'split-v', label: 'Stacked', cells: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]], fill: 'fill' },
  { id: 'split-3', label: 'Three across', cells: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]], fill: 'fill' },
  { id: 'grid-4', label: 'Grid of four', cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]], fill: 'fill' },
  { id: 'stack-3', label: 'Three stacked (for 9:16)', cells: [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]], fill: 'fill' },
  { id: 'full', label: 'Full frame', cells: [FULL, FULL, FULL, FULL, FULL, FULL], fill: 'fill' },
];

/**
 * The transform that puts a full-frame clip in a cell. 'fill' scales it to cover the cell and
 * crops what sticks out (evenly, so the middle stays in the middle); 'fit' keeps it whole.
 * The clip has the frame's shape, so its picture's width and height scale together.
 */
export function cellTransform(cell: Cell, fill: 'fill' | 'fit', base: Transform = IDENTITY_XF): Transform {
  const [l, t, w, h] = cell;
  const scale = fill === 'fill' ? Math.max(w, h) : Math.min(w, h);
  const cx = fill === 'fill' ? Math.max(0, (1 - w / scale) / 2) : 0;
  const cy = fill === 'fill' ? Math.max(0, (1 - h / scale) / 2) : 0;
  return { ...base, x: l + w / 2 - 0.5, y: t + h / 2 - 0.5, scale, crop: [cx, cy, cx, cy], rotate: 0 };
}

const setXf = (c: TimelineClip, xf: Transform): TimelineClip => ({
  ...c,
  look: { ...c.look, xf },
  // A layout is a place, not a move: every keyframe gets it too.
  keyframes: c.keyframes.map((k) => ({ ...k, look: { ...k.look, xf } })),
});

/**
 * Applies a layout to what is on screen at T: the main-row clip gets the first cell, the clips
 * on the tracks above the next ones, lowest track first. Clips without a cell are left alone.
 * Looks (border, corners, shadow) are kept.
 */
export function applyLayout(tl: Timeline, T: number, layoutId: string): Timeline {
  const lay = LAYOUT_TEMPLATES.find((l) => l.id === layoutId);
  const st = stackAt(tl, T);
  if (!lay || !st) return tl;
  // During a transition both main-row clips share the first cell.
  const main = st.layers.filter((l) => l.track === 0);
  const over = st.layers.filter((l) => l.track > 0);
  const want = new Map<string, Transform>();
  for (const l of main) want.set(l.clip.id, cellTransform(lay.cells[0]!, lay.fill, xfOf(l.clip.look)));
  over.forEach((l, i) => {
    const cell = lay.cells[i + 1];
    if (cell) want.set(l.clip.id, cellTransform(cell, lay.fill, xfOf(l.clip.look)));
  });
  // Full frame clears everything about placement.
  const xf = (id: string) => (lay.id === 'full' ? { ...want.get(id)!, crop: [0, 0, 0, 0] as Transform['crop'], radius: 0, border: 0, shadow: 0 } : want.get(id)!);
  return {
    ...tl,
    clips: tl.clips.map((c) => (want.has(c.id) ? setXf(c, xf(c.id)) : c)),
    connected: tl.connected.map((c) => (want.has(c.id) ? (setXf(c, xf(c.id)) as ConnectedClip) : c)),
  };
}

// --- Geometry (shared by preview and export) -----------------------------------------------

/** Where a transformed layer's picture lands, in frame fractions, before rotation. */
export function shownRect(xf: Transform): { x: number; y: number; w: number; h: number } {
  const [l, t, r, b] = xf.crop;
  // The layer is the frame's size, centred at (0.5 + x, 0.5 + y), scaled about its centre.
  const x0 = 0.5 + xf.x + (l - 0.5) * xf.scale, x1 = 0.5 + xf.x + (0.5 - r) * xf.scale;
  const y0 = 0.5 + xf.y + (t - 0.5) * xf.scale, y1 = 0.5 + xf.y + (0.5 - b) * xf.scale;
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Whether frame point (px, py) (fractions) is on the shown picture of a layer. */
export function hitsLayer(xf: Transform, px: number, py: number, aspect: number): boolean {
  const r = shownRect(xf);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  // Undo the rotation (in pixels, so non-square frames rotate correctly).
  const a = (-xf.rotate * Math.PI) / 180;
  const dx = (px - cx) * aspect, dy = py - cy;
  const ux = (dx * Math.cos(a) - dy * Math.sin(a)) / aspect, uy = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(ux) <= r.w / 2 && Math.abs(uy) <= r.h / 2;
}

/** The look's transform with the rotation and cropping clamped to sensible limits. */
export function cleanXf(x: Transform): Transform {
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
  const crop = x.crop.map((c) => clamp(c, 0, 0.9)) as Transform['crop'];
  // Never crop away the whole picture.
  if (crop[0] + crop[2] > 0.95) { const k = 0.95 / (crop[0] + crop[2]); crop[0] *= k; crop[2] *= k; }
  if (crop[1] + crop[3] > 0.95) { const k = 0.95 / (crop[1] + crop[3]); crop[1] *= k; crop[3] *= k; }
  return {
    ...x,
    x: clamp(x.x, -1.5, 1.5), y: clamp(x.y, -1.5, 1.5), scale: clamp(x.scale, 0.02, 8), crop,
    rotate: clamp(x.rotate, -360, 360), opacity: clamp(x.opacity, 0, 1), radius: clamp(x.radius, 0, 0.5),
    border: clamp(x.border, 0, 0.05), shadow: clamp(x.shadow, 0, 1),
  };
}

/** A look with a transform patch applied. */
export const withXf = (look: Look, patch: Partial<Transform>): Look => ({ ...look, xf: cleanXf({ ...xfOf(look), ...patch }) });

/** A point of a clip's own picture (fractions) → where it is in the frame, after its transform. */
export function layerToFrame(xf: Transform | undefined, aspect: number, u: number, v: number): [number, number] {
  if (!xf) return [u, v];
  const a = (xf.rotate * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const px = (u - 0.5) * xf.scale * aspect, py = (v - 0.5) * xf.scale;
  return [0.5 + xf.x + (px * cos - py * sin) / aspect, 0.5 + xf.y + px * sin + py * cos];
}

/** The other way: a frame point → the clip's own picture. */
export function frameToLayer(xf: Transform | undefined, aspect: number, x: number, y: number): [number, number] {
  if (!xf) return [x, y];
  const a = (-xf.rotate * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const px = (x - 0.5 - xf.x) * aspect, py = y - 0.5 - xf.y;
  const s = Math.max(1e-6, xf.scale);
  return [0.5 + (px * cos - py * sin) / aspect / s, 0.5 + (px * sin + py * cos) / s];
}

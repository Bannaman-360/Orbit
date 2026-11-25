// Compound clips and nested timelines. A compound clip points to a sequence (a timeline of its
// own, kept in the project) instead of a file: its in and out points are times in that sequence.
// Playback and export never render a sequence to a picture first: `flattenTimeline` replaces each
// compound clip by the pieces of the sequence it shows, as ordinary clips and layers.

import { mediaAt, playLength } from './speed';
import {
  clipDuration, clipStarts, emptyTimeline, newClip, newId, timelineDuration, transitionUs,
  type AudioClip, type ConnectedClip, type Timeline, type TimelineClip, type VideoTrack,
} from './timeline';
import type { Overlay } from './overlays';

/** A timeline inside the project (a compound clip's contents). */
export interface Sequence {
  id: string;
  name: string;
  clips: TimelineClip[];
  connected: ConnectedClip[];
  tracks: VideoTrack[];
  audio: AudioClip[];
  overlays: Overlay[];
}

export const SEQ_PREFIX = 'seq:';
export const isCompound = (c: { mediaPath: string }) => c.mediaPath.startsWith(SEQ_PREFIX);
export const sequenceIdOf = (c: { mediaPath: string }) => (isCompound(c) ? c.mediaPath.slice(SEQ_PREFIX.length) : null);
export const findSequence = (tl: Pick<Timeline, 'sequences'>, id: string | null) => (id ? tl.sequences?.find((s) => s.id === id) : undefined);

/** A sequence as a timeline (for its length, or to edit it), sharing the project's settings. */
export function sequenceTimeline(root: Timeline, s: Sequence): Timeline {
  return { ...emptyTimeline(), framing: root.framing, lutPath: root.lutPath, sequences: root.sequences, clips: s.clips, connected: s.connected, tracks: s.tracks, audio: s.audio, overlays: s.overlays };
}
export const sequenceDuration = (root: Timeline, s: Sequence) => timelineDuration(sequenceTimeline(root, s));

/** How long the thing a clip shows is: its file (from `fileDuration`), or its sequence. */
export function sourceDuration(tl: Timeline, c: { mediaPath: string }, fileDuration: (path: string) => number | undefined): number | undefined {
  const s = findSequence(tl, sequenceIdOf(c));
  return s ? sequenceDuration(tl, s) : fileDuration(c.mediaPath);
}

/**
 * Nests main-row clips `from`…`to` (with what lies over them on V2–V6, and titles and gauges only
 * over them) into a new sequence, and puts one compound clip in their place.
 */
export function makeCompound(tl: Timeline, from: number, to: number, name?: string): { tl: Timeline; id: string } | null {
  const a = Math.max(0, from), b = Math.min(tl.clips.length - 1, to);
  if (a > b) return null;
  const starts = clipStarts(tl);
  const s0 = starts[a]!, s1 = starts[b]! + clipDuration(tl.clips[b]!);
  const inside = (st: number, en: number) => st >= s0 - 1 && en <= s1 + 1;
  const clips = tl.clips.slice(a, b + 1).map((c, i) => (i === 0 ? { ...c, transitionIn: undefined } : c));
  const connected = tl.connected.filter((c) => inside(c.startUs, c.startUs + playLength(c)));
  const overlays = tl.overlays.filter((o) => inside(o.startUs, o.endUs) && (!o.sourceClipId || connected.some((c) => c.id === o.sourceClipId)));
  const ids = new Set(clips.map((c) => c.id));
  const audio = tl.audio.filter((x) => x.linkedClipId && ids.has(x.linkedClipId));
  const seqId = newId('s');
  const shift = <T extends { startUs: number }>(x: T) => ({ ...x, startUs: x.startUs - s0 });
  const usedTracks = tl.tracks.filter((t) => connected.some((c) => c.trackId === t.id));
  const seq: Sequence = {
    id: seqId,
    name: name ?? `Compound clip ${(tl.sequences?.length ?? 0) + 1}`,
    clips,
    connected: connected.map(shift),
    tracks: usedTracks,
    audio: audio.map(shift),
    overlays: overlays.map((o) => ({ ...o, startUs: o.startUs - s0, endUs: o.endUs - s0 })),
  };
  const len = s1 - s0;
  const compound: TimelineClip = { ...newClip(SEQ_PREFIX + seqId, len, false), stabilize: { smoothing: 'off', horizon: false }, transitionIn: tl.clips[a]!.transitionIn };
  const movedConnected = new Set(connected.map((c) => c.id)), movedOverlays = new Set(overlays.map((o) => o.id)), movedAudio = new Set(audio.map((x) => x.id));
  return {
    id: compound.id,
    tl: {
      ...tl,
      clips: [...tl.clips.slice(0, a), compound, ...tl.clips.slice(b + 1)],
      connected: tl.connected.filter((c) => !movedConnected.has(c.id)),
      overlays: tl.overlays.filter((o) => !movedOverlays.has(o.id)),
      audio: tl.audio.filter((x) => !movedAudio.has(x.id)),
      sequences: [...(tl.sequences ?? []), seq],
    },
  };
}

/** Puts an edited sequence back into the project (a compound clip longer than it now is gets shorter). */
export function storeSequence(root: Timeline, id: string, edited: Timeline): Timeline {
  const seqs = (edited.sequences ?? root.sequences ?? []).map((s) => (s.id === id ? { ...s, clips: edited.clips, connected: edited.connected, tracks: edited.tracks, audio: edited.audio, overlays: edited.overlays } : s));
  const next: Timeline = { ...root, sequences: seqs };
  const fit = (c: TimelineClip) => {
    const s = findSequence(next, sequenceIdOf(c));
    if (!s) return c;
    const d = sequenceDuration(next, s);
    if (c.outUs <= d && c.inUs < d) return c;
    const outUs = Math.min(c.outUs, d), inUs = Math.min(c.inUs, Math.max(0, outUs - 100_000));
    return { ...c, inUs, outUs };
  };
  return { ...next, clips: next.clips.map(fit), connected: next.connected.map((c) => fit(c) as ConnectedClip) };
}

/** Turns a compound clip back into the clips it holds (they keep their places). */
export function breakApart(tl: Timeline, clipId: string): Timeline {
  const i = tl.clips.findIndex((c) => c.id === clipId);
  const c = tl.clips[i];
  if (!c || !isCompound(c)) return tl;
  const flat = flattenOne(tl, c, clipStarts(tl)[i]!, 0, true);
  return {
    ...tl,
    clips: [...tl.clips.slice(0, i), ...flat.clips, ...tl.clips.slice(i + 1)],
    tracks: [...tl.tracks, ...flat.tracks].slice(0, 5),
    connected: [...tl.connected, ...flat.connected.filter((x) => [...tl.tracks, ...flat.tracks].slice(0, 5).some((t) => t.id === x.trackId))],
    audio: [...tl.audio, ...flat.audio],
    overlays: [...tl.overlays, ...flat.overlays],
  };
}

interface Flat { clips: TimelineClip[]; connected: ConnectedClip[]; tracks: VideoTrack[]; audio: AudioClip[]; overlays: Overlay[] }

/** The pieces of compound clip `c` (starting at timeline time `S`) as ordinary clips. */
function flattenOne(tl: Timeline, c: TimelineClip, S: number, depth: number, keepIds = false): Flat {
  const seq = findSequence(tl, sequenceIdOf(c));
  const empty: Flat = { clips: [], connected: [], tracks: [], audio: [], overlays: [] };
  if (!seq || depth > 4) return empty;
  const inner = flattenTimeline(sequenceTimeline(tl, seq), depth + 1);
  const a = c.inUs, b = Math.min(c.outUs, timelineDuration(inner));
  if (b <= a) return empty;
  // Breaking apart gives the pieces new ids (the same sequence may be used twice); else ids follow the compound.
  const fresh = new Map<string, string>();
  const id = (x: string) => (keepIds ? fresh.get(x) ?? (fresh.set(x, newId(x[0] ?? 'c')), fresh.get(x)!) : `${c.id}~${x}`);
  const starts = clipStarts(inner);
  const clips: TimelineClip[] = [];
  inner.clips.forEach((x, j) => {
    const s = starts[j]!, e = s + clipDuration(x);
    if (e <= a || s >= b) return;
    const lo = Math.max(0, a - s), hi = Math.min(clipDuration(x), b - s);
    const piece: TimelineClip = {
      ...x, id: id(x.id),
      inUs: Math.round(lo > 0 ? mediaAt(x, lo) : x.inUs), outUs: Math.round(hi < clipDuration(x) ? mediaAt(x, hi) : x.outUs),
      volume: x.volume * c.volume,
      ...(c.soloSound ? { soloSound: true } : {}),
    };
    if (!clips.length) piece.transitionIn = c.transitionIn;
    else if (x.transitionIn) piece.transitionIn = { ...x.transitionIn, durationUs: transitionUs(inner, j) };
    clips.push(piece);
  });
  const shift = S - a;
  const tracks = inner.tracks.map((t) => ({ ...t, id: id(t.id) }));
  const connected: ConnectedClip[] = inner.connected.flatMap((x) => {
    const s = x.startUs, e = s + playLength(x);
    if (e <= a || s >= b) return [];
    const lo = Math.max(0, a - s), hi = Math.min(playLength(x), b - s);
    return [{ ...x, id: id(x.id), trackId: id(x.trackId), startUs: Math.round(Math.max(s, a) + shift), inUs: Math.round(lo > 0 ? mediaAt(x, lo) : x.inUs), outUs: Math.round(hi < playLength(x) ? mediaAt(x, hi) : x.outUs), volume: x.volume * c.volume }];
  });
  const audio: AudioClip[] = inner.audio.flatMap((x) => {
    const len = playLength(x), s = x.startUs, e = s + len;
    if (e <= a || s >= b) return [];
    const lo = Math.max(0, a - s), hi = Math.min(len, b - s);
    return [{ ...x, id: id(x.id), startUs: Math.round(Math.max(s, a) + shift), inUs: Math.round(lo > 0 ? mediaAt(x, lo) : x.inUs), outUs: Math.round(hi < len ? mediaAt(x, hi) : x.outUs), volume: x.volume * c.volume, ...(x.linkedClipId ? { linkedClipId: id(x.linkedClipId) } : {}) }];
  });
  const overlays: Overlay[] = inner.overlays.flatMap((o) => (o.endUs <= a || o.startUs >= b ? [] : [{ ...o, id: id(o.id), startUs: Math.max(o.startUs, a) + shift, endUs: Math.min(o.endUs, b) + shift, ...(o.sourceClipId ? { sourceClipId: id(o.sourceClipId) } : {}) }]));
  return { clips, connected, tracks, audio, overlays };
}

const flatCache = new WeakMap<Timeline, Timeline>();

/** The timeline with every compound clip replaced by what it shows (for playback and export). */
export function flattenTimeline(tl: Timeline, depth = 0): Timeline {
  if (!tl.clips.some(isCompound) && !tl.connected.some(isCompound)) return tl;
  const hit = flatCache.get(tl);
  if (hit) return hit;
  const starts = clipStarts(tl);
  const clips: TimelineClip[] = [];
  const extra: Flat = { clips: [], connected: [], tracks: [], audio: [], overlays: [] };
  tl.clips.forEach((c, i) => {
    if (!isCompound(c)) { clips.push(c); return; }
    const f = flattenOne(tl, c, starts[i]!, depth);
    // (An empty or missing sequence keeps its place as a blank clip.)
    if (!f.clips.length) { clips.push(c); return; }
    clips.push(...f.clips);
    extra.connected.push(...f.connected);
    extra.tracks.push(...f.tracks);
    extra.audio.push(...f.audio);
    extra.overlays.push(...f.overlays);
  });
  // A compound clip on a track: its main row's pieces, one after another on that track.
  const connected: ConnectedClip[] = [];
  for (const c of tl.connected) {
    if (!isCompound(c)) { connected.push(c); continue; }
    const f = flattenOne(tl, c, c.startUs, depth);
    let t = c.startUs;
    for (const p of f.clips) { connected.push({ ...p, trackId: c.trackId, startUs: Math.round(t), transitionIn: undefined }); t += playLength(p); }
  }
  // The sequences' own tracks sit just above the main row, under the edit's tracks.
  const out: Timeline = {
    ...tl, clips, tracks: [...extra.tracks, ...tl.tracks], connected: [...extra.connected, ...connected],
    audio: [...tl.audio, ...extra.audio], overlays: [...tl.overlays, ...extra.overlays],
  };
  flatCache.set(tl, out);
  return out;
}

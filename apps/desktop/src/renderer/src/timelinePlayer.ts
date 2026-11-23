// Plays the edit: finds what is on screen at the playhead (one clip, or two during a
// transition), keeps their decoders fed, and pre-rolls the next clip shortly before
// it is needed so cuts and transitions are seamless.

import { TrackDecoder } from '@ace/engine';
import { clipStarts, layersAt, speedAt, timelineDuration, type Located, type Timeline, type TimelineClip, type Transition } from '@ace/project';
import type { EacLayout } from '@ace/media360';
import { mediaNow, type Media } from './media';
import { previewSource, type PreviewSource } from './proxy';
import { ReverseCache } from './reverseCache';

interface Slot {
  clipId: string;
  media: Media;
  /** Original file or a proxy (see proxy.ts). */
  source: PreviewSource;
  decoders: TrackDecoder[];
  /** Media time the decoders were last seeked to (NaN = must re-seek). */
  seekedTo: number;
  /** Timestamp of the frame last shown from this slot. */
  shownTs: number;
  /** Dragging backward shows keyframes; the exact frame is fetched here once the drag pauses. */
  refineTo?: number;
  /** The previous target (to tell which way the pointer is moving). */
  lastTarget: number;
  /** Share of recent refreshes its pictures weren't ready for. */
  behind: number;
  /** performance.now() of its last restart. */
  since: number;
  /** Pictures kept for dragging backward (made when first dragged backward). */
  reverse?: ReverseCache;
  /** When the kept pictures were first missed while dragging back. */
  backSince?: number;
  /** How fast the pointer goes back (media µs per ms), and where it was. */
  backSpeed?: number;
  backLast?: { t: number; us: number };
}

export interface LayerFrame {
  clip: TimelineClip;
  index: number;
  media: Media;
  /** 360 layout of the frames (proxies are smaller than the original). */
  layout: EacLayout | null;
  /** 1 = original, 2/4/8 = proxy. */
  level: number;
  mediaUs: number;
  frames: VideoFrame[];
}

export interface TickResult {
  /** The main (outgoing, during a transition) clip — what the inspector edits. */
  clip: TimelineClip;
  index: number;
  media: Media;
  mediaUs: number;
  frames: VideoFrame[] | null;
  /** Everything to draw, bottom first: [clip] or [outgoing, incoming]. Null while decoding. */
  layers: LayerFrame[] | null;
  transition?: Transition;
  progress: number;
}

const PREROLL_US = 1_200_000;
/** Speeds this computer turned out not to decode a source at. */
const tooFast = new WeakMap<PreviewSource, number>();
/** How long a scrub restart may take before a newer target replaces it. */
const RESTART_WAIT_MS = 150;
/** No new seek for this long = the user stopped dragging. */
const DRAG_PAUSE_MS = 120;

export class TimelinePlayer {
  /** Keeps pictures for dragging backward (off: only keyframes, as before; for comparing). */
  static keepBackward = true;
  time = 0;
  playing = false;
  stalls = 0;
  private lastTick: number | null = null;
  private stallStart: number | null = null;
  private slots = new Map<string, Slot>();
  private lastSeekAt = 0;
  /** How long a screen refresh takes (ms). */
  private refreshMs = 1000 / 60;
  /** Called when playback starts, stops, seeks or crosses a cut (audio follows). */
  onTransport?: (playing: boolean, time: number) => void;

  constructor(private getTimeline: () => Timeline) {}

  get duration() {
    return timelineDuration(this.getTimeline());
  }

  play() {
    if (this.time >= this.duration - 20_000) this.seek(0);
    this.playing = true;
    this.lastTick = null;
    this.onTransport?.(true, this.time);
  }

  pause() {
    this.playing = false;
    this.onTransport?.(false, this.time);
  }

  seek(T: number) {
    this.lastSeekAt = performance.now();
    this.time = Math.max(0, Math.min(T, Math.max(0, this.duration - 1)));
    this.resync();
    this.onTransport?.(this.playing, this.time);
  }

  /** Re-sync after the timeline was edited (clip trimmed, moved, removed…). */
  invalidate() {
    this.resync();
    this.time = Math.min(this.time, Math.max(0, this.duration - 1));
  }

  private resync() {
    for (const s of this.slots.values()) s.seekedTo = Number.NaN;
  }

  private slotFor(clip: TimelineClip, media: Media, mediaUs: number): Slot {
    let s = this.slots.get(clip.id);
    const source = previewSource(media);
    if (s && (s.media !== media || s.source !== source)) {
      this.drop(clip.id);
      s = undefined;
    }
    if (!s) {
      s = { clipId: clip.id, media, source, decoders: source.tracks.map((t) => new TrackDecoder(source.reader, t)), seekedTo: Number.NaN, shownTs: -1, lastTarget: Number.NaN, behind: 0, since: 0 };
      this.slots.set(clip.id, s);
    }
    const dragging = !this.playing && performance.now() - this.lastSeekAt < DRAG_PAUSE_MS;
    if (Number.isNaN(s.seekedTo)) {
      s.since = performance.now();
      // Scrubbing: while a restart hasn't shown its first frame yet, don't restart again on
      // every tiny pointer move (that would never show anything); retarget after it lands
      // or after RESTART_WAIT_MS.
      const settling = Math.max(0, ...s.decoders.map((d) => d.settlingMs));
      if (!(settling > 0 && settling < RESTART_WAIT_MS && !this.playing)) {
        // Which way is the pointer moving? (Not compared with the picture: while dragging
        // backward the picture is a keyframe behind the pointer.)
        const backward = Number.isFinite(s.lastTarget) && mediaUs < s.lastTarget - 1000;
        const keepBackward = s.refineTo !== undefined && mediaUs <= s.refineTo + 1000;
        s.lastTarget = mediaUs;
        if (dragging && (backward || keepBackward)) {
          // Dragging backward: show the keyframe just before the pointer (one frame to
          // decode, and it moves the same way as the hand); fetch the exact frame later.
          const kt = s.decoders[0]!.keyframeTimeBefore(mediaUs);
          for (const d of s.decoders) d.seek(kt, false);
          s.seekedTo = kt;
          s.refineTo = mediaUs;
        } else {
          for (const d of s.decoders) d.seek(mediaUs, !this.playing);
          s.seekedTo = mediaUs;
          s.refineTo = undefined;
          s.lastTarget = mediaUs;
        }
      }
    } else if (s.refineTo !== undefined && !dragging) {
      // The drag paused: now get the exact frame (the keyframe stays up until it's ready).
      for (const d of s.decoders) d.seek(s.refineTo, false);
      s.seekedTo = s.refineTo;
      s.refineTo = undefined;
    }
    return s;
  }

  private drop(id: string) {
    const s = this.slots.get(id);
    if (s) for (const d of s.decoders) d.close();
    s?.reverse?.close();
    this.slots.delete(id);
  }

  tick(now: number): TickResult | null {
    const tl = this.getTimeline();
    const L = layersAt(tl, this.time);
    if (!L) {
      for (const id of [...this.slots.keys()]) this.drop(id);
      return null;
    }
    const visible: Located[] = L.b ? [L.a, L.b] : [L.a];
    const keep = new Set(visible.map((v) => v.clip.id));

    // Pre-roll the clip that comes on screen next.
    const last = visible[visible.length - 1]!;
    const next = tl.clips[last.index + 1];
    let preroll: { clip: TimelineClip; media: Media } | null = null;
    if (this.playing && next) {
      const startNext = clipStarts(tl)[last.index + 1]!;
      const nm = mediaNow(next.mediaPath);
      if (nm && startNext - this.time < PREROLL_US) {
        preroll = { clip: next, media: nm };
        keep.add(next.id);
      }
    }
    for (const id of [...this.slots.keys()]) if (!keep.has(id)) this.drop(id);

    let holding = false;
    const layers: (LayerFrame | null)[] = visible.map((v) => {
      const media = mediaNow(v.clip.mediaPath);
      if (!media) return null;
      const speed = speedAt(v.clip, v.mediaUs);
      // Playing too fast to decode everything (see below): keyframes only, until it slows down.
      const known = this.slots.get(v.clip.id);
      const skim = this.playing && !!known && speed > (tooFast.get(known.source) ?? Infinity);
      if (known && known.decoders[0]!.skim !== skim) {
        for (const d of known.decoders) if (skim) d.startSkim(); else if (this.playing) d.endSkim(v.mediaUs, speed * 150_000); else d.endSkim(v.mediaUs, Infinity);
        if (!this.playing) known.seekedTo = Number.NaN;
      }
      const slot = this.slotFor(v.clip, media, v.mediaUs);
      for (const d of slot.decoders) {
        d.pace = this.playing ? speed * this.refreshMs * 1000 : 0;
        void d.pump();
      }
      // Paused (scrubbing / stepping): show the nearest decoded frame at or before the target
      // while decoding catches up. Playing: only the exact frame.
      // While dragging backward, stay on the keyframe (frames decoded after it would creep forward).
      const at = slot.refineTo !== undefined ? Math.min(v.mediaUs, slot.seekedTo) : v.mediaUs;
      // Dragging backward through the original: the pictures kept for that, when they are there.
      if (slot.refineTo !== undefined && slot.source.level === 1 && TimelinePlayer.keepBackward) {
        slot.reverse ??= new ReverseCache(media);
        const now = performance.now();
        if (slot.backLast && now > slot.backLast.t) slot.backSpeed = (slot.backSpeed ?? 0) * 0.8 + (Math.max(0, slot.backLast.us - v.mediaUs) / (now - slot.backLast.t)) * 0.2;
        slot.backLast = { t: now, us: v.mediaUs };
        const kept = slot.reverse.frameAt(v.mediaUs);
        // Never later than what is up (that would pull the picture the wrong way).
        if (kept && (slot.shownTs < 0 || kept[0]!.timestamp <= slot.shownTs + 500)) {
          slot.shownTs = kept[0]!.timestamp;
          slot.backSince = 0;
          return { clip: v.clip, index: v.index, media, mediaUs: v.mediaUs, frames: kept, layout: slot.reverse.layout, level: slot.reverse.level };
        }
        // Not made yet: keep what is up for a moment rather than jump to the keyframe.
        slot.backSince ||= performance.now();
        // (Unless the pointer goes back faster than stretches can be made: then keyframes, as before.)
        const outrun = (slot.backSpeed ?? 0) * slot.reverse.buildMs * 1.2 > slot.reverse.stretchUs;
        if (!outrun && performance.now() - slot.backSince < 180) { holding = true; return null; }
      } else {
        slot.backSince = 0;
        slot.backLast = undefined;
        slot.backSpeed = 0;
        slot.reverse?.idle();
      }
      const frames = slot.decoders.map((d) => (this.playing ? d.frameAt(at) : d.frameAtOrBefore(at)));
      if (frames[0]) slot.shownTs = frames[0].timestamp;
      // Can't keep up? (Not counting the moment it takes to get going.)
      if (this.playing && speed > 1.2 && performance.now() - slot.since > 350) {
        slot.behind += ((frames.every(Boolean) ? 0 : 1) - slot.behind) * 0.1;
        if (slot.behind > 0.22 && !slot.decoders[0]!.skim) { tooFast.set(slot.source, speed * 0.9); slot.behind = 0; }
      } else slot.behind = 0;
      // With pictures left out, the halves of a 360 picture can be a moment apart: hold the last one.
      if (frames.length > 1 && frames.every(Boolean) && frames.some((f) => Math.abs(f!.timestamp - frames[0]!.timestamp) > 2000)) { holding = true; return null; }
      return frames.every((f): f is VideoFrame => f !== null)
        ? { clip: v.clip, index: v.index, media, mediaUs: v.mediaUs, frames, layout: slot.source.layout, level: slot.source.level }
        : null;
    });
    if (preroll) {
      const slot = this.slotFor(preroll.clip, preroll.media, preroll.clip.inUs);
      for (const d of slot.decoders) void d.pump();
    }
    const mainMedia = mediaNow(L.a.clip.mediaPath);
    if (!mainMedia) return null;
    const ready = layers.every((l): l is LayerFrame => l !== null);

    if (this.playing) {
      const dt = this.lastTick === null ? 0 : (now - this.lastTick) * 1000;
      if (dt > 3000 && dt < 40_000) this.refreshMs += (dt / 1000 - this.refreshMs) * 0.05;
      this.lastTick = now;
      if (ready || holding) {
        // After a decoder stall the video clock held still while audio kept going: resync audio.
        if (this.stallStart !== null && now - this.stallStart > 80) this.onTransport?.(true, this.time);
        this.stallStart = null;
        this.time = Math.min(this.time + Math.min(dt, 100_000), this.duration);
        if (this.time >= this.duration - 1) {
          this.time = Math.max(0, this.duration - 1);
          this.pause();
        }
      } else {
        this.stalls++;
        this.stallStart ??= now;
      }
    }
    return {
      clip: L.a.clip,
      index: L.a.index,
      media: mainMedia,
      mediaUs: L.a.mediaUs,
      frames: ready ? layers[0]!.frames : null,
      layers: ready ? (layers as LayerFrame[]) : null,
      transition: L.transition,
      progress: L.progress,
    };
  }

  /** The clip at the playhead plays faster than this computer can decode: fewer pictures are shown. */
  get skimming() {
    return this.playing && [...this.slots.values()].some((s) => s.decoders[0]!.skim);
  }

  /** Memory used by pictures kept for dragging backward (bytes). */
  get reverseBytes() {
    let n = 0;
    for (const s of this.slots.values()) n += s.reverse?.bytes ?? 0;
    return n;
  }
  /** For checking. */
  get reverseStats() {
    return [...this.slots.values()].map((s) => s.reverse && { level: s.reverse.level, ...s.reverse.stats });
  }

  /** State of the decoders, for diagnostics. */
  debug() {
    return [...this.slots.values()].map((s) => ({ seekedTo: s.seekedTo, refineTo: s.refineTo, shownTs: s.shownTs, dec: s.decoders.map((d) => d.debug()) }));
  }

  close() {
    for (const id of [...this.slots.keys()]) this.drop(id);
  }
}

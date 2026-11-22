// Plays the edit: finds what is on screen at the playhead (one clip, or two during a
// transition), keeps their decoders fed, and pre-rolls the next clip shortly before
// it is needed so cuts and transitions are seamless.

import { TrackDecoder } from '@ace/engine';
import { clipStarts, layersAt, timelineDuration, type Located, type Timeline, type TimelineClip, type Transition } from '@ace/project';
import type { EacLayout } from '@ace/media360';
import { mediaNow, type Media } from './media';
import { previewSource, type PreviewSource } from './proxy';

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
/** How long a scrub restart may take before a newer target replaces it. */
const RESTART_WAIT_MS = 150;
/** No new seek for this long = the user stopped dragging. */
const DRAG_PAUSE_MS = 120;

export class TimelinePlayer {
  time = 0;
  playing = false;
  stalls = 0;
  private lastTick: number | null = null;
  private stallStart: number | null = null;
  private slots = new Map<string, Slot>();
  private lastSeekAt = 0;
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
      s = { clipId: clip.id, media, source, decoders: source.tracks.map((t) => new TrackDecoder(source.reader, t)), seekedTo: Number.NaN, shownTs: -1, lastTarget: Number.NaN };
      this.slots.set(clip.id, s);
    }
    const dragging = !this.playing && performance.now() - this.lastSeekAt < DRAG_PAUSE_MS;
    if (Number.isNaN(s.seekedTo)) {
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

    const layers: (LayerFrame | null)[] = visible.map((v) => {
      const media = mediaNow(v.clip.mediaPath);
      if (!media) return null;
      const slot = this.slotFor(v.clip, media, v.mediaUs);
      for (const d of slot.decoders) void d.pump();
      // Paused (scrubbing / stepping): show the nearest decoded frame at or before the target
      // while decoding catches up. Playing: only the exact frame.
      // While dragging backward, stay on the keyframe (frames decoded after it would creep forward).
      const at = slot.refineTo !== undefined ? Math.min(v.mediaUs, slot.seekedTo) : v.mediaUs;
      const frames = slot.decoders.map((d) => (this.playing ? d.frameAt(at) : d.frameAtOrBefore(at)));
      if (frames[0]) slot.shownTs = frames[0].timestamp;
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
      this.lastTick = now;
      if (ready) {
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

  /** State of the decoders, for diagnostics. */
  debug() {
    return [...this.slots.values()].map((s) => ({ seekedTo: s.seekedTo, refineTo: s.refineTo, shownTs: s.shownTs, dec: s.decoders.map((d) => d.debug()) }));
  }

  close() {
    for (const id of [...this.slots.keys()]) this.drop(id);
  }
}

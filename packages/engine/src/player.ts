// Keeps several track decoders in lockstep on one clock (both halves of a .360 file).

import { TrackDecoder } from './decoder';
import type { ByteReader, VideoTrackInfo } from './source';

export class SyncedPlayer {
  readonly decoders: TrackDecoder[];
  /** Current position in microseconds. */
  time = 0;
  playing = false;
  readonly durationUs: number;
  private lastTick: number | null = null;
  /** Frames presented to the screen (for fps stats). */
  presented = 0;
  /** Ticks where the clock had to wait for the decoder. */
  stalls = 0;

  constructor(reader: ByteReader, tracks: VideoTrackInfo[]) {
    this.decoders = tracks.map((t) => new TrackDecoder(reader, t));
    const ends = tracks.map((t) => {
      const last = t.samples.reduce((m, s) => Math.max(m, s.timestamp + s.duration), 0);
      return last;
    });
    this.durationUs = Math.min(...ends);
    this.seek(0);
  }

  play() {
    if (this.time >= this.durationUs - 1) this.seek(0);
    this.playing = true;
    this.lastTick = null;
  }

  pause() {
    this.playing = false;
  }

  seek(us: number) {
    this.time = Math.max(0, Math.min(us, this.durationUs - 1));
    for (const d of this.decoders) d.seek(this.time);
  }

  /**
   * Call once per animation frame. Returns frames for every track when they are all
   * available for the current time, otherwise null (the caller keeps the last image).
   */
  tick(nowMs: number): VideoFrame[] | null {
    for (const d of this.decoders) void d.pump();
    const frames = this.decoders.map((d) => d.frameAt(this.time));
    const ready = frames.every((f): f is VideoFrame => f !== null);

    if (this.playing) {
      const dt = this.lastTick === null ? 0 : (nowMs - this.lastTick) * 1000;
      this.lastTick = nowMs;
      if (ready) {
        // Cap a single step so a long hitch does not skip ahead through un-decoded frames.
        this.time = Math.min(this.time + Math.min(dt, 100_000), this.durationUs - 1);
        if (this.time >= this.durationUs - 1) this.playing = false;
      } else {
        this.stalls++;
      }
    }
    if (!ready) return null;
    this.presented++;
    return frames as VideoFrame[];
  }

  close() {
    for (const d of this.decoders) d.close();
  }
}

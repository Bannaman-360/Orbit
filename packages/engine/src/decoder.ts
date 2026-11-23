// Hardware video decoding for one track via WebCodecs, with seeking and a small
// look-ahead queue of decoded frames.

import type { ByteReader, SampleRef, VideoTrackInfo } from './source';

export interface DecoderSupport {
  supported: boolean;
  hardware: boolean | 'unknown';
  codec: string;
  detail?: string;
}

export function decoderConfig(track: VideoTrackInfo, hw: HardwareAcceleration = 'prefer-hardware'): VideoDecoderConfig {
  return {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
    description: track.description,
    hardwareAcceleration: hw,
    optimizeForLatency: false,
  };
}

/** Checks whether this machine can decode the track, and whether it can do so in hardware. */
export async function probeDecoder(track: VideoTrackInfo): Promise<DecoderSupport> {
  if (typeof VideoDecoder === 'undefined') return { supported: false, hardware: false, codec: track.codec, detail: 'WebCodecs unavailable' };
  try {
    const hwOnly = await VideoDecoder.isConfigSupported(decoderConfig(track, 'prefer-hardware'));
    if (hwOnly.supported) return { supported: true, hardware: true, codec: track.codec };
    const any = await VideoDecoder.isConfigSupported(decoderConfig(track, 'no-preference'));
    return { supported: !!any.supported, hardware: false, codec: track.codec };
  } catch (e) {
    return { supported: false, hardware: 'unknown', codec: track.codec, detail: String(e) };
  }
}

export interface DecoderStats {
  decoded: number;
  dropped: number;
  queued: number;
  errors: string[];
}

/** How close to its end a frame counts as possibly over (µs). */
const EDGE_US = 500;

export class TrackDecoder {
  private decoder: VideoDecoder;
  private frames: VideoFrame[] = [];
  private next = 0; // next sample index to feed (decode order)
  private discardBefore = 0; // µs: frames ending before this are dropped (seek accuracy)
  private generation = 0;
  private pumping = false;
  /** Keyframe (sample index) the current decode run started from. */
  private runKey = -1;
  /** performance.now() of the last restart, and whether a frame has come out since. */
  private restartAt = 0;
  private sinceRestart = 0;
  readonly stats: DecoderStats = { decoded: 0, dropped: 0, queued: 0, errors: [] };

  /** Samples read from disk per request (fewer round trips when catching up). */
  static readBatch = 8;

  /** Decoded frames held ahead of the playhead. Hardware decoders have small frame pools, keep this low. */
  maxAhead = 5;

  /**
   * Media time one screen refresh covers while playing (µs; 0 = not playing). When that is more
   * than a frame, the ones in between are decoded but not kept, and decoding isn't paced by the screen.
   */
  pace = 0;
  private get fast() { return this.pace > this.frameUs * 1.15; }
  private readonly frameUs: number;
  private get stride() { return 2 ** Math.max(0, Math.floor(Math.log2((this.pace * 0.6) / this.frameUs))); }

  /**
   * Only decode keyframes: for playing faster than this computer can decode. Shows the nearest
   * one, so the picture keeps up with the clock.
   */
  get skim() { return this.skimming; }
  startSkim() { this.skimming = true; }
  /**
   * Back to every frame, from the next keyframe that can be ready in time (`lead` µs of media
   * ahead); until then the picture that is up stays.
   */
  endSkim(us: number, lead: number) {
    if (!this.skimming) return;
    this.skimming = false;
    const s = this.track.samples;
    let k = this.keyframeBefore(us) + 1;
    while (k < s.length && !(s[k]!.isSync && s[k]!.timestamp >= us + lead)) k++;
    // Frames were left out, so carrying on from here is not possible.
    if (k >= s.length || this.decoder.state !== 'configured') { this.runKey = -1; this.seek(us); return; }
    this.generation++;
    this.decoder.reset();
    this.decoder.configure(decoderConfig(this.track));
    while (this.frames.length > 1 && this.frames[1]!.timestamp <= us) this.frames.shift()!.close();
    for (const f of this.frames.splice(1)) f.close();
    this.next = k;
    this.runKey = k;
    this.discardBefore = s[k]!.timestamp;
    this.bridge = s[k]!.timestamp;
    this.restartAt = performance.now();
    this.sinceRestart = 0;
    void this.pump();
  }
  private skimming = false;
  /** Until this media time, the picture that is up stays. */
  private bridge = -Infinity;

  constructor(
    private readonly reader: ByteReader,
    readonly track: VideoTrackInfo,
  ) {
    this.frameUs = 1e6 / (track.fps || 30);
    this.decoder = this.createDecoder();
  }

  private createDecoder() {
    const d = new VideoDecoder({
      // reset() discards everything queued, so frames arriving belong to the current run.
      output: (f) => this.onFrame(f, this.generation),
      error: (e) => this.stats.errors.push(e.message),
    });
    d.configure(decoderConfig(this.track));
    return d;
  }

  private onFrame(frame: VideoFrame, gen: number) {
    if (gen !== this.generation || frame.timestamp + (frame.duration ?? 0) <= this.discardBefore) {
      frame.close();
      if (gen === this.generation) this.stats.dropped++;
      return;
    }
    this.stats.decoded++;
    this.sinceRestart++;
    // Playing fast: this picture would be gone before the screen's next refresh. (Which ones are
    // kept depends on their place alone, so both halves of a 360 picture keep the same ones.)
    if (this.fast && !this.skimming && this.frames.length && frame.timestamp > this.target && Math.round(frame.timestamp / this.frameUs) % this.stride) {
      frame.close();
      this.stats.dropped++;
      void this.pump();
      return;
    }
    this.frames.push(frame);
    this.frames.sort((a, b) => a.timestamp - b.timestamp);
    // Still on the way to the target: only the newest frame before it matters, so don't fill up
    // with the ones on the way (that would pace decoding by the screen's refreshes).
    while (this.frames.length > 1 && this.frames[1]!.timestamp <= this.target) this.frames.shift()!.close();
    // Keep the decoder busy between screen refreshes while catching up after a restart.
    if (this.catchingUp || this.fast) void this.pump();
  }

  /** Presentation time of the keyframe at or before `us`. */
  keyframeTimeBefore(us: number): number {
    return this.track.samples[this.keyframeBefore(us)]!.timestamp;
  }

  /** Index of the last keyframe at or before `us` (in decode order). */
  private keyframeBefore(us: number): number {
    const s = this.track.samples;
    let k = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i]!.dts > us) break;
      // (A keyframe can be shown later than it is decoded: frames before it belong to the previous run.)
      if (s[i]!.isSync && s[i]!.timestamp <= us) k = i;
    }
    return k;
  }

  /**
   * Moves to media time `us`. If `us` lies ahead within the stretch already being decoded,
   * decoding simply carries on (cheap); otherwise it restarts from the keyframe before `us`.
   * `progressive`: keep frames from the keyframe onwards so something can be shown at once
   * while decoding catches up (scrubbing); otherwise frames before `us` are dropped.
   * Returns true if it had to restart.
   */
  seek(us: number, progressive = false): boolean {
    this.bridge = -Infinity;
    this.target = us;
    const k = this.keyframeBefore(us);
    const head = this.frames[0]?.timestamp ?? this.discardBefore;
    const canContinue =
      this.decoder.state === 'configured' && this.runKey >= 0 && k <= this.next - 1 && k >= this.runKey && us >= head - 1000;
    if (canContinue) {
      // Same run: drop what is now behind us and keep going.
      if (!progressive) this.discardBefore = Math.max(this.discardBefore, us);
      while (this.frames.length > 1 && this.frames[1]!.timestamp <= us) this.frames.shift()!.close();
      void this.pump();
      return false;
    }
    this.generation++;
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state === 'configured') {
      this.decoder.reset();
      this.decoder.configure(decoderConfig(this.track));
    } else {
      if (this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = this.createDecoder();
    }
    this.next = k;
    this.runKey = k;
    // Progressive display only when moving forward: going backward, showing the keyframe and
    // then frames creeping forward towards the target feels like being pulled the wrong way.
    // Then the caller keeps showing the old picture until the exact frame is ready.
    const forward = us >= head;
    this.discardBefore = progressive && forward ? this.track.samples[k]!.timestamp : us;
    this.restartAt = performance.now();
    this.sinceRestart = 0;
    void this.pump();
    return true;
  }

  /** Still decoding towards the target after a restart (frames before it don't count). */
  private get catchingUp() {
    const last = this.frames[this.frames.length - 1];
    return !!last && last.timestamp < this.target;
  }
  private target = 0;

  /** True while a restart has not produced its first frame yet (and for how long). */
  get settlingMs(): number {
    return this.sinceRestart === 0 && this.runKey >= 0 ? performance.now() - this.restartAt : 0;
  }

  private get room() {
    // (A few more underway when most of them won't be kept.)
    return this.skimming ? 3 : this.fast ? this.maxAhead + 8 : this.maxAhead;
  }
  /** Keeps the decoder fed until enough frames are queued. Safe to call often. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.generation;
    try {
      const samples = this.track.samples;
      while (
        gen === this.generation &&
        this.next < samples.length &&
        this.frames.length + this.decoder.decodeQueueSize < this.room &&
        this.decoder.state === 'configured'
      ) {
        // Read several upcoming samples in one go (they sit close together in the file):
        // far fewer round trips than one read per frame.
        const room = Math.max(1, this.room - this.frames.length - this.decoder.decodeQueueSize);
        const batch: SampleRef[] = [];
        let lo = Infinity, hi = 0;
        if (this.skimming) {
          while (this.next < samples.length && !samples[this.next]!.isSync) this.next++;
          const s = samples[this.next];
          if (!s) break;
          const data = await this.reader.read(s.offset, s.size);
          if (gen !== this.generation || this.decoder.state !== 'configured') break;
          this.next++;
          this.decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: s.timestamp, duration: s.duration, data }));
          continue;
        }
        for (let i = this.next; i < samples.length && batch.length < Math.min(TrackDecoder.readBatch, room); i++) {
          const s = samples[i]!;
          const nlo = Math.min(lo, s.offset), nhi = Math.max(hi, s.offset + s.size);
          if (batch.length && nhi - nlo > 24 * 1024 * 1024) break;
          batch.push(s);
          lo = nlo;
          hi = nhi;
        }
        const data = await this.reader.read(lo, hi - lo);
        if (gen !== this.generation || this.decoder.state !== 'configured') break;
        for (const s of batch) {
          this.next++;
          this.decoder.decode(
            new EncodedVideoChunk({ type: s.isSync ? 'key' : 'delta', timestamp: s.timestamp, duration: s.duration, data: data.subarray(s.offset - lo, s.offset - lo + s.size) }),
          );
        }
      }
      // Flush at end of stream so the last frames come out.
      if (gen === this.generation && this.next >= samples.length && this.decoder.state === 'configured') {
        await this.decoder.flush().catch(() => {});
      }
    } finally {
      this.pumping = false;
      this.stats.queued = this.frames.length;
    }
  }

  /**
   * The frame to show at `us`, or null if it has not been decoded yet.
   * Frames entirely before `us` are released.
   */
  frameAt(us: number): VideoFrame | null {
    this.target = us;
    while (this.frames.length > 1 && this.frames[1]!.timestamp <= us) this.frames.shift()!.close();
    const f = this.frames[0];
    if (!f) return null;
    if (this.skimming || us < this.bridge) return f;
    const end = f.timestamp + (f.duration ?? 0);
    // Times are rounded to whole microseconds, so a frame can seem to last into the next one.
    // Right at that edge, wait for the next frame to be decoded before deciding (otherwise the
    // previous picture is taken for this moment, with the wrong stabilisation).
    const sure = this.frames.length > 1 || end - EDGE_US > us || this.isLastFrame(f);
    return f.timestamp <= us + 1000 && sure ? f : null;
  }

  private isLastFrame(f: VideoFrame) {
    const last = this.track.samples.reduce((m, s) => Math.max(m, s.timestamp), 0);
    return f.timestamp >= last;
  }

  /**
   * Latest decoded frame at or before `us` (scrubbing: shows the nearest frame while
   * decoding catches up). Older frames are released.
   */
  frameAtOrBefore(us: number): VideoFrame | null {
    while (this.frames.length > 1 && this.frames[1]!.timestamp <= us + 1000) this.frames.shift()!.close();
    const f = this.frames[0];
    return f && f.timestamp <= us + 1000 ? f : null;
  }

  debug() {
    return { skim: this.skimming, state: this.decoder.state, next: this.next, runKey: this.runKey, frames: this.frames.map((f) => f.timestamp), discardBefore: this.discardBefore, queue: this.decoder.decodeQueueSize, errors: this.stats.errors.slice(-2), pumping: this.pumping };
  }

  /** Releases frames and closes the decoder. */
  close() {
    this.generation++;
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}

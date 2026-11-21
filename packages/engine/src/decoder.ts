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

export class TrackDecoder {
  private decoder: VideoDecoder;
  private frames: VideoFrame[] = [];
  private next = 0; // next sample index to feed (decode order)
  private discardBefore = 0; // µs: frames ending before this are dropped (seek accuracy)
  private generation = 0;
  private pumping = false;
  readonly stats: DecoderStats = { decoded: 0, dropped: 0, queued: 0, errors: [] };

  /** Decoded frames held ahead of the playhead. Hardware decoders have small frame pools, keep this low. */
  maxAhead = 5;

  constructor(
    private readonly reader: ByteReader,
    readonly track: VideoTrackInfo,
  ) {
    this.decoder = this.createDecoder();
  }

  private createDecoder() {
    const gen = this.generation;
    const d = new VideoDecoder({
      output: (f) => this.onFrame(f, gen),
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
    this.frames.push(frame);
    this.frames.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Index of the last keyframe at or before `us` (in decode order). */
  private keyframeBefore(us: number): number {
    const s = this.track.samples;
    let k = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i]!.dts > us) break;
      if (s[i]!.isSync) k = i;
    }
    return k;
  }

  seek(us: number) {
    this.generation++;
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = this.createDecoder();
    this.next = this.keyframeBefore(us);
    this.discardBefore = us;
    void this.pump();
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
        this.frames.length + this.decoder.decodeQueueSize < this.maxAhead &&
        this.decoder.state === 'configured'
      ) {
        const s: SampleRef = samples[this.next++]!;
        const data = await this.reader.read(s.offset, s.size);
        if (gen !== this.generation || this.decoder.state !== 'configured') break;
        this.decoder.decode(
          new EncodedVideoChunk({ type: s.isSync ? 'key' : 'delta', timestamp: s.timestamp, duration: s.duration, data }),
        );
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
    while (this.frames.length > 1 && this.frames[1]!.timestamp <= us) this.frames.shift()!.close();
    const f = this.frames[0];
    if (!f) return null;
    const end = f.timestamp + (f.duration ?? 0);
    if (f.timestamp <= us + 1000 && (end > us || this.isLastFrame(f))) return f;
    return null;
  }

  private isLastFrame(f: VideoFrame) {
    const last = this.track.samples.reduce((m, s) => Math.max(m, s.timestamp), 0);
    return f.timestamp >= last;
  }

  /** Releases frames and closes the decoder. */
  close() {
    this.generation++;
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}

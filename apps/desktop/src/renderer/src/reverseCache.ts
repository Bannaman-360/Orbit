// Dragging backward through a clip: video can only be decoded forward from a keyframe, so each
// stretch between keyframes is decoded once, kept as smaller pictures, and shown from there.
// (Like a preview copy: the pictures hold the recorded values; see copyInput.)

import { decoderConfig, type VideoTrackInfo } from '@ace/engine';
import { equirectLayout, goproMaxLayout, ReframeRenderer, type EacLayout } from '@ace/media360';
import { copyInput } from './color';
import type { Media } from './media';

/** Memory the kept pictures may use (bytes). */
const BUDGET = 400e6;
/** Stretches kept: the one being shown and the one before it. */
const KEEP = 2;

interface Stretch { key: number; next: number; frames: Map<number, VideoFrame[]>; done: boolean; stop: boolean }

export class ReverseCache {
  readonly level: number;
  readonly layout: EacLayout | null;
  private stretches: Stretch[] = [];
  private building: Promise<void> | null = null;
  private keys: number[];
  private renderers: Promise<ReframeRenderer[]> | null = null;
  private closed = false;
  /** For checking: stretches made, and how long each took (ms). */
  readonly stats = { made: 0, ms: 0, frames: 0 };

  constructor(private media: Media) {
    const t = media.tracks[0]!;
    this.keys = t.samples.filter((s) => s.isSync).map((s) => s.timestamp).sort((a, b) => a - b);
    const gop = this.keys.length > 1 ? Math.ceil((this.keys[1]! - this.keys[0]!) / (1e6 / media.fps)) + 1 : 60;
    const bytes = (l: number) => (t.width / l) * (t.height / l) * 4 * media.tracks.length * gop * KEEP;
    this.level = [2, 4, 8].find((l) => bytes(l) <= BUDGET) ?? 8;
    const w = Math.round(t.width / this.level / 2) * 2, h = Math.round(t.height / this.level / 2) * 2;
    this.layout = media.layout ? (media.layout.equirect ? equirectLayout(w, h) : goproMaxLayout(w, h)) : null;
  }

  private keyBefore(us: number) {
    let lo = 0, hi = this.keys.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.keys[m]! <= us + 500) lo = m; else hi = m - 1; }
    return lo;
  }

  /** The kept picture at or just before a media time (null while that stretch is being made). */
  frameAt(us: number): VideoFrame[] | null {
    const k = this.keyBefore(us), key = this.keys[k]!;
    const s = this.stretches.find((x) => x.key === key);
    this.want(k);
    if (!s) return null;
    let best: number | null = null;
    for (const t of s.frames.keys()) if (t <= us + 500 && (best === null || t > best)) best = t;
    return best === null ? null : s.frames.get(best)!;
  }

  /** Makes sure the stretch from keyframe k is (being) made, and the one before it next. */
  private want(k: number) {
    if (this.closed) return;
    const key = this.keys[k]!;
    // Stretches still being made that the pointer has already left are of no use any more.
    for (const x of [...this.stretches]) if (!x.done && x.key !== key && x.key !== this.keys[k - 1]) this.free(x);
    if (!this.stretches.some((x) => x.key === key)) this.start(k);
    else if (k > 0 && !this.building && !this.stretches.some((x) => x.key === this.keys[k - 1]!)) this.start(k - 1);
    // Newest first; older ones go.
    const order = [key, this.keys[k - 1]];
    while (this.stretches.length > KEEP) {
      const drop = this.stretches.find((x) => !order.includes(x.key)) ?? this.stretches[this.stretches.length - 1]!;
      this.free(drop);
    }
  }

  private free(s: Stretch) {
    s.stop = true;
    for (const fs of s.frames.values()) fs.forEach((f) => f.close());
    s.frames.clear();
    this.stretches = this.stretches.filter((x) => x !== s);
  }

  private start(k: number) {
    // One stretch at a time: a newer wish replaces one not yet started.
    const s: Stretch = { key: this.keys[k]!, next: this.keys[k + 1] ?? Infinity, frames: new Map(), done: false, stop: false };
    for (const x of this.stretches) if (!x.done && x.frames.size === 0 && x !== s) x.stop = true;
    this.stretches = [s, ...this.stretches.filter((x) => !x.stop)];
    const run = async () => {
      await this.building?.catch(() => {});
      if (s.stop || this.closed) return;
      const t0 = performance.now();
      await this.decode(s);
      if (!s.stop) { this.stats.made++; this.stats.ms += performance.now() - t0; this.stats.frames += s.frames.size; }
    };
    const b: Promise<void> = run().finally(() => { s.done = true; if (this.building === b) this.building = null; });
    this.building = b;
  }

  private async decode(s: Stretch) {
    const { media } = this;
    const rs = await (this.renderers ??= Promise.all(media.tracks.map(async () => {
      const t = media.tracks[0]!;
      return ReframeRenderer.create(new OffscreenCanvas(Math.round(t.width / this.level / 2) * 2, Math.round(t.height / this.level / 2) * 2));
    })));
    const parts = new Map<number, (VideoFrame | null)[]>();
    let chain = Promise.resolve();
    /** A decoded picture: made small at once, and the decoder's own frame let go. */
    const take = (i: number, f: VideoFrame) => {
      chain = chain.then(async () => {
        try {
          if (s.stop || f.timestamp < s.key - 500 || f.timestamp >= s.next - 500) return;
          const r = rs[i]!;
          r.resetHistory();
          r.pushFrame({ frames: [f], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true, input: media.color ? copyInput(media) : undefined });
          r.present({ blendFrames: 1, bypass: true });
          const bmp = await createImageBitmap(r.canvas as OffscreenCanvas);
          const small = new VideoFrame(bmp, { timestamp: f.timestamp });
          bmp.close();
          const p = parts.get(f.timestamp) ?? new Array<VideoFrame | null>(media.tracks.length).fill(null);
          p[i] = small;
          parts.set(f.timestamp, p);
          if (p.every(Boolean) && !s.stop) { s.frames.set(f.timestamp, p as VideoFrame[]); parts.delete(f.timestamp); }
        } finally {
          f.close();
        }
      });
    };
    await Promise.all(media.tracks.map(async (track: VideoTrackInfo, i) => {
      const samples = track.samples;
      const from = samples.findIndex((x) => x.isSync && Math.abs(x.timestamp - s.key) < 500);
      if (from < 0) return;
      let to = samples.findIndex((x, j) => j > from && x.isSync);
      if (to < 0) to = samples.length;
      const d = new VideoDecoder({ output: (f) => take(i, f), error: () => {} });
      // (Stopped: what is queued is thrown away at once, so the decoder is free.)
      const halt = setInterval(() => { if (s.stop && d.state === 'configured') { d.reset(); clearInterval(halt); } }, 10);
      d.configure(decoderConfig(track));
      for (let j = from; j < to && !s.stop; j += 8) {
        const batch = samples.slice(j, Math.min(to, j + 8));
        const lo = Math.min(...batch.map((x) => x.offset)), hi = Math.max(...batch.map((x) => x.offset + x.size));
        const data = await media.reader.read(lo, hi - lo);
        if (s.stop || d.state !== 'configured') break;
        for (const x of batch) d.decode(new EncodedVideoChunk({ type: x.isSync ? 'key' : 'delta', timestamp: x.timestamp, duration: x.duration, data: data.subarray(x.offset - lo, x.offset - lo + x.size) }));
        // Don't run ahead of making the pictures small (the decoder has few frames to give).
        while (d.decodeQueueSize > 4 && !s.stop) await new Promise((r) => setTimeout(r, 1));
        await chain;
      }
      if (!s.stop) await d.flush().catch(() => {});
      clearInterval(halt);
      if (d.state !== 'closed') d.close();
    }));
    await chain;
    for (const p of parts.values()) p.forEach((f) => f?.close());
  }

  /** How long making a stretch takes (ms), and how much video a stretch is (µs). */
  get buildMs() { return this.stats.made ? this.stats.ms / this.stats.made : 300; }
  get stretchUs() { return this.keys.length > 1 ? (this.keys[this.keys.length - 1]! - this.keys[0]!) / (this.keys.length - 1) : 1e6; }

  /** The drag stopped: stop making pictures, so the decoder is free for the sharp one. */
  idle() {
    for (const x of [...this.stretches]) if (!x.done) this.free(x);
  }

  /** Memory in use (bytes), for checking. */
  get bytes() {
    let n = 0;
    for (const s of this.stretches) for (const fs of s.frames.values()) for (const f of fs) n += f.displayWidth * f.displayHeight * 4;
    return n;
  }

  close() {
    this.closed = true;
    for (const s of [...this.stretches]) this.free(s);
    void this.renderers?.then((rs) => rs.forEach((r) => r.destroy()));
  }
}

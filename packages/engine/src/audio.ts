// Decodes a file's audio track to PCM (WebCodecs AudioDecoder).

import type { AudioTrackInfo, ByteReader } from './source';

export interface PcmAudio {
  sampleRate: number;
  /** Planar float channels. */
  channels: Float32Array[];
  /** Media time of the first sample (µs). */
  startUs: number;
}

/** Decodes a run of packets of one file. */
async function decodeRun(reader: ByteReader, track: AudioTrackInfo, from: number, to: number): Promise<PcmAudio | null> {
  const config: AudioDecoderConfig = {
    codec: track.codec.startsWith('mp4a') ? (track.codec === 'mp4a' ? 'mp4a.40.2' : track.codec) : track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    description: track.description,
  };
  const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return null;

  const chunks: Float32Array[][] = [];
  let total = 0;
  let firstTs: number | null = null;
  let error: unknown = null;
  const dec = new AudioDecoder({
    output: (d) => {
      if (firstTs === null) firstTs = d.timestamp;
      const planes: Float32Array[] = [];
      for (let c = 0; c < d.numberOfChannels; c++) {
        const buf = new Float32Array(d.numberOfFrames);
        d.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
        planes.push(buf);
      }
      total += d.numberOfFrames;
      chunks.push(planes);
      d.close();
    },
    error: (e) => (error = e),
  });
  dec.configure(config);

  // Contiguous packets in one read, a few reads at a time.
  const s = track.samples;
  const reads: { a: number; b: number }[] = [];
  for (let i = from; i < to; ) {
    let j = i;
    while (j + 1 < to && s[j + 1]!.offset === s[j]!.offset + s[j]!.size && s[j + 1]!.offset + s[j + 1]!.size - s[i]!.offset < 2_000_000) j++;
    reads.push({ a: i, b: j });
    i = j + 1;
  }
  for (let k = 0; k < reads.length; k += 24) {
    const part = reads.slice(k, k + 24);
    const data = await Promise.all(part.map(({ a, b }) => reader.read(s[a]!.offset, s[b]!.offset + s[b]!.size - s[a]!.offset)));
    part.forEach(({ a, b }, n) => {
      for (let p = a; p <= b; p++) {
        const o = s[p]!.offset - s[a]!.offset;
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s[p]!.timestamp, duration: s[p]!.duration, data: data[n]!.subarray(o, o + s[p]!.size) }));
      }
    });
  }
  await dec.flush();
  dec.close();
  if (error || !chunks.length) return null;

  const nch = chunks[0]!.length;
  const channels = Array.from({ length: nch }, () => new Float32Array(total));
  let off = 0;
  for (const planes of chunks) {
    for (let c = 0; c < nch; c++) channels[c]!.set(planes[c] ?? planes[0]!, off);
    off += planes[0]!.length;
  }
  return { sampleRate: track.sampleRate, channels, startUs: firstTs ?? 0 };
}

/** End of a track's sound, µs. */
export const audioEnd = (track: AudioTrackInfo): number => { const l = track.samples[track.samples.length - 1]; return l ? l.timestamp + l.duration : 0; };

/**
 * The sound between two media times, placed by its timestamps (silence where there is none), so
 * it stays in step with the picture across the files of a chaptered recording.
 */
export async function decodeAudioRange(reader: ByteReader, track: AudioTrackInfo, fromUs: number, toUs: number): Promise<PcmAudio | null> {
  if (typeof AudioDecoder === 'undefined' || !track.samples.length) return null;
  const s = track.samples, rate = track.sampleRate;
  const length = Math.max(0, Math.round(((toUs - fromUs) / 1e6) * rate));
  let channels: Float32Array[] | null = null;
  const edges = [0, ...(track.joins ?? []), s.length];
  for (let e = 0; e + 1 < edges.length; e++) {
    const a = edges[e]!, b = edges[e + 1]!;
    if (a >= b || s[b - 1]!.timestamp + s[b - 1]!.duration <= fromUs || s[a]!.timestamp >= toUs) continue;
    let lo = a, hi = b;
    while (lo < b && s[lo]!.timestamp + s[lo]!.duration <= fromUs) lo++;
    while (hi > lo && s[hi - 1]!.timestamp >= toUs) hi--;
    // Packets build on the one before: start a little early, and drop what that gives.
    const pcm = await decodeRun(reader, track, Math.max(a, lo - 3), hi);
    if (!pcm) return null;
    channels ??= pcm.channels.map(() => new Float32Array(length));
    const at = Math.round(((pcm.startUs - fromUs) / 1e6) * rate);
    const skip = Math.max(0, -at), n = Math.min(pcm.channels[0]!.length - skip, length - Math.max(0, at));
    // The next file's sound takes over where it starts.
    if (n > 0) channels.forEach((c, k) => c.set((pcm.channels[k] ?? pcm.channels[0]!).subarray(skip, skip + n), Math.max(0, at)));
  }
  return channels && { sampleRate: rate, channels, startUs: fromUs };
}

/**
 * Stereo for playback. 4-channel GoPro 360 audio is first-order ambisonics (W, Y, Z, X
 * in AmbiX order); a simple forward-facing stereo decode is W ± Y.
 */
export function toStereo(pcm: PcmAudio): [Float32Array, Float32Array] {
  const ch = pcm.channels;
  if (ch.length === 1) return [ch[0]!, ch[0]!];
  if (ch.length === 4) {
    const [w, y] = [ch[0]!, ch[1]!];
    const l = new Float32Array(w.length), r = new Float32Array(w.length);
    for (let i = 0; i < w.length; i++) {
      l[i] = 0.7 * (w[i]! + y[i]!);
      r[i] = 0.7 * (w[i]! - y[i]!);
    }
    return [l, r];
  }
  return [ch[0]!, ch[1]!];
}

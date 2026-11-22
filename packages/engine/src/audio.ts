// Decodes a file's audio track to PCM (WebCodecs AudioDecoder).

import type { AudioTrackInfo, ByteReader } from './source';

export interface PcmAudio {
  sampleRate: number;
  /** Planar float channels. */
  channels: Float32Array[];
  /** Media time of the first sample (µs). */
  startUs: number;
}

/** Decodes the whole track. Audio tracks are small (a minute of AAC ≈ 1 MB). */
export async function decodeAudioTrack(reader: ByteReader, track: AudioTrackInfo): Promise<PcmAudio | null> {
  if (typeof AudioDecoder === 'undefined' || !track.samples.length) return null;
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

  // Read in batches of contiguous samples to keep IPC calls few.
  const s = track.samples;
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1]!.offset === s[j]!.offset + s[j]!.size && s[j + 1]!.offset + s[j + 1]!.size - s[i]!.offset < 2_000_000) j++;
    const bytes = await reader.read(s[i]!.offset, s[j]!.offset + s[j]!.size - s[i]!.offset);
    for (let k = i; k <= j; k++) {
      const o = s[k]!.offset - s[i]!.offset;
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s[k]!.timestamp, duration: s[k]!.duration, data: bytes.subarray(o, o + s[k]!.size) }));
    }
    i = j + 1;
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

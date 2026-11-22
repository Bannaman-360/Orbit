// MP4 / .360 container access. Parses only the index (moov) and then reads sample
// bytes on demand by offset, so multi-GB files never have to be loaded into memory.

import { createFile, DataStream, Endianness, MP4BoxBuffer, type Movie, type Sample } from 'mp4box';

/** Random-access byte source. In the app it is backed by IPC to the main process. */
export interface ByteReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface SampleRef {
  /** Byte offset and size inside the file. */
  offset: number;
  size: number;
  /** Presentation time and duration in microseconds. */
  timestamp: number;
  duration: number;
  /** Decode timestamp in microseconds. */
  dts: number;
  isSync: boolean;
}

export interface VideoTrackInfo {
  id: number;
  codec: string;
  width: number;
  height: number;
  /** Codec-specific config (hvcC / avcC payload) for VideoDecoder.configure. */
  description?: Uint8Array;
  samples: SampleRef[];
  fps: number;
}

export interface DataTrackInfo {
  id: number;
  codec: string;
  name: string;
  samples: SampleRef[];
}

export interface MediaInfo {
  durationUs: number;
  created?: Date;
  videoTracks: VideoTrackInfo[];
  /** GoPro telemetry (GPMF, sample entry 'gpmd'). */
  gpmfTrack?: DataTrackInfo;
  audioTracks: AudioTrackInfo[];
  /** Kept for diagnostics. */
  audioTrackCount: number;
}

export interface AudioTrackInfo {
  id: number;
  codec: string;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig for AAC (WebCodecs `description`). */
  description?: Uint8Array;
  samples: SampleRef[];
}

const CHUNK = 4 * 1024 * 1024;

export async function openMedia(reader: ByteReader): Promise<MediaInfo> {
  const file = createFile();
  let info: Movie | null = null;
  let error: unknown = null;
  file.onReady = (m) => (info = m);
  file.onError = (_module: string, message: string) => (error = new Error(message));

  let pos = 0;
  while (!info && !error && pos < reader.size) {
    const len = Math.min(CHUNK, reader.size - pos);
    const bytes = await reader.read(pos, len);
    const buf = MP4BoxBuffer.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, pos);
    // appendBuffer returns where the parser wants to read next. For files with the
    // index at the end it skips straight over the media data.
    const next = file.appendBuffer(buf, pos + len >= reader.size);
    pos = next > pos ? next : pos + len;
  }
  if (error) throw error;
  if (!info) throw new Error('Not a readable MP4: no movie header (moov) found');
  const movie = info as Movie;

  const toUs = (v: number, timescale: number) => Math.round((v * 1e6) / timescale);
  const refs = (id: number): SampleRef[] =>
    file.getTrackSamplesInfo(id).map((s: Sample) => ({
      offset: s.offset,
      size: s.size,
      timestamp: toUs(s.cts, s.timescale),
      duration: toUs(s.duration, s.timescale),
      dts: toUs(s.dts, s.timescale),
      isSync: s.is_sync,
    }));

  const videoTracks: VideoTrackInfo[] = movie.videoTracks.map((t) => {
    const samples = refs(t.id);
    const avgDur = samples.length ? samples.reduce((a, s) => a + s.duration, 0) / samples.length : 33366;
    return {
      id: t.id,
      codec: t.codec,
      width: t.video?.width ?? t.track_width,
      height: t.video?.height ?? t.track_height,
      description: codecDescription(file, t.id),
      samples,
      fps: 1e6 / avgDur,
    };
  });

  const gp = movie.tracks.find((t) => t.codec.startsWith('gpmd'));
  return {
    durationUs: toUs(movie.duration, movie.timescale),
    created: movie.created,
    videoTracks,
    gpmfTrack: gp ? { id: gp.id, codec: gp.codec, name: gp.name, samples: refs(gp.id) } : undefined,
    audioTracks: movie.audioTracks.map((t) => ({
      id: t.id,
      codec: t.codec,
      sampleRate: t.audio?.sample_rate ?? 48000,
      channels: t.audio?.channel_count ?? 2,
      description: audioDescription(file, t.id),
      samples: refs(t.id),
    })),
    audioTrackCount: movie.audioTracks.length,
  };
}

/** AAC AudioSpecificConfig from the esds box (decoder-specific info). */
function audioDescription(file: ReturnType<typeof createFile>, trackId: number): Uint8Array | undefined {
  try {
    const trak = file.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      // esds → ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo
      const esd = (entry as unknown as { esds?: { esd?: { descs?: { descs?: { data?: Uint8Array }[] }[] } } }).esds?.esd;
      const data = esd?.descs?.[0]?.descs?.[0]?.data;
      if (data) return new Uint8Array(data);
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Serialises the avcC / hvcC box payload that WebCodecs needs as `description`. */
function codecDescription(file: ReturnType<typeof createFile>, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const e = entry as unknown as Record<string, { write(s: DataStream): void } | undefined>;
    const box = e.avcC ?? e.hvcC ?? e.vpcC ?? e.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer as ArrayBuffer, 8); // drop the 8-byte box header
    }
  }
  return undefined;
}

/**
 * The pair of video tracks that make up a GoPro .360 file, or null for ordinary footage.
 * Max files carry two same-sized HEVC tracks; their order in the file is stream 0, stream 1.
 */
export function find360Pair(info: MediaInfo): [VideoTrackInfo, VideoTrackInfo] | null {
  const v = info.videoTracks;
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++)
      if (v[i]!.width === v[j]!.width && v[i]!.height === v[j]!.height && v[i]!.width > 2 * v[i]!.height)
        return [v[i]!, v[j]!];
  return null;
}

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
  /** Quarter turns clockwise to show the picture upright (from the file's display matrix). */
  turns: number;
  /** What the container says about its colours (numbers as in H.273). */
  colr?: { primaries: number; transfer: number; matrix: number; full: boolean };
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
  /** Samples at which another file of a chaptered recording starts. */
  joins?: number[];
}

const CHUNK = 4 * 1024 * 1024;

export async function openMedia(reader: ByteReader): Promise<MediaInfo> {
  const file = createFile();
  // Cameras with a GPS fix write their position under a name (©xyz) that isn't plain ASCII.
  file.allowInvalidBoxTypes = true;
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
  // Reordered frames start a little into their track's own clock; the edit list says by how much.
  const editStart = (id: number): number => {
    const list = (file.getTrackById(id) as unknown as { edts?: { elst?: { entries?: { media_time: number }[] } } }).edts?.elst?.entries;
    const t = list?.find((e) => e.media_time >= 0)?.media_time ?? 0;
    return list?.length === 1 ? t : 0;
  };
  const refs = (id: number, start = 0): SampleRef[] =>
    file.getTrackSamplesInfo(id).map((s: Sample) => ({
      offset: s.offset,
      size: s.size,
      // (More than a second would be a trim, not reordering: left as it is.)
      timestamp: toUs(s.cts - (start < s.timescale ? start : 0), s.timescale),
      duration: toUs(s.duration, s.timescale),
      dts: toUs(s.dts - (start < s.timescale ? start : 0), s.timescale),
      isSync: s.is_sync,
    }));

  const videoTracks: VideoTrackInfo[] = movie.videoTracks.map((t) => {
    const samples = refs(t.id, editStart(t.id));
    const avgDur = samples.length ? samples.reduce((a, s) => a + s.duration, 0) / samples.length : 33366;
    return {
      id: t.id,
      codec: t.codec,
      width: t.video?.width ?? t.track_width,
      height: t.video?.height ?? t.track_height,
      description: codecDescription(file, t.id),
      samples,
      fps: 1e6 / avgDur,
      turns: quarterTurns((t as unknown as { matrix?: ArrayLike<number> }).matrix),
      colr: containerColour(file, t.id),
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

function containerColour(file: ReturnType<typeof createFile>, trackId: number): VideoTrackInfo['colr'] {
  for (const entry of file.getTrackById(trackId).mdia.minf.stbl.stsd.entries) {
    const e = entry as unknown as { colr?: unknown; boxes?: { type?: string; colour_type?: string; colour_primaries?: number; transfer_characteristics?: number; matrix_coefficients?: number; full_range_flag?: number }[] };
    const c = e.boxes?.find((b) => b.type === 'colr' && b.colour_type?.startsWith('ncl'));
    if (c) return { primaries: c.colour_primaries ?? 2, transfer: c.transfer_characteristics ?? 2, matrix: c.matrix_coefficients ?? 2, full: !!c.full_range_flag };
  }
  return undefined;
}

/**
 * Whether an H.264 stream says itself if its values use the full range: undefined when it
 * doesn't (then decoders assume video range, whatever the container says). From the avcC box.
 */
export function avcFullRange(avcC: Uint8Array): boolean | undefined {
  if (avcC.length < 9 || !(avcC[5]! & 31)) return undefined;
  const len = (avcC[6]! << 8) | avcC[7]!, nal = avcC.subarray(8, 8 + len);
  // Without the bytes inserted to avoid start codes.
  const rb: number[] = [];
  for (let i = 1; i < nal.length; i++) { if (i > 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; rb.push(nal[i]!); }
  let pos = 0;
  const bit = () => { const v = ((rb[pos >> 3] ?? 0) >> (7 - (pos & 7))) & 1; pos++; return v; };
  const bits = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
  const ue = () => { let z = 0; while (!bit() && z < 32) z++; return 2 ** z - 1 + bits(z); };
  const se = () => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };
  const profile = bits(8);
  bits(16);
  ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = ue();
    if (chroma === 3) bit();
    ue(); ue(); bit();
    if (bit()) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (bit()) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; } }
  }
  ue();
  const poc = ue();
  if (poc === 0) ue();
  else if (poc === 1) { bit(); se(); se(); for (let n = ue(); n > 0; n--) se(); }
  ue(); bit(); ue(); ue();
  if (!bit()) bit();
  bit();
  if (bit()) { ue(); ue(); ue(); ue(); }
  if (!bit()) return undefined;
  if (bit() && bits(8) === 255) bits(32);
  if (bit()) bit();
  if (!bit()) return undefined;
  bits(3);
  return !!bit();
}

/** Rotation in a track's display matrix (16.16 fixed point), as clockwise quarter turns. */
export function quarterTurns(m: ArrayLike<number> | undefined): number {
  if (!m || m.length < 5) return 0;
  const a = m[0]!, b = m[1]!;
  if (!a && !b) return 0;
  return ((Math.round(Math.atan2(b, a) / (Math.PI / 2)) % 4) + 4) % 4;
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

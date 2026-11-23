// Long recordings: the camera splits them into several files ("chapters"). Finds which files
// belong together and presents them as one, without copying anything.

import type { AudioTrackInfo, ByteReader, MediaInfo, SampleRef, VideoTrackInfo } from './source';

export interface ChapterName {
  /** Same for every chapter of a recording. */
  key: string;
  /** 1, 2, 3 … */
  part: number;
}

/**
 * GoPro chapter names. HERO6 and newer, Max: GX010133.MP4, GX020133.MP4 … (GH, GX, GS = format,
 * two digits = chapter, four = recording). Older: GOPR0133.MP4, GP010133.MP4, GP020133.MP4 …
 */
export function chapterName(file: string): ChapterName | null {
  const name = file.split(/[\\/]/).pop() ?? file;
  let m = /^(G[HXS])(\d{2})(\d{4})\.(mp4|360)$/i.exec(name);
  if (m) return Number(m[2]) ? { key: `${m[1]}${m[3]}.${m[4]}`.toLowerCase(), part: Number(m[2]) } : null;
  m = /^GOPR(\d{4})\.(mp4)$/i.exec(name);
  if (m) return { key: `gopr${m[1]}.${m[2]}`.toLowerCase(), part: 1 };
  m = /^GP(\d{2})(\d{4})\.(mp4)$/i.exec(name);
  if (m) return Number(m[1]) ? { key: `gopr${m[2]}.${m[3]}`.toLowerCase(), part: Number(m[1]) + 1 } : null;
  return null;
}

/** The files among `names` that are chapters of the same recording as `name`, in order. */
export function chaptersOf(name: string, names: string[]): { name: string; part: number }[] {
  const me = chapterName(name);
  if (!me) return [];
  const byPart = new Map<number, string>();
  for (const n of [name, ...names]) {
    const c = chapterName(n);
    if (c?.key === me.key && !byPart.has(c.part)) byPart.set(c.part, n);
  }
  return [...byPart].map(([part, n]) => ({ name: n, part })).sort((a, b) => a.part - b.part);
}

const sameBytes = (a?: Uint8Array, b?: Uint8Array) => (!a && !b) || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
export const videoEnd = (m: MediaInfo): number => m.videoTracks[0]?.samples.reduce((x, s) => Math.max(x, s.timestamp + s.duration), 0) ?? 0;

/** Why `b` can't be the chapter right after `a` (which starts `before` µs into the recording); null when it can. */
export function cannotFollow(first: MediaInfo, a: MediaInfo, b: MediaInfo, beforeUs = 0): string | null {
  if (a.videoTracks.length !== b.videoTracks.length || !b.videoTracks.length) return 'it holds different video tracks';
  for (const [i, x] of a.videoTracks.entries()) {
    const y = b.videoTracks[i]!;
    if (x.codec !== y.codec || x.width !== y.width || x.height !== y.height || x.turns !== y.turns) return 'its picture has another size or format';
    if (Math.abs(x.fps / y.fps - 1) > 0.01) return 'it was recorded at another frame rate';
    if (!sameBytes(x.description, y.description)) return 'its video was encoded differently';
  }
  if (a.audioTracks.length !== b.audioTracks.length) return 'it holds different sound tracks';
  for (const [i, x] of a.audioTracks.entries()) {
    const y = b.audioTracks[i]!;
    if (x.codec !== y.codec || x.sampleRate !== y.sampleRate || x.channels !== y.channels || !sameBytes(x.description, y.description)) return 'its sound has another format';
  }
  if (first.created && b.created) {
    // Cameras stamp each chapter with the start of the recording or of the chapter itself.
    const late = (b.created.getTime() - first.created.getTime()) / 1000;
    if (late < -60 || late > (beforeUs + videoEnd(a)) / 1e6 + 300) return 'it was recorded at another time';
  }
  return null;
}

/** Several files read as if they were one, end to end. */
export function joinReaders(parts: ByteReader[]): ByteReader {
  const starts: number[] = [];
  let size = 0;
  for (const p of parts) { starts.push(size); size += p.size; }
  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length);
      const pieces: { at: number; data: Promise<Uint8Array> }[] = [];
      for (const [i, p] of parts.entries()) {
        const lo = Math.max(offset, starts[i]!), hi = Math.min(end, starts[i]! + p.size);
        if (lo < hi) pieces.push({ at: lo - offset, data: p.read(lo - starts[i]!, hi - lo) });
      }
      if (pieces.length === 1) return pieces[0]!.data;
      const out = new Uint8Array(Math.max(0, end - offset));
      for (const x of pieces) out.set(await x.data, x.at);
      return out;
    },
  };
}

/** One recording from its chapters (already checked with cannotFollow). */
export function joinMedia(parts: { reader: ByteReader; info: MediaInfo }[]): { reader: ByteReader; info: MediaInfo; starts: number[] } {
  const first = parts[0]!.info;
  const starts: number[] = [], bytes: number[] = [];
  let t = 0, pos = 0;
  for (const p of parts) {
    starts.push(t);
    bytes.push(pos);
    t += videoEnd(p.info);
    pos += p.reader.size;
  }
  const merge = (pick: (m: MediaInfo) => { samples: SampleRef[] } | undefined): SampleRef[] =>
    parts.flatMap((p, i) => (pick(p.info)?.samples ?? []).map((s) => ({ ...s, offset: s.offset + bytes[i]!, timestamp: s.timestamp + starts[i]!, dts: s.dts + starts[i]! })));
  const info: MediaInfo = {
    ...first,
    durationUs: parts.reduce((m, p, i) => Math.max(m, starts[i]! + p.info.durationUs), 0),
    videoTracks: first.videoTracks.map((v, k): VideoTrackInfo => ({ ...v, samples: merge((m) => m.videoTracks[k]) })),
    audioTracks: first.audioTracks.map((a, k): AudioTrackInfo => {
      // Sound comes in packets, which don't end exactly where a file's last picture does. It was
      // one stream to the camera: where files meet within a packet or so, it simply carries on.
      const joins: number[] = [], samples: SampleRef[] = [];
      for (const [i, p] of parts.entries()) {
        const s = p.info.audioTracks[k]?.samples ?? [];
        if (!s.length) continue;
        const prev = samples[samples.length - 1], end = prev && prev.timestamp + prev.duration;
        const at = starts[i]! + s[0]!.timestamp;
        const by = end !== undefined && Math.abs(end - at) < 1.5 * s[0]!.duration ? end - s[0]!.timestamp : starts[i]!;
        if (samples.length) joins.push(samples.length);
        for (const x of s) samples.push({ ...x, offset: x.offset + bytes[i]!, timestamp: x.timestamp + by, dts: x.dts + by });
      }
      return { ...a, samples, joins };
    }),
    gpmfTrack: first.gpmfTrack && { ...first.gpmfTrack, samples: merge((m) => m.gpmfTrack) },
  };
  return { reader: joinReaders(parts.map((p) => p.reader)), info, starts };
}

// Media library: everything learned about a source file, opened once and cached.

import {
  decodeAudioTrack,
  decoderConfig,
  find360Pair,
  openMedia,
  probeDecoder,
  toStereo,
  type ByteReader,
  type DecoderSupport,
  type MediaInfo,
  type VideoTrackInfo,
} from '@ace/engine';
import { goproMaxLayout, type EacLayout } from '@ace/media360';
import { alignToFrames, smoothGravity, Stabilizer, TelemetrySeries, type OrientationData } from '@ace/telemetry';
import { ace, baseName, ipcReader } from './api';

export interface Media {
  path: string;
  name: string;
  size: number;
  reader: ByteReader;
  info: MediaInfo;
  is360: boolean;
  /** Tracks to decode: both halves of a .360, or the single video track. */
  tracks: VideoTrackInfo[];
  layout: EacLayout | null;
  stabilizer: Stabilizer;
  /** GPS / accelerometer readouts for overlays. */
  telemetry: TelemetrySeries;
  support: DecoderSupport[];
  durationUs: number;
  fps: number;
  width: number;
  height: number;
  thumbnail?: string;
  telemetryError?: string;
}

export interface Music {
  path: string;
  name: string;
  durationUs: number;
  buffer: AudioBuffer;
}

const media = new Map<string, Promise<Media>>();
const clipAudio = new Map<string, Promise<AudioBuffer | null>>();
const music = new Map<string, Promise<Music>>();

/** Shared context used to build AudioBuffers (playback creates its own). */
let decodeCtx: AudioContext | null = null;
const audioCtx = () => (decodeCtx ??= new AudioContext({ sampleRate: 48000 }));

export function getMedia(path: string): Promise<Media> {
  let p = media.get(path);
  if (!p) {
    p = loadMedia(path);
    media.set(path, p);
    p.catch(() => media.delete(path));
  }
  return p;
}

/** Already-loaded media (or undefined), for hot paths that cannot await. */
const ready = new Map<string, Media>();
export const mediaNow = (path: string) => ready.get(path);

async function loadMedia(path: string): Promise<Media> {
  const { size } = await ace.stat(path);
  const reader = ipcReader(path, size);
  const info = await openMedia(reader);
  const pair = find360Pair(info);
  const tracks = pair ?? info.videoTracks.slice(0, 1);
  if (!tracks.length) throw new Error(`${baseName(path)}: no video track`);
  const support = await Promise.all(tracks.map(probeDecoder));
  const bad = support.find((s) => !s.supported);
  if (bad) throw new Error(`${baseName(path)}: this computer cannot decode ${bad.codec}`);

  let orientation: OrientationData | null = null;
  let telemetryError: string | undefined;
  if (info.gpmfTrack) {
    try {
      const raw = await ace.orientation(path, {
        samples: info.gpmfTrack.samples.map(({ offset, size, timestamp, duration }) => ({ offset, size, timestamp, duration })),
        durationUs: info.durationUs,
        created: info.created?.toISOString(),
      });
      const frameTimes = tracks[0]!.samples.map((s) => s.timestamp).sort((a, b) => a - b);
      const aligned = alignToFrames(raw, frameTimes);
      orientation = { ...aligned, grav: smoothGravity(aligned.grav) };
    } catch (e) {
      telemetryError = String(e);
    }
  }

  const t0 = tracks[0]!;
  const durationUs = Math.min(...tracks.map((t) => t.samples.reduce((m, s) => Math.max(m, s.timestamp + s.duration), 0)));
  const m: Media = {
    path,
    name: baseName(path),
    size,
    reader,
    info,
    is360: !!pair,
    tracks,
    layout: pair ? goproMaxLayout(pair[0].width, pair[0].height) : null,
    stabilizer: new Stabilizer(orientation),
    telemetry: new TelemetrySeries(orientation?.gps, orientation?.accl),
    support,
    durationUs,
    fps: t0.fps,
    width: t0.width,
    height: t0.height,
    telemetryError,
  };
  m.thumbnail = await makeThumbnail(m).catch(() => undefined);
  ready.set(path, m);
  return m;
}

/** Decodes the first keyframe and draws a small preview (front face for 360). */
async function makeThumbnail(m: Media): Promise<string> {
  const track = m.tracks[0]!;
  const first = track.samples.find((s) => s.isSync)!;
  const data = await m.reader.read(first.offset, first.size);
  const frame = await new Promise<VideoFrame>((resolve, reject) => {
    const dec = new VideoDecoder({ output: (f) => { resolve(f); dec.close(); }, error: reject });
    dec.configure(decoderConfig(track));
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: first.timestamp, data }));
    void dec.flush().catch(() => {});
  });
  const W = 192, H = 108;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d')!;
  if (m.layout) {
    const front = m.layout.tiles.find((t) => t.face === 'front')!;
    // Middle band of the front face, 16:9.
    const sh = front.size * (9 / 16);
    ctx.drawImage(frame, front.x, front.y + (front.size - sh) / 2, front.size, sh, 0, 0, W, H);
  } else {
    const sw = frame.displayWidth, sh = frame.displayHeight;
    const scale = Math.max(W / sw, H / sh);
    ctx.drawImage(frame, (W - sw * scale) / 2, (H - sh * scale) / 2, sw * scale, sh * scale);
  }
  frame.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return URL.createObjectURL(blob);
}

/** The clip's own sound as stereo, or null when it has none / cannot be decoded. */
export function getClipAudio(m: Media): Promise<AudioBuffer | null> {
  let p = clipAudio.get(m.path);
  if (!p) {
    p = (async () => {
      const track = m.info.audioTracks[0];
      if (!track) return null;
      const pcm = await decodeAudioTrack(m.reader, track);
      if (!pcm) return null;
      const [l, r] = toStereo(pcm);
      // Pad the start so buffer time 0 = media time 0.
      const pad = Math.round((pcm.startUs / 1e6) * pcm.sampleRate);
      const buf = audioCtx().createBuffer(2, l.length + Math.max(0, pad), pcm.sampleRate);
      buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0, Math.max(0, pad));
      buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1, Math.max(0, pad));
      return buf;
    })().catch(() => null);
    clipAudio.set(m.path, p);
  }
  return p;
}

const VIDEO_RE = /\.(360|mp4|mov|lrv)$/i;

export function getMusic(path: string): Promise<Music> {
  let p = music.get(path);
  if (!p) {
    p = (async () => {
      // A video's own sound (detached onto the audio track).
      if (VIDEO_RE.test(path)) {
        const m = await getMedia(path);
        const buffer = await getClipAudio(m);
        if (!buffer) throw new Error('This video has no sound');
        return { path, name: baseName(path), durationUs: Math.round(buffer.duration * 1e6), buffer };
      }
      const bytes = await ace.readAll(path);
      const buffer = await audioCtx().decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      return { path, name: baseName(path), durationUs: Math.round(buffer.duration * 1e6), buffer };
    })();
    music.set(path, p);
    p.catch(() => music.delete(path));
  }
  return p;
}

export const musicNow = new Map<string, Music>();
export async function loadMusic(path: string) {
  const m = await getMusic(path);
  musicNow.set(path, m);
  return m;
}

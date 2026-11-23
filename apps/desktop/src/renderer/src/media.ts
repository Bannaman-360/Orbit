// Media library: everything learned about a source file, opened once and cached.

import {
  audioEnd,
  cannotFollow,
  decodeAudioRange,
  decoderConfig,
  find360Pair,
  isEquirect,
  joinMedia,
  videoEnd,
  openMedia,
  readUserData,
  probeDecoder,
  toStereo,
  type AudioTrackInfo,
  type ByteReader,
  type DecoderSupport,
  type MediaInfo,
  type VideoTrackInfo,
} from '@ace/engine';
import { equirectLayout, goproMaxLayout, lensFor, type EacLayout, type SourceLens } from '@ace/media360';
import { alignToFrames, cameraInfo, parseKlv, joinOrientation, smoothGravity, type CameraInfo, Stabilizer, TelemetrySeries, type OrientationData } from '@ace/telemetry';
import { ace, baseName, ipcReader } from './api';
import { measureBrowser, mediaColor, type MediaColor } from './color';

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
  /** Regular clips: the lens they were shot through (so they can be reframed). Null for 360. */
  lens: SourceLens | null;
  /** What the camera recorded about itself and the shot. */
  camera: CameraInfo;
  /** Quarter turns clockwise to show the stored picture upright. */
  turns: number;
  /** What its recorded values mean (known once a frame has been decoded). */
  color?: MediaColor;
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
  /** The files it is made of (one, unless the camera split a long recording). */
  parts: { path: string; startUs: number }[];
  /** Something to know about those files (a part missing, or one that doesn't belong). */
  partsNote?: string;
}

export interface Music {
  path: string;
  name: string;
  durationUs: number;
  sound: Sound;
}

/** Something that can be heard: decoded a block at a time, so long recordings don't fill the memory. */
export interface Sound {
  seconds: number;
  /** Length of a block. Blocks run on a little into the next one, to fade between. */
  blockS: number;
  ready(i: number): AudioBuffer | null | undefined;
  fetch(i: number): Promise<AudioBuffer | null>;
}

const media = new Map<string, Promise<Media>>();
const sounds = new Map<string, Sound | null>();
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

/**
 * What to import for the files the user picked: each recording once, by its first file, however
 * many of its chapters were picked.
 */
export async function wholeRecordings(picked: string[]): Promise<string[]> {
  const out: string[] = [], covered = new Set<string>();
  for (const p of picked) {
    if (covered.has(p)) continue;
    let head = p;
    const run = await ace.chapters(p).catch(() => []);
    if (run.length < 2) { if (!out.includes(p)) out.push(p); continue; }
    const mine = run.findIndex((c) => c.path === p);
    // The earliest file from which every part up to this one follows on.
    let k = mine;
    while (k > 0 && run[k - 1]!.part === run[k]!.part - 1) k--;
    for (; k < mine; k++) {
      const m = await getMedia(run[k]!.path).catch(() => null);
      if (m?.parts.some((x) => x.path === p)) { head = run[k]!.path; break; }
    }
    if (!out.includes(head)) out.push(head);
    if (mine >= 0) (await getMedia(head).catch(() => null))?.parts.forEach((x) => covered.add(x.path));
  }
  return out;
}

/** Already-loaded media (or undefined), for hot paths that cannot await. */
const ready = new Map<string, Media>();
export const mediaNow = (path: string) => ready.get(path);

async function loadMedia(path: string): Promise<Media> {
  const open = async (p: string) => {
    const r = ipcReader(p, (await ace.stat(p)).size);
    return { path: p, reader: r, info: await openMedia(r) };
  };
  // A long recording is split into several files by the camera: read them as one.
  const files = [await open(path)];
  let partsNote: string | undefined;
  const chapters = await ace.chapters(path).catch(() => []);
  const mine = chapters.findIndex((c) => c.path === path);
  if (mine > 0 && chapters[mine - 1]!.part !== chapters[mine]!.part - 1) partsNote = `Part ${chapters[mine]!.part - 1} of this recording isn’t in the folder.`;
  else if (mine === 0 && chapters[0]!.part > 1) partsNote = `The recording’s first part isn’t in the folder.`;
  for (let i = mine + 1; mine >= 0 && i < chapters.length; i++) {
    const c = chapters[i]!;
    if (c.part !== chapters[i - 1]!.part + 1) { partsNote = `Part ${chapters[i - 1]!.part + 1} isn’t in the folder, so the parts after it are kept separate.`; break; }
    const next = await open(c.path).catch(() => null);
    const before = files.slice(0, -1).reduce((x, f) => x + videoEnd(f.info), 0);
    const why = next ? cannotFollow(files[0]!.info, files[files.length - 1]!.info, next.info, before) : 'it can’t be opened';
    if (!next || why) { partsNote = `${baseName(c.path)} wasn’t joined: ${why}.`; break; }
    files.push(next);
  }
  const { reader, info, starts } = files.length > 1 ? joinMedia(files) : { ...files[0]!, starts: [0] };
  const size = reader.size;
  const pair = find360Pair(info);
  const tracks = pair ?? info.videoTracks.slice(0, 1);
  // A stitched 360 video (from GoPro's cloud or other software): tagged, or GoPro's 360 name and shape.
  const one = tracks[0];
  const stitched = !pair && !!one && (await isEquirect(files[0]!.reader).catch(() => false) || (one.width === 2 * one.height && /^GS\w{2}\d{4}/i.test(baseName(path))));
  if (!tracks.length) throw new Error(`${baseName(path)}: no video track`);
  const support = await Promise.all(tracks.map(probeDecoder));
  const bad = support.find((s) => !s.supported);
  if (bad) throw new Error(`${baseName(path)}: this computer cannot decode ${bad.codec}`);

  let orientation: OrientationData | null = null;
  let telemetryError: string | undefined;
  if (info.gpmfTrack) {
    try {
      const pieces = [];
      for (const [i, f] of files.entries()) {
        if (!f.info.gpmfTrack) continue;
        const raw = await ace.orientation(f.path, {
          samples: f.info.gpmfTrack.samples.map(({ offset, size, timestamp, duration }) => ({ offset, size, timestamp, duration })),
          durationUs: f.info.durationUs,
          created: f.info.created?.toISOString(),
          // Regular clips need the fast gyro to undo rolling shutter.
          gyro: !pair && !stitched,
        });
        // (Each file's data lines up with its own frames.)
        const video = (pair ? find360Pair(f.info)![0] : f.info.videoTracks[0]!);
        pieces.push({ data: alignToFrames(raw, video.samples.map((s) => s.timestamp).sort((a, b) => a - b)), startUs: starts[i]! });
      }
      const all = pieces.length === 1 && !pieces[0]!.startUs ? pieces[0]!.data : joinOrientation(pieces);
      orientation = { ...all, grav: smoothGravity(all.grav) };
    } catch (e) {
      telemetryError = String(e);
    }
  }

  const t0 = tracks[0]!;
  let camera: CameraInfo = {};
  try {
    const block = await readUserData(files[0]!.reader);
    if (block) camera = cameraInfo(parseKlv(block));
  } catch {
    /* no settings block: nothing is known about the camera */
  }
  const turns = pair || stitched ? 0 : t0.turns;
  const [width, height] = turns % 2 ? [t0.height, t0.width] : [t0.width, t0.height];
  const durationUs = Math.min(...tracks.map((t) => t.samples.reduce((m, s) => Math.max(m, s.timestamp + s.duration), 0)));
  const m: Media = {
    path,
    name: baseName(path),
    size,
    reader,
    info,
    is360: !!pair || stitched,
    tracks,
    layout: pair ? goproMaxLayout(pair[0].width, pair[0].height) : stitched ? equirectLayout(t0.width, t0.height) : null,
    lens: pair || stitched ? null : lensFor(camera, width, height),
    camera,
    turns,
    stabilizer: new Stabilizer(orientation),
    telemetry: new TelemetrySeries(orientation?.gps, orientation?.accl),
    support,
    durationUs,
    fps: t0.fps,
    width,
    height,
    telemetryError,
    parts: files.map((f, i) => ({ path: f.path, startUs: starts[i]! })),
    partsNote,
  };
  // (What this computer does to video is measured once, before the first clip is shown.)
  await measureBrowser();
  m.thumbnail = await makeThumbnail(m, (f) => { m.color = mediaColor(f, t0); }).catch(() => undefined);
  ready.set(path, m);
  return m;
}

/** Decodes the first keyframe and draws a small preview (front face for 360). */
async function makeThumbnail(m: Pick<Media, 'tracks' | 'reader' | 'layout' | 'turns'>, seen?: (f: VideoFrame) => void): Promise<string> {
  const track = m.tracks[0]!;
  const first = track.samples.find((s) => s.isSync)!;
  const data = await m.reader.read(first.offset, first.size);
  const frame = await new Promise<VideoFrame>((resolve, reject) => {
    const dec = new VideoDecoder({ output: (f) => { resolve(f); dec.close(); }, error: reject });
    dec.configure(decoderConfig(track));
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: first.timestamp, data }));
    void dec.flush().catch(() => {});
  });
  seen?.(frame);
  const W = 192, H = 108;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d')!;
  if (m.layout?.equirect) {
    // The middle: straight ahead.
    const sw = frame.displayWidth * 0.36, sh = sw * (9 / 16);
    ctx.drawImage(frame, (frame.displayWidth - sw) / 2, (frame.displayHeight - sh) / 2, sw, sh, 0, 0, W, H);
  } else if (m.layout) {
    const front = m.layout.tiles.find((t) => t.face === 'front')!;
    // Middle band of the front face, 16:9.
    const sh = front.size * (9 / 16);
    ctx.drawImage(frame, front.x, front.y + (front.size - sh) / 2, front.size, sh, 0, 0, W, H);
  } else {
    const sw = frame.displayWidth, sh = frame.displayHeight;
    const scale = m.turns % 2 ? Math.max(W / sh, H / sw) : Math.max(W / sw, H / sh);
    ctx.translate(W / 2, H / 2);
    ctx.rotate((m.turns * Math.PI) / 2);
    ctx.drawImage(frame, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
  }
  frame.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return URL.createObjectURL(blob);
}

/** A small preview of a file that isn't being opened for editing (on a memory card). */
export async function fileThumbnail(path: string): Promise<string> {
  try {
    const reader = ipcReader(path, (await ace.stat(path)).size);
    const info = await openMedia(reader);
    const pair = find360Pair(info), tracks = pair ?? info.videoTracks.slice(0, 1);
    const t0 = tracks[0]!;
    const stitched = !pair && t0.width === 2 * t0.height && /^GS\w{2}\d{4}/i.test(baseName(path));
    return await makeThumbnail({ reader, tracks, turns: pair ? 0 : t0.turns, layout: pair ? goproMaxLayout(t0.width, t0.height) : stitched ? equirectLayout(t0.width, t0.height) : null });
  } finally {
    await ace.release(path);
  }
}

const BLOCK_S = 20;
/** How far a block runs on into the next (s). */
export const BLOCK_PAD_S = 0.03;
/** Decoded blocks kept per clip. */
const KEEP_BLOCKS = 10;

class ClipSound implements Sound {
  readonly blockS = BLOCK_S;
  readonly seconds: number;
  private blocks = new Map<number, AudioBuffer | null>();
  private loading = new Map<number, Promise<AudioBuffer | null>>();
  constructor(private reader: ByteReader, private track: AudioTrackInfo) {
    this.seconds = audioEnd(track) / 1e6;
  }
  ready(i: number) {
    const b = this.blocks.get(i);
    // (Most recently used last.)
    if (b !== undefined) { this.blocks.delete(i); this.blocks.set(i, b); }
    return b;
  }
  fetch(i: number): Promise<AudioBuffer | null> {
    const b = this.ready(i);
    if (b !== undefined) return Promise.resolve(b);
    let p = this.loading.get(i);
    if (!p) {
      p = this.decode(i).catch(() => null).then((x) => {
        this.loading.delete(i);
        this.blocks.set(i, x);
        for (const k of this.blocks.keys()) { if (this.blocks.size <= KEEP_BLOCKS) break; this.blocks.delete(k); }
        return x;
      });
      this.loading.set(i, p);
    }
    return p;
  }
  private async decode(i: number): Promise<AudioBuffer | null> {
    const pcm = await decodeAudioRange(this.reader, this.track, i * BLOCK_S * 1e6, Math.min(this.seconds, (i + 1) * BLOCK_S + BLOCK_PAD_S) * 1e6);
    if (!pcm?.channels[0]?.length) return null;
    const [l, r] = toStereo(pcm);
    const buf = audioCtx().createBuffer(2, l.length, pcm.sampleRate);
    buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
    return buf;
  }
}

/** The clip's own sound, or null when it has none. */
export function clipSound(m: Media): Sound | null {
  let s = sounds.get(m.path);
  if (s === undefined) {
    const track = m.info.audioTracks[0];
    sounds.set(m.path, (s = track?.samples.length ? new ClipSound(m.reader, track) : null));
  }
  return s;
}
/** A sound decoded all at once (music). */
const wholeSound = (buffer: AudioBuffer): Sound => ({ seconds: buffer.duration, blockS: Infinity, ready: () => buffer, fetch: () => Promise.resolve(buffer) });

const VIDEO_RE = /\.(360|mp4|mov|lrv|m4v)$/i;

export function getMusic(path: string): Promise<Music> {
  let p = music.get(path);
  if (!p) {
    p = (async () => {
      // A video's own sound (detached onto the audio track).
      if (VIDEO_RE.test(path)) {
        const m = await getMedia(path);
        const sound = clipSound(m);
        if (!sound || !(await sound.fetch(0))) throw new Error('This video has no sound');
        return { path, name: baseName(path), durationUs: Math.round(sound.seconds * 1e6), sound };
      }
      const bytes = await ace.readAll(path);
      const buffer = await audioCtx().decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      return { path, name: baseName(path), durationUs: Math.round(buffer.duration * 1e6), sound: wholeSound(buffer) };
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

/**
 * Why a file can't be opened, in words a rider understands (the raw error is for the log).
 * Looks at the file itself: empty, cut off while recording, sound only, or not a video at all.
 */
export async function whyCannotOpen(path: string, e: unknown): Promise<string> {
  const raw = String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, '');
  if (/no video track/.test(raw)) return 'This file has sound only. To use it, choose Add Music.';
  const codec = raw.match(/cannot decode (\S+)/)?.[1];
  if (codec) return `This computer can’t play this kind of video (${codec}).`;
  try {
    const { size } = await ace.stat(path);
    if (!size) return 'The file is empty (0 bytes): the copy probably didn’t finish. Copy it from the card again.';
    const head = await ace.read(path, 0, Math.min(size, 64));
    const tag = new TextDecoder('latin1').decode(head.slice(4, 8));
    if (tag === 'ftyp' && /moov|movie header/i.test(raw)) {
      return 'This recording wasn’t finished: the camera stopped before saving it (a flat battery, or the card taken out while recording). Put the card back in the camera and switch it on — GoPro cameras repair such files by themselves — then import it again.';
    }
    if (!['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(tag)) return 'This isn’t a video the app can open.';
  } catch { /* can't look inside: say what happened */ }
  return `It can’t be opened: ${raw}`;
}

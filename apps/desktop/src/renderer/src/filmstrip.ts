// Pictures along each clip on the timeline: the keyframe nearest each spot, framed the way the
// preview frames it. Made in the background, one at a time, and never while playing.

import { useSyncExternalStore } from 'react';
import { decoderConfig, type VideoTrackInfo } from '@ace/engine';
import { ReframeRenderer } from '@ace/media360';
import { DEFAULT_LOOK, NO_EFFECTS, type TimelineClip } from '@ace/project';
import { clipLookAt, presentLook, pushClipFrame, reframeSignature } from './frameRender';
import type { Media } from './media';
import { previewSource } from './proxy';

export const STRIP_W = 160, STRIP_H = 90;

const pictures = new Map<string, string>();
const wanted = new Map<string, { clip: TimelineClip; media: Media; key: number; near: number }>();
let version = 0, busy = false, paused = false, renderer: Promise<ReframeRenderer> | null = null;
const subs = new Set<() => void>();
const changed = () => { version++; subs.forEach((f) => f()); };
export const useFilmstrip = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);

/** While playing nothing is made (decoding must go to playback). */
export function pauseFilmstrip(p: boolean) {
  if (p === paused) return;
  paused = p;
  if (!p) void work();
}

const keyframes = new WeakMap<VideoTrackInfo, number[]>();
/** Presentation time of the keyframe at or before a media time. */
export function keyframeAt(track: VideoTrackInfo, us: number): number {
  let k = keyframes.get(track);
  if (!k) keyframes.set(track, (k = track.samples.filter((s) => s.isSync).map((s) => s.timestamp).sort((a, b) => a - b)));
  let lo = 0, hi = k.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (k[m]! <= us) lo = m; else hi = m - 1; }
  return k[lo] ?? 0;
}

const pictureKey = (clip: TimelineClip, media: Media, key: number) => {
  const look = clipLookAt(clip, key);
  return `${media.path}|${previewSource(media).level}|${key}|${reframeSignature(clip, look, 'strip')}`;
};

/**
 * The picture for a spot of a clip (media time), or null while it is being made. `near` orders
 * the work: smaller is sooner.
 */
export function stripPicture(clip: TimelineClip, media: Media, mediaUs: number, near: number): { url: string | null; key: number } {
  const key = keyframeAt(previewSource(media).tracks[0]!, mediaUs);
  const k = pictureKey(clip, media, key);
  const url = pictures.get(k) ?? null;
  if (!url) {
    const w = wanted.get(k);
    if (!w || near < w.near) wanted.set(k, { clip, media, key, near });
    if (!busy) queueMicrotask(() => void work());
  }
  return { url, key };
}

async function decodeKey(track: VideoTrackInfo, reader: ReturnType<typeof previewSource>['reader'], at: number): Promise<VideoFrame> {
  const s = track.samples.find((x) => x.isSync && x.timestamp === at) ?? track.samples.find((x) => x.isSync)!;
  const data = await reader.read(s.offset, s.size);
  return new Promise<VideoFrame>((resolve, reject) => {
    const d = new VideoDecoder({ output: (f) => { resolve(f); }, error: reject });
    d.configure(decoderConfig(track));
    d.decode(new EncodedVideoChunk({ type: 'key', timestamp: s.timestamp, duration: s.duration, data }));
    void d.flush().then(() => d.close(), reject);
  });
}

async function work() {
  if (busy || paused) return;
  busy = true;
  try {
    renderer ??= ReframeRenderer.create(new OffscreenCanvas(STRIP_W, STRIP_H));
    const r = await renderer;
    while (wanted.size && !paused) {
      let pick: [string, { clip: TimelineClip; media: Media; key: number; near: number }] | null = null;
      for (const e of wanted) if (!pick || e[1].near < pick[1].near) pick = e;
      const [k, w] = pick!;
      wanted.delete(k);
      if (pictures.has(k)) continue;
      const src = previewSource(w.media);
      const frames = await Promise.all(src.tracks.map((t) => decodeKey(t, src.reader, keyframeAt(src.tracks[0]!, w.key)))).catch(() => null);
      if (!frames) continue;
      try {
        r.setLayout(src.layout);
        r.resetHistory();
        const look = pushClipFrame(r, w.clip, w.media, frames[0]!.timestamp, frames);
        presentLook(r, { ...look, motionBlur: 0, fx: { ...NO_EFFECTS, bars: look.fx?.bars ?? DEFAULT_LOOK.fx.bars } });
        const blob = await (r.canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.75 });
        pictures.set(k, URL.createObjectURL(blob));
        // (Old pictures of edited clips are let go, keeping the last few hundred.)
        if (pictures.size > 600) for (const [old, url] of pictures) { if (pictures.size <= 500) break; URL.revokeObjectURL(url); pictures.delete(old); }
        changed();
      } finally {
        frames.forEach((f) => f.close());
      }
      // A breath between pictures, so the interface never waits on this.
      await new Promise((res) => setTimeout(res, 4));
    }
  } finally {
    busy = false;
  }
}

/** For tests: how many are waiting to be made. */
export const filmstripPending = () => wanted.size + (busy ? 1 : 0);

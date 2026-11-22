// Runs layout calibration on a few moments of a 360 file (used by the self-test).

import { TrackDecoder } from '@ace/engine';
import { calibrateLayout, type CalibrationResult, type RGBAImage } from '@ace/media360';
import type { Media } from './media';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function toRGBA(frame: VideoFrame): RGBAImage {
  const c = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(frame, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** Decodes the frame at `us` from every stream of the media. */
export async function framesAt(media: Media, us: number): Promise<{ frames: VideoFrame[]; close: () => void }> {
  const decs = media.tracks.map((t) => new TrackDecoder(media.reader, t));
  decs.forEach((d) => d.seek(us));
  const deadline = performance.now() + 15_000;
  for (;;) {
    for (const d of decs) void d.pump();
    const fr = decs.map((d) => d.frameAt(us));
    if (fr.every(Boolean)) return { frames: fr as VideoFrame[], close: () => decs.forEach((d) => d.close()) };
    if (performance.now() > deadline) {
      decs.forEach((d) => d.close());
      throw new Error('Timed out waiting for frames');
    }
    await sleep(5);
  }
}

export async function calibrateMedia(media: Media, count = 4): Promise<CalibrationResult> {
  if (!media.layout) throw new Error('Not a 360 file');
  const samples: [RGBAImage, RGBAImage][] = [];
  for (let i = 0; i < count; i++) {
    const { frames, close } = await framesAt(media, (media.durationUs * (i + 0.5)) / count);
    samples.push(frames.map(toRGBA) as [RGBAImage, RGBAImage]);
    close();
  }
  return calibrateLayout(media.layout, samples);
}

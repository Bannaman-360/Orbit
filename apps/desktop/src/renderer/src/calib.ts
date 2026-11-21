// Runs layout calibration on a few moments of the open 360 file.

import { calibrateLayout, type CalibrationResult, type RGBAImage } from '@ace/media360';
import type { Session } from './session';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRGBA(frame: VideoFrame): RGBAImage {
  const c = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(frame, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** Seeks to each time, waits for both streams to decode, and grabs RGBA copies. */
async function grab(session: Session, us: number): Promise<[RGBAImage, RGBAImage]> {
  const p = session.player;
  const wasPlaying = p.playing;
  p.pause();
  p.seek(us);
  const deadline = performance.now() + 10_000;
  for (;;) {
    for (const d of p.decoders) void d.pump();
    const frames = p.decoders.map((d) => d.frameAt(p.time));
    if (frames.every((f) => f)) {
      const out = frames.map((f) => toRGBA(f!)) as [RGBAImage, RGBAImage];
      if (wasPlaying) p.play();
      return out;
    }
    if (performance.now() > deadline) throw new Error('Timed out waiting for frames');
    await sleep(16);
  }
}

/** Samples `count` moments spread across the clip. */
export async function calibrateSession(session: Session, count = 4): Promise<CalibrationResult> {
  if (!session.layout) throw new Error('Not a 360 file');
  const frames: [RGBAImage, RGBAImage][] = [];
  const dur = session.player.durationUs;
  for (let i = 0; i < count; i++) frames.push(await grab(session, (dur * (i + 0.5)) / count));
  return calibrateLayout(session.layout, frames);
}

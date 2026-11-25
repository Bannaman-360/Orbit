import { describe, expect, it } from 'vitest';
import { addMulticam, envelopeOffset, switchAngle } from './multicam';
import { emptyTimeline, loadTimeline, splitAt } from './timeline';

const S = 1e6;
/** A made-up loudness envelope with bangs at random moments. */
function envelope(len: number, seed: number): Float32Array {
  let x = seed;
  const r = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const e = new Float32Array(len);
  let level = 0;
  for (let i = 0; i < len; i++) { level *= 0.9; if (r() < 0.03) level += 1 + r() * 3; e[i] = level + r() * 0.2; }
  return e;
}

describe('multicam', () => {
  it('finds how much later a second camera started from the sound', () => {
    const world = envelope(6000, 7);
    const a = world.slice(0, 4000), b = world.slice(1234, 5000).map((v, i) => v * 0.4 + (i % 7) * 0.01);
    const r = envelopeOffset(a, new Float32Array(b));
    expect(r.lag).toBe(1234);
    expect(r.confidence).toBeGreaterThan(4);
    // And the other way round.
    expect(envelopeOffset(new Float32Array(b), a).lag).toBe(-1234);
  });
  it('cuts between angles keep the moment', () => {
    const angles = [{ path: 'a.mp4', offsetUs: 0, durationUs: 60 * S }, { path: 'b.mp4', offsetUs: 5 * S, durationUs: 60 * S }];
    const r = addMulticam(emptyTimeline(), angles, 'Ride');
    let tl = splitAt(r.tl, 20 * S);
    const right = tl.clips[1]!;
    tl = switchAngle(tl, right.id, 1);
    expect(tl.clips[1]!.mediaPath).toBe('b.mp4');
    expect(tl.clips[1]!.inUs).toBe(15 * S);
    // Angle b wasn't recording during the first 5 s: the first clip can't switch.
    expect(switchAngle(tl, tl.clips[0]!.id, 1)).toBe(tl);
    expect(loadTimeline(JSON.parse(JSON.stringify(tl))).multicams?.[0]?.angles.length).toBe(2);
  });
});

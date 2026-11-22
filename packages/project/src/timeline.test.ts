import { describe, expect, it } from 'vitest';
import {
  addClip, audioSpan, clipStarts, duplicateClip, emptyTimeline, loadTimeline, locate, moveClip, newAudioClip, newClip,
  removeClip, splitAt, timelineDuration, trimClip, updateClip,
} from './timeline';

const S = 1_000_000;
const two = () => {
  let tl = emptyTimeline();
  tl = addClip(tl, newClip('/a.360', 10 * S, true));
  tl = addClip(tl, newClip('/b.mp4', 6 * S, false));
  return tl;
};

describe('timeline', () => {
  it('lays clips end to end', () => {
    const tl = two();
    expect(clipStarts(tl)).toEqual([0, 10 * S]);
    expect(timelineDuration(tl)).toBe(16 * S);
    expect(locate(tl, 12 * S)).toMatchObject({ index: 1, mediaUs: 2 * S, startUs: 10 * S });
  });

  it('accounts for speed', () => {
    let tl = two();
    tl = updateClip(tl, tl.clips[0]!.id, { speed: 2 });
    expect(timelineDuration(tl)).toBe(11 * S);
    expect(locate(tl, 2 * S)!.mediaUs).toBe(4 * S);
  });

  it('splits at the playhead into two clips of the same source', () => {
    const tl = splitAt(two(), 4 * S);
    expect(tl.clips).toHaveLength(3);
    expect(tl.clips.slice(0, 2).map((c) => [c.inUs, c.outUs])).toEqual([[0, 4 * S], [4 * S, 10 * S]]);
    expect(timelineDuration(tl)).toBe(16 * S);
  });

  it('trims, removes, reorders and duplicates', () => {
    let tl = two();
    const [a, b] = tl.clips;
    tl = trimClip(tl, a!.id, 2 * S, 7 * S, 10 * S);
    expect(timelineDuration(tl)).toBe(11 * S);
    tl = moveClip(tl, b!.id, 0);
    expect(tl.clips[0]!.id).toBe(b!.id);
    tl = duplicateClip(tl, b!.id);
    expect(tl.clips).toHaveLength(3);
    tl = removeClip(tl, a!.id);
    expect(tl.clips.map((c) => c.mediaPath)).toEqual(['/b.mp4', '/b.mp4']);
  });

  it('keeps trims inside the source', () => {
    const tl = trimClip(two(), two().clips[0]!.id, -5, 99 * S, 10 * S);
    const t = trimClip(tl, tl.clips[0]!.id, -5, 99 * S, 10 * S);
    expect([t.clips[0]!.inUs, t.clips[0]!.outUs]).toEqual([0, 10 * S]);
  });

  it('cuts music at the end of the video', () => {
    const tl = two();
    const a = newAudioClip('/song.mp3', 200 * S, 3 * S);
    expect(audioSpan(tl, a)).toEqual({ start: 3 * S, end: 16 * S });
  });

  it('repairs partial saves', () => {
    const tl = loadTimeline({ clips: [{ mediaPath: '/x.360', inUs: 0, outUs: 5 * S, look: { yaw: 3 } }] });
    expect(tl.clips[0]!.look.yaw).toBe(3);
    expect(tl.clips[0]!.look.grade.exposure).toBe(0);
    expect(tl.clips[0]!.speed).toBe(1);
    expect(tl.framing).toBe('16:9');
  });
});

import { describe, expect, it } from 'vitest';
import { addClip, clipStarts, emptyTimeline, insertClipAt, newClip, overwriteClipAt, rollCut, slideClip, slipClip, timelineDuration, type Timeline } from './timeline';

const S = 1e6;
const dur = () => 20 * S;
/** Three 4 s pieces from the middle of 20 s files, with 2 s spare either side. */
function three(): Timeline {
  let tl = emptyTimeline();
  for (const n of ['a', 'b', 'c']) tl = addClip(tl, { ...newClip(`/${n}.mp4`, 20 * S, false), id: n, inUs: 2 * S, outUs: 6 * S });
  return tl;
}
const ins = (tl: Timeline) => tl.clips.map((c) => [c.inUs / S, c.outUs / S]);

describe('roll', () => {
  it('moves a cut, keeping the edit’s length', () => {
    const { tl, moved } = rollCut(three(), 'a', 1 * S, dur);
    expect(moved).toBe(1 * S);
    expect(ins(tl)).toEqual([[2, 7], [3, 6], [2, 6]]);
    expect(timelineDuration(tl)).toBe(12 * S);
  });
  it('stops where the next clip runs out of media before its in point', () => {
    const { tl, moved } = rollCut(three(), 'a', -5 * S, dur);
    // Clip b has 2 s before its in point.
    expect(moved).toBe(-2 * S);
    expect(ins(tl)[1]).toEqual([0, 6]);
  });
  it('never makes a clip shorter than the minimum', () => {
    const { tl } = rollCut(three(), 'a', 10 * S, dur);
    expect(tl.clips[1]!.outUs - tl.clips[1]!.inUs).toBeGreaterThanOrEqual(0.1 * S - 1);
  });
});

describe('slip', () => {
  it('shows another part of the clip, same place and length', () => {
    const tl = slipClip(three(), 'b', 1.5 * S, dur);
    expect(ins(tl)[1]).toEqual([3.5, 7.5]);
    expect(clipStarts(tl)).toEqual(clipStarts(three()));
  });
  it('stops at the start and end of the file', () => {
    expect(ins(slipClip(three(), 'b', -9 * S, dur))[1]).toEqual([0, 4]);
    expect(ins(slipClip(three(), 'b', 99 * S, dur))[1]).toEqual([16, 20]);
  });
  it('keeps a speed ramp in the same place in the clip', () => {
    let tl = three();
    tl = { ...tl, clips: tl.clips.map((c) => (c.id === 'b' ? { ...c, speedKeys: [{ id: 'k', t: 3 * S, speed: 0.5, ease: 'smooth' as const }] } : c)) };
    const before = timelineDuration(tl);
    const after = slipClip(tl, 'b', 1 * S, dur);
    expect(after.clips[1]!.speedKeys![0]!.t).toBe(4 * S);
    expect(Math.abs(timelineDuration(after) - before)).toBeLessThan(2);
  });
});

describe('slide', () => {
  it('moves a clip along, the neighbours give and take', () => {
    const tl = slideClip(three(), 'b', 1 * S, dur);
    expect(ins(tl)).toEqual([[2, 7], [2, 6], [3, 6]]);
    expect(clipStarts(tl)[1]).toBe(5 * S);
    expect(timelineDuration(tl)).toBe(12 * S);
  });
  it('stops when a neighbour runs out', () => {
    const tl = slideClip(three(), 'b', -9 * S, dur);
    // The first clip can shrink to the minimum; the last has 2 s before its in point.
    expect(ins(tl)[2]).toEqual([0, 6]);
    expect(ins(tl)[0]).toEqual([2, 4]);
    expect(timelineDuration(tl)).toBe(12 * S);
  });
  it('the first clip has nothing before it to slide into', () => {
    expect(ins(slideClip(three(), 'a', 1 * S, dur))).toEqual(ins(three()));
  });
});

describe('three-point editing', () => {
  const piece = (id: string, inS: number, outS: number) => ({ ...newClip('/src.mp4', 20 * S, false), id, inUs: inS * S, outUs: outS * S });
  it('inserts at the playhead, cutting the clip there, everything after moves later', () => {
    let tl = three();
    tl = { ...tl, markers: [{ id: 'm', t: 9 * S, note: '', color: 'blue' }] };
    const out = insertClipAt(tl, piece('n', 10, 13), 5 * S);
    expect(out.clips.map((c) => c.id.length === 1 ? c.id : 'b2')).toEqual(['a', 'b', 'n', 'b2', 'c']);
    expect(timelineDuration(out)).toBe(15 * S);
    expect(clipStarts(out)[2]).toBe(5 * S);
    expect(out.markers[0]!.t).toBe(12 * S);
  });
  it('inserts at a cut without cutting anything, or at the end', () => {
    expect(insertClipAt(three(), piece('n', 0, 1), 4 * S).clips.map((c) => c.id)).toEqual(['a', 'n', 'b', 'c']);
    expect(insertClipAt(three(), piece('n', 0, 1), 99 * S).clips.map((c) => c.id)).toEqual(['a', 'b', 'c', 'n']);
  });
  it('overwrites what is there, keeping the edit’s length', () => {
    const out = overwriteClipAt(three(), piece('n', 10, 15), 2 * S);
    // a keeps 0–2 s, n covers 2–7 s, c's… b loses its first 3 s.
    expect(timelineDuration(out)).toBe(12 * S);
    expect(out.clips.map((c) => c.id.length === 1 ? c.id : 'x')).toEqual(['a', 'n', 'x', 'c']);
    expect(clipStarts(out)[1]).toBe(2 * S);
    expect(out.clips[2]!.inUs).toBe(5 * S);
  });
});

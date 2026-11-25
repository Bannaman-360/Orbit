import { describe, expect, it } from 'vitest';
import { breakApart, flattenTimeline, isCompound, makeCompound, sequenceTimeline, storeSequence } from './compound';
import { placeConnected, stackAt } from './layers';
import { newGaugeOverlay } from './overlays';
import { addClip, clipStarts, emptyTimeline, loadTimeline, locate, newClip, splitAt, timelineDuration, type Timeline } from './timeline';

const S = 1e6;
const three = (): Timeline => {
  let tl = emptyTimeline();
  for (const n of ['a', 'b', 'c']) tl = addClip(tl, { ...newClip(`${n}.mp4`, 10 * S, false), id: n });
  return tl;
};
const pic = (tl: Timeline, T: number) => { const l = locate(tl, T)!; return `${l.clip.mediaPath}@${Math.round(l.mediaUs / 1000)}`; };

describe('compound clips', () => {
  it('nests clips into one clip that plays the same pictures', () => {
    const tl = three();
    const r = makeCompound(tl, 1, 2)!;
    expect(r.tl.clips.length).toBe(2);
    expect(isCompound(r.tl.clips[1]!)).toBe(true);
    expect(timelineDuration(r.tl)).toBe(30 * S);
    const flat = flattenTimeline(r.tl);
    for (const T of [1, 12, 19.9, 25, 29.9].map((x) => x * S)) expect(pic(flat, T)).toBe(pic(tl, T));
  });
  it('brings the layers over the nested clips, and plays a trimmed or split compound right', () => {
    let tl = three();
    tl = placeConnected(tl, { ...newClip('over.mp4', 5 * S, false), id: 'v1' }, 12 * S)!.tl;
    tl = { ...tl, overlays: [{ ...newGaugeOverlay('speed', 11 * S, 13 * S), id: 'g' }] };
    const r = makeCompound(tl, 1, 1)!;
    expect(r.tl.connected.length).toBe(0);
    expect(r.tl.overlays.length).toBe(0);
    const flat = flattenTimeline(r.tl);
    expect(stackAt(flat, 14 * S)!.layers.map((l) => l.clip.mediaPath)).toEqual(['b.mp4', 'over.mp4']);
    expect(flat.overlays.length).toBe(1);
    // Trim 2 s off the compound's start: it shows the sequence from 2 s.
    const trimmed = { ...r.tl, clips: r.tl.clips.map((c) => (isCompound(c) ? { ...c, inUs: 2 * S } : c)) };
    expect(pic(flattenTimeline(trimmed), 10 * S + 1)).toBe(pic(tl, 12 * S + 1));
    const split = splitAt(r.tl, 15 * S);
    expect(split.clips.length).toBe(4);
    for (const T of [11, 14.9, 15.1, 19].map((x) => x * S)) expect(pic(flattenTimeline(split), T)).toBe(pic(tl, T));
  });
  it('edits inside come back out, and the project keeps the sequence', () => {
    const r = makeCompound(three(), 0, 1)!;
    const seq = r.tl.sequences![0]!;
    const inner = sequenceTimeline(r.tl, seq);
    const shorter = { ...inner, clips: inner.clips.slice(0, 1) };
    const back = storeSequence(r.tl, seq.id, shorter);
    expect(timelineDuration(back)).toBe(20 * S);
    const saved = loadTimeline(JSON.parse(JSON.stringify(back)));
    expect(saved.sequences?.[0]?.clips.length).toBe(1);
    expect(pic(flattenTimeline(saved), 15 * S)).toBe('c.mp4@5000');
  });
  it('breaks apart into its clips', () => {
    const tl = three(), r = makeCompound(tl, 0, 2)!;
    const apart = breakApart(r.tl, r.id);
    expect(apart.clips.map((c) => c.mediaPath)).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
    expect(clipStarts(apart)).toEqual(clipStarts(tl));
  });
  it('nests a compound inside a compound', () => {
    const r1 = makeCompound(three(), 0, 1)!;
    const r2 = makeCompound(r1.tl, 0, 1)!;
    expect(r2.tl.clips.length).toBe(1);
    expect(pic(flattenTimeline(r2.tl), 25 * S)).toBe('c.mp4@5000');
  });
});

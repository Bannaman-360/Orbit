import { describe, expect, it } from 'vitest';
import { newTextOverlay, overlayState, transitionLook } from './overlays';
import {
  addClip, assignLanes, audioSpan, clipStarts, detachAudio, emptyTimeline, layersAt, loadTimeline, locate, newClip, reattachAudio,
  timelineDuration, TRANSITIONS, transitionUs, updateClip,
} from './timeline';

const S = 1_000_000;
const two = (transitionS = 1) => {
  let tl = emptyTimeline();
  tl = addClip(tl, newClip('/a.360', 10 * S, true));
  tl = addClip(tl, newClip('/b.mp4', 6 * S, false));
  return updateClip(tl, tl.clips[1]!.id, { transitionIn: { kind: 'crossfade', durationUs: transitionS * S } });
};

describe('transitions', () => {
  it('overlap the clips and shorten the edit', () => {
    const tl = two(1);
    expect(clipStarts(tl)).toEqual([0, 9 * S]);
    expect(timelineDuration(tl)).toBe(15 * S);
  });

  it('show both clips during the overlap with progress 0 → 1', () => {
    const tl = two(1);
    expect(layersAt(tl, 8.5 * S)!.b).toBeUndefined();
    const mid = layersAt(tl, 9.5 * S)!;
    expect(mid.a.index).toBe(0);
    expect(mid.a.mediaUs).toBe(9.5 * S);
    expect(mid.b!.index).toBe(1);
    expect(mid.b!.mediaUs).toBe(0.5 * S);
    expect(mid.progress).toBeCloseTo(0.5);
    const after = layersAt(tl, 10.5 * S)!;
    expect(after.a.index).toBe(1);
    expect(after.b).toBeUndefined();
    expect(locate(tl, 9.5 * S)!.index).toBe(0);
  });

  it('are limited to half of either clip', () => {
    const tl = two(20);
    expect(transitionUs(tl, 1)).toBe(3 * S);
    expect(transitionUs(tl, 0)).toBe(0);
  });

  it('look right at the start, middle and end', () => {
    expect(transitionLook('crossfade', 0).b.alpha).toBe(0);
    expect(transitionLook('crossfade', 1).b.alpha).toBe(1);
    const dip = transitionLook('dip-black', 0.5);
    expect(dip.dipAlpha).toBe(1);
    expect(dip.dip).toBe('#000000');
    expect(transitionLook('wipe-left', 1).reveal).toEqual({ kind: 'rect', r: [0, 0, 1, 1] });
    expect(transitionLook('slide-left', 1).a.dx).toBe(-1);
    expect(transitionLook('iris', 1).reveal).toEqual({ kind: 'circle', r: 1 });
    // Every transition ends with only the incoming clip fully visible and untransformed.
    for (const [k] of TRANSITIONS) {
      const end = transitionLook(k, 1);
      const near = (x: object, want: Record<string, number>) => Object.entries(want).forEach(([key, v]) => expect((x as Record<string, number>)[key], `${k}.${key}`).toBeCloseTo(v, 6));
      near(end.b, { alpha: 1, dx: 0, dy: 0, scale: 1, rotate: 0, blur: 0 });
      expect(end.dipAlpha).toBeCloseTo(0, 6);
      if (end.reveal?.kind === 'rect') expect(end.reveal.r).toEqual([0, 0, 1, 1]);
      // And starts with the outgoing clip untouched.
      const start = transitionLook(k, 0);
      near(start.a, { dx: 0, dy: 0, scale: 1, rotate: 0 });
      expect(start.dipAlpha).toBeCloseTo(0, 6);
    }
  });

  it('survive saving', () => {
    const tl = loadTimeline(JSON.parse(JSON.stringify(two(1))));
    expect(tl.clips[1]!.transitionIn).toEqual({ kind: 'crossfade', durationUs: S });
    expect(tl.overlays).toEqual([]);
  });
});

describe('detached audio', () => {
  it('moves a clip’s sound to the audio track and back', () => {
    let tl = emptyTimeline();
    tl = addClip(tl, newClip('/a.360', 10 * S, true));
    tl = addClip(tl, { ...newClip('/b.mp4', 6 * S, false), inUs: 1 * S, outUs: 5 * S, speed: 2 });
    const id = tl.clips[1]!.id;
    const d = detachAudio(tl, id);
    expect(d.clips[1]!.audioDetached).toBe(true);
    const a = d.audio[0]!;
    expect(a).toMatchObject({ path: '/b.mp4', startUs: 10 * S, inUs: 1 * S, outUs: 5 * S, speed: 2, linkedClipId: id });
    // At 2× the 4 s of media last 2 s on the timeline.
    expect(audioSpan(d, a)).toEqual({ start: 10 * S, end: 12 * S });
    const r = reattachAudio(d, id);
    expect(r.audio).toEqual([]);
    expect(r.clips[1]!.audioDetached).toBe(false);
  });
});

describe('lanes', () => {
  it('puts overlapping items on separate rows', () => {
    const items = [{ id: 'a', s: 0, e: 5 }, { id: 'b', s: 3, e: 8 }, { id: 'c', s: 6, e: 9 }];
    const lanes = assignLanes(items, (x) => ({ start: x.s, end: x.e }));
    expect([lanes.get('a'), lanes.get('b'), lanes.get('c')]).toEqual([0, 1, 0]);
  });
});

describe('overlay animation', () => {
  it('fades in and out and is hidden outside its time', () => {
    const o = newTextOverlay(1 * S, 5 * S);
    expect(overlayState(o, 0.5 * S)).toBeNull();
    expect(overlayState(o, 5 * S)).toBeNull();
    expect(overlayState(o, 1 * S)!.alpha).toBe(0);
    expect(overlayState(o, 3 * S)!.alpha).toBe(1);
    const tw = overlayState({ ...o, animation: 'typewriter' }, 1.5 * S)!;
    expect(tw.reveal).toBeGreaterThan(0);
    expect(tw.reveal).toBeLessThan(1);
  });
});

describe('delete left / right', () => {
  it('cuts the clip under the playhead and keeps the others', async () => {
    const { deleteSideAt } = await import('./timeline');
    let tl = emptyTimeline();
    tl = addClip(tl, newClip('/a.360', 10 * S, true));
    tl = addClip(tl, newClip('/b.mp4', 6 * S, false));
    const r = deleteSideAt(tl, 4 * S, 'right');
    expect(r.clips[0]).toMatchObject({ inUs: 0, outUs: 4 * S });
    expect(r.clips[1]).toEqual(tl.clips[1]);
    const l = deleteSideAt(tl, 12 * S, 'left');
    expect(l.clips[1]).toMatchObject({ inUs: 2 * S, outUs: 6 * S });
    expect(timelineDuration(l)).toBe(14 * S);
  });
});

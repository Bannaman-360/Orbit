import { describe, expect, it } from 'vitest';
import { newGaugeOverlay, newTextOverlay } from './overlays';
import { localAt, mediaAt } from './speed';
import { addClip, clipDuration, clipStarts, detachAudio, emptyTimeline, locate, newAudioClip, newClip, rippleItems, setClipSpeed, timelineDuration, trimClip, type Timeline } from './timeline';

const S = 1e6;
const two = (): Timeline => {
  let tl = addClip(emptyTimeline(), { ...newClip('a.mp4', 10 * S, false), id: 'a' });
  tl = addClip(tl, { ...newClip('b.mp4', 10 * S, false), id: 'b' });
  return { ...tl, overlays: [{ ...newGaugeOverlay('speed', 0, 20 * S), id: 'gauge' }, { ...newTextOverlay(12 * S, 14 * S), id: 'onB' }, { ...newTextOverlay(4 * S, 6 * S), id: 'onA' }], audio: [{ ...newAudioClip('song.mp3', 60 * S, 3 * S), id: 'song' }] };
};
const ov = (tl: Timeline, id: string) => tl.overlays.find((o) => o.id === id)!;
/** The picture under a timeline time. */
const pic = (tl: Timeline, T: number) => { const l = locate(tl, T)!; return `${l.clip.id}@${Math.round(l.mediaUs)}`; };

describe('things on the timeline follow a clip that changes length', () => {
  it('slowing the first clip', () => {
    const tl = two(), after = rippleItems(tl, setClipSpeed(tl, 'a', { speed: 0.5 }), 'a');
    expect(timelineDuration(after)).toBe(30 * S);
    expect([ov(after, 'gauge').startUs, ov(after, 'gauge').endUs]).toEqual([0, 30 * S]);
    expect(pic(after, ov(after, 'onB').startUs)).toBe(pic(tl, 12 * S));
    expect(ov(after, 'onB').endUs - ov(after, 'onB').startUs).toBe(2 * S);
    expect(pic(after, ov(after, 'onA').startUs)).toBe(pic(tl, 4 * S));
    expect(pic(after, ov(after, 'onA').endUs)).toBe(pic(tl, 6 * S));
    expect(after.audio[0]!.startUs).toBe(3 * S);
  });
  it('a speed ramp', () => {
    const tl = two(), keys = [{ id: 'k1', t: 3 * S, speed: 1 }, { id: 'k2', t: 5 * S, speed: 0.25 }, { id: 'k3', t: 7 * S, speed: 2 }];
    const after = rippleItems(tl, setClipSpeed(tl, 'a', { speedKeys: keys }), 'a');
    for (const id of ['onA', 'onB']) expect(Math.abs(locate(after, ov(after, id).startUs)!.mediaUs - locate(tl, ov(tl, id).startUs)!.mediaUs)).toBeLessThan(2);
    expect(ov(after, 'gauge').endUs).toBeCloseTo(timelineDuration(after), 0);
  });
  it('trimming the first clip from either end', () => {
    const tl = two();
    const right = rippleItems(tl, trimClip(tl, 'a', 0, 8 * S, 10 * S), 'a');
    expect(ov(right, 'onB').startUs).toBe(10 * S);
    expect(ov(right, 'onA').startUs).toBe(4 * S);
    const left = rippleItems(tl, trimClip(tl, 'a', 3 * S, 10 * S, 10 * S), 'a');
    expect(ov(left, 'onA').startUs).toBe(1 * S);
    expect(pic(left, ov(left, 'onA').startUs)).toBe(pic(tl, 4 * S));
    // A title on a part trimmed off moves to where the clip now starts.
    const cut = rippleItems(tl, trimClip(tl, 'a', 5 * S, 10 * S, 10 * S), 'a');
    expect(ov(cut, 'onA').startUs).toBe(0);
    expect(ov(cut, 'onA').endUs).toBe(1 * S);
  });
  it('detached sound of later clips follows; music doesn’t', () => {
    let tl = detachAudio(two(), 'b');
    tl = rippleItems(tl, setClipSpeed(tl, 'a', { speed: 2 }), 'a');
    const linked = tl.audio.find((x) => x.linkedClipId === 'b')!;
    expect(linked.startUs).toBe(clipStarts(tl)[1]);
    expect(tl.audio.find((x) => x.id === 'song')!.startUs).toBe(3 * S);
  });
  it('nothing changes when nothing changed', () => {
    const tl = two();
    expect(rippleItems(tl, tl, 'a')).toBe(tl);
    void mediaAt; void localAt; void clipDuration;
  });
});

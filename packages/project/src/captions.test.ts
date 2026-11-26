import { describe, expect, it } from 'vitest';
import { captionOverlays, fromSrt, makeCaptions, toSrt, withCaptions, wrapLines } from './captions';
import { emptyTimeline } from './timeline';
import { newTextOverlay } from './overlays';

const S = 1e6;

describe('captions', () => {
  it('wraps at spaces', () => {
    const lines = wrapLines('this is a fairly long sentence that has to be broken into lines', 20);
    expect(lines.every((l) => l.length <= 20)).toBe(true);
    expect(lines.join(' ')).toBe('this is a fairly long sentence that has to be broken into lines');
  });

  it('splits long speech into two-line captions with the time shared out', () => {
    const long = 'We dropped into the first berm way too fast and nearly went over the bars but somehow held it together all the way to the bottom of the track';
    const c = makeCaptions([{ startUs: 2 * S, endUs: 10 * S, text: long }]);
    expect(c.length).toBeGreaterThan(1);
    expect(c.every((x) => x.text.split('\n').length <= 2)).toBe(true);
    expect(c[0]!.startUs).toBe(2 * S);
    expect(c[c.length - 1]!.endUs).toBeLessThanOrEqual(10 * S + 1);
    for (let i = 1; i < c.length; i++) expect(c[i]!.startUs).toBeGreaterThanOrEqual(c[i - 1]!.endUs);
  });

  it('keeps short words on screen long enough, without overlapping the next', () => {
    const c = makeCaptions([{ startUs: 0, endUs: 0.2 * S, text: 'Go!' }, { startUs: 0.5 * S, endUs: 1.5 * S, text: 'Nice' }]);
    expect(c[0]!.endUs).toBe(0.5 * S);
    expect(makeCaptions([{ startUs: 0, endUs: 0.2 * S, text: 'Go!' }])[0]!.endUs).toBe(0.9 * S);
  });

  it('replaces only captions on the timeline, and writes and reads .srt', () => {
    const own = newTextOverlay(0, S, 'My title');
    const tl = withCaptions({ ...emptyTimeline(), overlays: [own] }, captionOverlays([{ startUs: 61.5 * S, endUs: 63 * S, text: 'Hello\nthere' }]));
    expect(tl.overlays.length).toBe(2);
    const again = withCaptions(tl, captionOverlays([{ startUs: 1 * S, endUs: 2 * S, text: 'One' }]));
    expect(again.overlays.filter((o) => o.caption).map((o) => o.text)).toEqual(['One']);
    expect(again.overlays.some((o) => o.text === 'My title')).toBe(true);
    const srt = toSrt(tl);
    expect(srt).toBe('1\n00:01:01,500 --> 00:01:03,000\nHello\nthere\n');
    expect(fromSrt(srt)).toEqual([{ startUs: 61.5 * S, endUs: 63 * S, text: 'Hello\nthere' }]);
  });
});

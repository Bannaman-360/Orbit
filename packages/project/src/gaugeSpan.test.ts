import { describe, expect, it } from 'vitest';
import { addClip, emptyTimeline, newClip, splitAt, type Timeline } from './timeline';
import { gaugeCount, gaugePieces } from './gaugeSpan';
import { newGaugeOverlay, splitOverlay, trimOverlayAt } from './overlays';

const S = 1_000_000;
/** Two rides: 10–20 s of a.mp4, then 0–10 s of b.mp4. */
function twoRides(): Timeline {
  let tl = addClip(emptyTimeline(), { ...newClip('a.mp4', 60 * S, false), inUs: 10 * S, outUs: 20 * S });
  tl = addClip(tl, { ...newClip('b.mp4', 60 * S, false), inUs: 0, outUs: 10 * S });
  return tl;
}

describe('what a gauge counts', () => {
  it('covers only the footage under the gauge', () => {
    const tl = twoRides();
    const p = gaugePieces(tl, { startUs: 5 * S, endUs: 15 * S });
    expect(p.map((x) => [x.clip.mediaPath, x.T0, x.T1, x.m0, x.m1])).toEqual([['a.mp4', 5 * S, 10 * S, 15 * S, 20 * S - 1], ['b.mp4', 10 * S, 15 * S, 0, 5 * S]]);
    expect(p[1]!.afterCut).toBe(true);
  });
  it('starts again at a cut, unless set to keep counting', () => {
    const tl = twoRides();
    const o = { startUs: 5 * S, endUs: 15 * S };
    const c = gaugeCount(tl, o, 12 * S);
    expect(c.from).toBe(10 * S);
    expect(c.done).toEqual([]);
    expect(c.now?.clip.mediaPath).toBe('b.mp4');
    const k = gaugeCount(tl, { ...o, keepCounting: true }, 12 * S);
    expect(k.from).toBe(5 * S);
    expect(k.done.map((x) => x.clip.mediaPath)).toEqual(['a.mp4']);
    expect(k.run).toHaveLength(2);
  });
  it('a plain split (nothing cut out) is not a cut', () => {
    const tl = splitAt(addClip(emptyTimeline(), newClip('a.mp4', 20 * S, false)), 8 * S);
    const c = gaugeCount(tl, { startUs: 2 * S, endUs: 18 * S }, 12 * S);
    expect(c.from).toBe(2 * S);
    expect(c.done).toHaveLength(1);
  });
  it('cuts and trims a gauge at the playhead', () => {
    const g = newGaugeOverlay('distance', 0, 10 * S);
    const tl = { ...emptyTimeline(), overlays: [g] };
    const cut = splitOverlay(tl, g.id, 4 * S);
    expect(cut.overlays.map((o) => [o.startUs, o.endUs])).toEqual([[0, 4 * S], [4 * S, 10 * S]]);
    expect(cut.overlays[1]!.id).not.toBe(g.id);
    expect(splitOverlay(tl, g.id, 12 * S)).toBe(tl);
    expect(trimOverlayAt(tl, g.id, 4 * S, 'left').overlays[0]).toMatchObject({ startUs: 4 * S, endUs: 10 * S });
    expect(trimOverlayAt(tl, g.id, 4 * S, 'right').overlays[0]).toMatchObject({ startUs: 0, endUs: 4 * S });
  });
});

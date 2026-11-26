import { describe, expect, it } from 'vitest';
import { alignBox, SAFE_MARGIN } from './alignGuides';

describe('alignment guides', () => {
  it('centres a box that is nearly in the middle and shows the centre line', () => {
    const r = alignBox({ x: 0.41, y: 0.2, w: 0.2, h: 0.1 }, [], 0.02, 0.02);
    expect(r.dx).toBeCloseTo(-0.01, 6);
    expect(r.guides.v).toEqual([0.5]);
    expect(r.dy).toBe(0);
    expect(r.guides.h).toEqual([]);
  });
  it('lines up with the safe margin and with other items', () => {
    const r = alignBox({ x: 0.06, y: 0.61, w: 0.1, h: 0.1 }, [{ x: 0.5, y: 0.6, w: 0.2, h: 0.1 }], 0.02, 0.02);
    expect(r.dx).toBeCloseTo(SAFE_MARGIN - 0.06, 6);
    expect(r.dy).toBeCloseTo(-0.01, 6);
    expect(r.guides.v).toContain(SAFE_MARGIN);
    // Top, middle and bottom all line up with the other item now.
    expect(r.guides.h).toEqual([0.6, 0.65, 0.7]);
  });
  it('leaves a box alone when nothing is close', () => {
    const r = alignBox({ x: 0.2, y: 0.25, w: 0.1, h: 0.1 }, [], 0.01, 0.01);
    expect(r).toEqual({ dx: 0, dy: 0, guides: { v: [], h: [] } });
  });
});

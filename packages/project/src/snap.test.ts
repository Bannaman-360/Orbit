import { describe, expect, it } from 'vitest';
import { snapSpan, snapTargets, snapTime, type SnapTarget } from './snap';

const T = (t: number, kind: SnapTarget['kind'] = 'edge'): SnapTarget => ({ t, kind });

describe('snapping', () => {
  it('jumps to the nearest target within reach, else stays', () => {
    const targets = [T(1000), T(5000, 'beat')];
    expect(snapTime(1200, targets, 300)).toEqual({ t: 1000, to: T(1000) });
    expect(snapTime(4900, targets, 300).t).toBe(5000);
    expect(snapTime(3000, targets, 300)).toEqual({ t: 3000 });
  });
  it('prefers the playhead and markers over a beat at the same distance', () => {
    expect(snapTime(1000, [T(900, 'beat'), T(1100, 'playhead')], 200).to?.kind).toBe('playhead');
    expect(snapTime(1000, [T(900, 'marker'), T(1100, 'beat')], 200).to?.kind).toBe('marker');
  });
  it('moves a block by whichever end is nearer, keeping its length', () => {
    const r = snapSpan(1050, 3050, [T(1000), T(3100)], 200);
    expect(r.start).toBe(1000);
    const r2 = snapSpan(1150, 3080, [T(1000), T(3100)], 200);
    expect(r2.start).toBe(1170);
    expect(snapSpan(500, 700, [T(5000)], 100)).toEqual({ start: 500 });
  });
  it('merges targets at the same time, keeping the stronger kind', () => {
    expect(snapTargets([T(1000, 'beat'), T(1000.2, 'edge'), T(2000, 'bar'), T(Number.NaN)])).toEqual([T(1000.2, 'edge'), T(2000, 'bar')]);
  });
});

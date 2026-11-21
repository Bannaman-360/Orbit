import { describe, expect, it } from 'vitest';
import { mulVec } from '@ace/media360';
import { axisMapMatrix, correctionAt, gravityAt, smoothGravity, type OrientationData } from './orientation';

const data = (grav: [number, number, number][]): OrientationData => ({
  grav: grav.map((v, i) => ({ t: i * 33_333, v })),
  cori: [],
  streams: ['GRAV'],
});

describe('axis map', () => {
  it('builds signed permutation matrices', () => {
    expect(axisMapMatrix(['x', 'y', 'z'])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(mulVec(axisMapMatrix(['-y', 'z', 'x']), [1, 2, 3])).toEqual([-2, 3, 1]);
  });
});

describe('horizon correction', () => {
  it('is identity when the camera is level', () => {
    const m = correctionAt(data([[0, -1, 0]]), 0, { mode: 'horizon', axisMap: ['x', 'y', 'z'] });
    m.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i]!, 9));
  });

  it('maps measured gravity onto world down for a rolled camera', () => {
    const a = (30 * Math.PI) / 180;
    const g: [number, number, number] = [Math.sin(a), -Math.cos(a), 0]; // rolled 30°
    const m = correctionAt(data([g]), 0, { mode: 'horizon', axisMap: ['x', 'y', 'z'] });
    const down = mulVec(m, g);
    expect(down[0]).toBeCloseTo(0, 9);
    expect(down[1]).toBeCloseTo(-1, 9);
  });

  it('interpolates between samples', () => {
    const d = data([[0, -1, 0], [1, 0, 0]]);
    const g = gravityAt(d, 33_333 / 2)!;
    expect(g[0]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('smoothing keeps vectors unit length', () => {
    const s = smoothGravity(data([[0, -1, 0], [0.1, -1, 0], [0, -1, 0.1]]).grav, 1);
    for (const x of s) expect(Math.hypot(...x.v)).toBeCloseTo(1, 9);
  });
});

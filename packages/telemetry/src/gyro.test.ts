import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@ace/media360';
import { denseOrientation, fitGyro, qconj, qexp, qlog, qmul, qnorm, type Quat } from './gyro';
import type { TimedQuat, TimedVec3 } from './orientation';

/** A shaking camera: true orientation at any time, and what its sensors record. */
const rate = (s: number): Vec3 => [
  1.1 * Math.cos(2 * Math.PI * 7 * s) + 0.4 * Math.sin(2 * Math.PI * 0.6 * s),
  0.9 * Math.sin(2 * Math.PI * 11 * s + 1) + 0.5,
  0.8 * Math.cos(2 * Math.PI * 17 * s + 2),
];
const truth: Quat[] = [];
const DT = 1 / 8000;
{
  let q: Quat = [1, 0, 0, 0];
  for (let i = 0; i <= 8000 * 6; i++) { truth.push(q); const r = rate((i + 0.5) * DT); q = qnorm(qmul(q, qexp([r[0] * DT, r[1] * DT, r[2] * DT]))); }
}
const at = (s: number) => truth[Math.max(0, Math.min(truth.length - 1, Math.round(s / DT)))]!;
const angle = (a: Quat, b: Quat) => Math.hypot(...qlog(qmul(qconj(a), b))) * (180 / Math.PI);
const cori = (fps: number): TimedQuat[] => Array.from({ length: Math.floor(5.5 * fps) }, (_, i) => ({ t: (i / fps) * 1e6 + 100_000, q: at(i / fps + 0.1) }));
const gyro = (o: { off?: number; deg?: boolean; map?: (v: Vec3) => Vec3; noise?: number } = {}): TimedVec3[] =>
  Array.from({ length: 5.9 * 800 }, (_, i) => {
    const s = i / 800, r = rate(s), k = o.deg ? 180 / Math.PI : 1, n = () => (o.noise ?? 0) * Math.sin(i * 12.9898 + 78.233);
    const v: Vec3 = [r[0] * k + n(), r[1] * k + n(), r[2] * k + n()];
    return { t: s * 1e6 - (o.off ?? 0), v: o.map ? o.map(v) : v };
  });

describe('gyro between frames', () => {
  it('finds axes, clock and units', () => {
    const g = gyro({ off: 43_000, deg: true, map: ([x, y, z]) => [-z, x, -y] });
    const f = fitGyro(cori(30), g)!;
    expect(f).not.toBeNull();
    expect(f.residual).toBeLessThan(0.03);
    expect(Math.abs(f.offsetUs - 43_000)).toBeLessThan(2500);
    expect(f.axes).toEqual([1, 2, 0]);
    expect(f.signs).toEqual([1, -1, -1]);
    expect(f.scale).toBeCloseTo(Math.PI / 180, 3);
  });
  it('follows shake inside a frame far better than blending frames', () => {
    for (const fps of [24, 30, 60]) {
      const c = cori(fps), g = gyro({ noise: 0.05 });
      const d = denseOrientation(c, g, fitGyro(c, g)!, 10);
      let dense = 0, plain = 0;
      for (const p of d) {
        const s = p.t / 1e6;
        dense = Math.max(dense, angle(p.q, at(s)));
        const i = Math.min(c.length - 2, Math.floor((p.t - 100_000) / (1e6 / fps) + 1e-6)), a = c[i]!, b = c[i + 1]!, fr = (p.t - a.t) / (b.t - a.t);
        plain = Math.max(plain, angle(qnorm(a.q.map((v, k) => v + (b.q[k]! - v) * fr) as Quat), at(s)));
      }
      expect(dense, `${fps} fps`).toBeLessThan(0.12);
      if (fps <= 30) expect(dense).toBeLessThan(plain / 4);
    }
  });
  it('lands exactly on the camera’s orientation at every frame', () => {
    const c = cori(30), g = gyro({ noise: 0.3 });
    const d = denseOrientation(c, g, fitGyro(c, g)!, 8);
    for (let i = 0; i < c.length - 1; i++) expect(angle(d[i * 8]!.q, c[i]!.q)).toBeLessThan(1e-4);
  });
  it('refuses a gyro that does not match', () => {
    const c = cori(30);
    expect(fitGyro(c, gyro().map((s, i) => ({ t: s.t, v: [Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9)] as Vec3 })))).toBeNull();
    expect(fitGyro(c.map((s) => ({ ...s, q: [1, 0, 0, 0] as Quat })), gyro())).toBeNull();
    expect(fitGyro([], [])).toBeNull();
  });
});

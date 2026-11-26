import { describe, expect, it } from 'vitest';
import { holdGaps, clampPath, courseBetween, courseToWorld, lazyFollow, pathAt, pathKeyframes, planPath, simplifyPath, smoothPath, unwrapDegrees } from './reframe';
import { lookAt } from './keyframes';
import { DEFAULT_LOOK } from './look';

const S = 1e6;
const series = (n: number, f: (i: number) => number, dt = 0.1 * S) => Array.from({ length: n }, (_, i) => ({ t: i * dt, v: f(i) }));

describe('smart reframe paths', () => {
  it('unwraps degrees across ±180', () => {
    expect(unwrapDegrees([170, 179, -179, -170])).toEqual([170, 179, 181, 190]);
  });

  it('ignores a single wrong measurement', () => {
    const pts = series(50, (i) => (i === 25 ? 0.9 : 0.2));
    const s = smoothPath(pts, 0.3 * S);
    expect(Math.abs(s[25]!.v - 0.2)).toBeLessThan(0.02);
  });

  it('drifts to the middle where nothing was measured', () => {
    const pts = series(100, () => 0.8).map((p, i) => ({ ...p, w: i < 10 ? 1 : 0 }));
    const s = smoothPath(pts, 0.3 * S);
    expect(s[90]!.v).toBeCloseTo(0, 1);
    expect(s[2]!.v).toBeGreaterThan(0.7);
  });

  it('a subject that stops moving stays where it was last seen', () => {
    const pts = series(30, (i) => (i >= 10 && i < 20 ? 0.5 : 0)).map((p, i) => ({ ...p, w: i >= 10 && i < 20 ? 1 : 0 }));
    const h = holdGaps(pts);
    expect(h[0]!.v).toBe(0.5);
    expect(h[29]!.v).toBe(0.5);
  });

  it('a lazy camera stays put for small moves', () => {
    const pts = series(40, (i) => 0.05 * Math.sin(i));
    expect(lazyFollow(pts, 0.1).every((p) => p.v === 0)).toBe(true);
    const step = lazyFollow(series(10, (i) => (i < 5 ? 0 : 1)), 0.1);
    expect(step[9]!.v).toBeCloseTo(0.9);
  });

  it('simplifies to few keyframes that stay close to the path', () => {
    const pts = series(300, (i) => Math.sin(i / 40));
    const keys = simplifyPath(pts, 0.02, 0.4 * S);
    expect(keys.length).toBeLessThan(40);
    expect(keys[0]!.t).toBe(0);
    expect(keys[keys.length - 1]!.t).toBe(pts[pts.length - 1]!.t);
    for (const p of pts) expect(Math.abs(pathAt(keys, p.t) - p.v)).toBeLessThan(0.06);
    for (let i = 1; i < keys.length - 1; i++) expect(keys[i]!.t - keys[i - 1]!.t).toBeGreaterThanOrEqual(0.4 * S);
  });

  it('plans a calm, clamped move', () => {
    const raw = series(200, (i) => (i < 100 ? -2 : 0.6) + (i % 7) * 0.01);
    const keys = planPath(raw, { sigmaUs: 0.5 * S, dead: 0.08, tol: 0.03, minGapUs: 0.4 * S, lo: -1, hi: 1 });
    expect(Math.min(...keys.map((k) => k.v))).toBeGreaterThanOrEqual(-1);
    expect(pathAt(keys, 19 * S)).toBeGreaterThan(0.4);
    expect(keys.length).toBeLessThan(20);
    expect(clampPath([{ t: 0, v: 3 }], -1, 1)[0]!.v).toBe(1);
  });

  it('works out the GPS course offset and direction', () => {
    // The camera's world frame is turned 30° and counts the other way round from a compass.
    const course = Array.from({ length: 30 }, (_, i) => (i * 12) % 360);
    const cam = course.map((c, i) => 30 - c + (i % 3) * 4);
    const toWorld = courseToWorld(cam, course)!;
    expect(toWorld).not.toBeNull();
    const d = ((toWorld(90) - (30 - 90 + 4)) % 360 + 540) % 360 - 180;
    expect(Math.abs(d)).toBeLessThan(8);
    // Unrelated directions: no answer.
    expect(courseToWorld(course.map((_, i) => (i * 97) % 360), course.map((_, i) => (i * 211) % 360))).toBeNull();
  });

  it('course between positions', () => {
    expect(courseBetween({ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 })).toBeCloseTo(0, 1);
    expect(courseBetween({ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 })).toBeCloseTo(90, 1);
  });

  it('writes keyframes that keep the clip’s own changes', () => {
    const base = DEFAULT_LOOK;
    const own = [{ id: 'a', t: 1 * S, look: { ...base, grade: { ...base.grade, exposure: 1 } }, easing: 'smooth' as const }];
    const path = [{ t: 0, v: -0.5 }, { t: 1.05 * S, v: 0 }, { t: 2 * S, v: 0.5 }];
    const keys = pathKeyframes({ look: base, keyframes: own }, path, (l, v) => ({ ...l, pan: { x: v, y: 0 } }));
    // The one near the clip's own keyframe merges into it.
    expect(keys.length).toBe(3);
    expect(keys.find((k) => k.id === 'a')!.look.grade.exposure).toBe(1);
    expect(lookAt(keys, base, 1.5 * S).pan!.x).toBeCloseTo(0.25, 1);
    expect(lookAt(keys, base, 0).pan!.x).toBeCloseTo(-0.5);
  });
});

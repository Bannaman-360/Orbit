import { describe, expect, it } from 'vitest';
import { fastCorners, fitRotationQuat, frameTurn, matToQuat, pyramid, robustRotation, trackPoints, type Gray } from './flow';
import { axisAngle, mulVec, normalize, quatToMat, type Vec3 } from './math';

/** A textured test picture: smooth blobs, sampled at (x + ox, y + oy). */
function picture(w: number, h: number, ox = 0, oy = 0): Gray {
  const d = new Float32Array(w * h);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const blobs = Array.from({ length: 140 }, () => ({ x: rnd() * w, y: rnd() * h, r: 3 + rnd() * 9, v: rnd() < 0.5 ? -1 : 1 }));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 128;
    for (const b of blobs) { const dx = x + ox - b.x, dy = y + oy - b.y; v += b.v * 90 * Math.exp(-(dx * dx + dy * dy) / (2 * b.r * b.r)); }
    d[y * w + x] = Math.max(0, Math.min(255, v));
  }
  return { w, h, d };
}

const angleOf = (q: number[]) => 2 * Math.acos(Math.min(1, Math.abs(q[0]!)));

describe('optical flow', () => {
  it('finds corners spread over the picture', () => {
    const g = picture(240, 140);
    const c = fastCorners(g, { threshold: 10 });
    expect(c.length).toBeGreaterThan(40);
    expect(Math.max(...c.map((p) => p[0]))).toBeGreaterThan(160);
    expect(Math.min(...c.map((p) => p[0]))).toBeLessThan(80);
  });

  it('follows points to where they moved, to a fraction of a pixel', () => {
    const a = picture(240, 140), b = picture(240, 140, -3.4, 1.7);
    const pts = fastCorners(a, { threshold: 10 }).slice(0, 60);
    const t = trackPoints(pyramid(a), pyramid(b), pts);
    const good = t.pts.filter((_, i) => t.ok[i]);
    expect(good.length).toBeGreaterThan(pts.length * 0.7);
    const dx = good.map((p, i) => p[0] - pts[t.ok.indexOf(true, 0) >= 0 ? t.pts.indexOf(p) : i]![0]);
    const med = [...dx].sort((x, y) => x - y)[dx.length >> 1]!;
    expect(med).toBeCloseTo(3.4, 1);
  });

  it('fits a rotation to matched directions (Horn)', () => {
    const R = axisAngle(normalize([0.3, 1, -0.2]), 0.07);
    const a: Vec3[] = Array.from({ length: 30 }, (_, i) => normalize([Math.sin(i), Math.cos(i * 1.3) * 0.6, 1]));
    const b = a.map((v) => mulVec(R, v));
    const q = fitRotationQuat(a, b);
    const back = quatToMat(q);
    for (let i = 0; i < 9; i++) expect(back[i]!).toBeCloseTo(R[i]!, 6);
    expect(matToQuat(R).map((x) => +x.toFixed(6))).toEqual(q.map((x) => +x.toFixed(6)));
  });

  it('ignores matches that move on their own (RANSAC)', () => {
    const R = axisAngle([0, 1, 0], 0.02);
    let seed = 3;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const a: Vec3[] = Array.from({ length: 120 }, () => normalize([rnd() - 0.5, (rnd() - 0.5) * 0.6, 1]));
    const b = a.map((v, i) => (i % 4 === 0 ? normalize([v[0] + 0.05 * rnd(), v[1] - 0.04, v[2]]) : mulVec(R, v)));
    const r = robustRotation(a, b)!;
    expect(r.inliers).toBeGreaterThanOrEqual(85);
    expect(angleOf(r.q)).toBeCloseTo(0.02, 4);
  });

  it('measures how the camera turned between two frames', () => {
    // A pinhole camera 240 px wide with a 90° field of view: a sideways shift of the picture by
    // 3 px is a turn of about atan(3 / 120) round the vertical axis.
    const w = 240, h = 140, f = 120;
    const ray = (x: number, y: number): Vec3 => normalize([(x - w / 2) / f, -(y - h / 2) / f, 1]);
    const a = picture(w, h), b = picture(w, h, 3, 0);
    const t = frameTurn(pyramid(a), pyramid(b), ray, { corners: fastCorners(a, { threshold: 10 }) })!;
    expect(t).not.toBeNull();
    const ang = angleOf(t.q);
    expect(ang).toBeGreaterThan(0.018);
    expect(ang).toBeLessThan(0.032);
    // Content moved left (it is sampled 3 px further right): directions turned round +y or −y.
    expect(Math.abs(t.q[2]!)).toBeGreaterThan(Math.abs(t.q[1]!) * 4);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK } from './look';
import { applyTrack, COMFORT_FOV, fitSubjectFrac, fracForFov, setTrackRange, smoothTrack, trackActive, trackAt, trackHeld, trackRange, type ClipTrack } from './track';

const S = 1_000_000;
const path = (f: (s: number) => [number, number], from = 0, to = 4): ClipTrack => ({
  points: Array.from({ length: (to - from) * 30 + 1 }, (_, i) => {
    const s = from + i / 30;
    const [yaw, pitch] = f(s);
    return { t: s * S, yaw, pitch };
  }),
  smoothing: 0,
  offsetYaw: 0,
  offsetPitch: 0,
});

describe('subject track', () => {
  it('interpolates the path and adds the framing offset', () => {
    const tr = path((s) => [s * 10, -s]);
    expect(trackAt(tr, 2 * S)!.yaw).toBeCloseTo(20);
    expect(trackAt(tr, 2 * S)!.pitch).toBeCloseTo(-2);
    expect(applyTrack(DEFAULT_LOOK, { ...tr, offsetYaw: 5, offsetPitch: 3 }, 2 * S)).toMatchObject({ yaw: expect.closeTo(25), pitch: expect.closeTo(1) });
    // World-frame tracks go through the conversion to the clip's view.
    const world = { ...tr, space: 'world' as const };
    expect(applyTrack(DEFAULT_LOOK, world, 2 * S, (y, p) => ({ yaw: y + 100, pitch: p })).yaw).toBeCloseTo(120);
    expect(trackAt(tr, 5 * S)).toBeNull();
  });

  it('crosses ±180° without spinning the long way round', () => {
    const tr = path((s) => [170 + s * 10, 0]); // 170 → 210 = −150
    const sm = smoothTrack(tr.points, 0.3);
    for (let i = 1; i < sm.length; i++) {
      const d = ((sm[i]!.yaw - sm[i - 1]!.yaw + 540) % 360) - 180;
      expect(Math.abs(d)).toBeLessThan(2);
    }
  });

  it('smooths jitter', () => {
    const tr = { ...path((s) => [s * 10 + (Math.round(s * 30) % 2 ? 3 : -3), 0]), smoothing: 0.2 };
    const mid = trackAt(tr, 2 * S)!;
    expect(mid.yaw).toBeCloseTo(20, 0);
  });

  it('only drives pan/tilt, and leaves everything before the start alone', () => {
    const tr = path((s) => [90, 10], 1, 3);
    const look = { ...DEFAULT_LOOK, yaw: 0, pitch: 0, fov: 120 };
    expect(applyTrack(look, tr, 2 * S)).toMatchObject({ yaw: 90, pitch: 10, fov: 120 });
    // Nothing at all happens before the section, zoom included.
    for (const t of [0, 0.5, 0.9, 0.999]) expect(applyTrack({ ...look, fov: 40 }, { ...tr, autoZoom: 1, subjectFrac: 0.2, points: tr.points.map((p) => ({ ...p, size: 30 })) }, t * S)).toEqual({ ...look, fov: 40 });
    const easing = applyTrack(look, tr, 1.3 * S);
    expect(easing.yaw).toBeGreaterThan(5);
    expect(easing.yaw).toBeLessThan(85);
    expect(applyTrack(look, undefined, 2 * S)).toBe(look);
  });
});

describe('auto zoom', () => {
  // Subject grows from 10° to 40° across and back over 4 s.
  const growing = (): ClipTrack => ({
    ...path((s) => [0, 0]),
    points: path((s) => [0, 0]).points.map((p) => ({ ...p, size: 10 + 30 * Math.sin((Math.PI * p.t) / (4 * S)) })),
    autoZoom: 1,
    subjectFrac: 0.3,
  });
  it('keeps the subject at the same share of the frame', () => {
    const tr = growing();
    for (const s of [1, 2, 3.5]) {
      const l = applyTrack({ ...DEFAULT_LOOK, fov: 100 }, { ...tr, maxFov: 170 }, s * S);
      const size = trackAt(tr, s * S)!.size!;
      expect(size / l.fov).toBeCloseTo(0.3, 2);
    }
  });
  it('partial strength zooms part of the way; off leaves the zoom alone', () => {
    const at2 = (z: number) => applyTrack({ ...DEFAULT_LOOK, fov: 100 }, { ...growing(), autoZoom: z }, 2 * S).fov;
    expect(at2(0)).toBe(100);
    const full = at2(1), half = at2(0.5);
    expect(half).toBeGreaterThan(Math.min(full, 100));
    expect(half).toBeLessThan(Math.max(full, 100));
  });
  it('smooths size changes so the zoom is calm', () => {
    const jittery = { ...growing(), smoothing: 0.25, points: growing().points.map((p, i) => ({ ...p, size: (p.size ?? 10) * (i % 2 ? 1.3 : 0.77) })) };
    const a = trackAt(jittery, 2 * S)!.size!, b = trackAt(jittery, 2 * S + 33_333)!.size!;
    expect(Math.abs(Math.log(a / b))).toBeLessThan(0.02);
  });
  it('picks a subject size that the closest moment can hold with a normal lens', () => {
    const tr = growing();
    const frac = fitSubjectFrac(tr, 0.05); // framed tiny at the start
    expect(frac).toBeGreaterThan(0.2);
    for (const s of [1, 2, 3, 3.8]) expect(applyTrack({ ...DEFAULT_LOOK, fov: 100 }, { ...tr, subjectFrac: frac }, s * S).fov).toBeLessThanOrEqual(COMFORT_FOV + 0.5);
    expect(fitSubjectFrac(tr, 0.6)).toBe(0.6); // already big enough: as framed
  });
});

describe('using part of a track', () => {
  // Pans 20°/s for 4 s.
  const full = path((s) => [s * 20, 0]);
  const look = { ...DEFAULT_LOOK, yaw: -60, pitch: 0, fov: 100 };
  const yawAt = (tr: ClipTrack, s: number) => applyTrack(look, tr, s * S).yaw;

  it('follows only inside the chosen range and keeps the whole path', () => {
    const tr = { ...setTrackRange(full, 1 * S, 3 * S), ease: 0.5, after: 'return' as const };
    expect(trackRange(tr)).toEqual([1 * S, 3 * S]);
    expect(tr.points.length).toBe(full.points.length);
    expect(yawAt(tr, 2)).toBeCloseTo(40);
    expect(yawAt(tr, 0.99)).toBe(-60);
    expect(yawAt(tr, 3.6)).toBe(-60);
    expect([trackActive(tr, 0.9 * S), trackActive(tr, 2 * S), trackActive(tr, 3.1 * S)]).toEqual([false, true, false]);
    // Widening it again brings the rest back.
    const back = setTrackRange(tr, 0, 99 * S);
    expect([back.from, back.to]).toEqual([undefined, undefined]);
    expect(applyTrack(look, back, 3.9 * S).yaw).toBeCloseTo(78);
  });

  it('never jumps: the view moves in small steps through both ends', () => {
    for (const after of ['hold', 'return'] as const) {
      const tr = { ...setTrackRange(full, 1 * S, 3 * S), after };
      for (let s = 0; s < 4; s += 1 / 60) {
        const d = ((yawAt(tr, s + 1 / 60) - yawAt(tr, s) + 540) % 360) - 180;
        expect(Math.abs(d)).toBeLessThan(6);
      }
    }
  });

  it('holds the last view, coasting to a stop, or settles on a chosen one', () => {
    const tr = setTrackRange(full, 0, 2 * S);
    expect(trackHeld(tr, 3 * S)).toBe(true);
    const end = yawAt(tr, 3);
    expect(end).toBeGreaterThan(40);
    expect(end).toBeLessThan(45);
    expect(yawAt(tr, 3.9)).toBe(end); // stopped
    const chosen = { ...tr, end: { yaw: 10, pitch: -5, fov: 80 } };
    expect(applyTrack(look, chosen, 3.5 * S)).toMatchObject({ yaw: expect.closeTo(10), pitch: expect.closeTo(-5), fov: expect.closeTo(80) });
    expect(yawAt(chosen, 2)).toBeCloseTo(40); // tracked part unchanged
  });

  it('keeps the ends in order and inside what was tracked', () => {
    expect(trackRange(setTrackRange(full, 3 * S, 1 * S))).toEqual([3 * S, 3.1 * S]);
    expect(trackRange(setTrackRange(full, -5 * S, 50 * S))).toEqual([0, 4 * S]);
  });
});

describe('lens while tracking', () => {
  // Like the real lens: linear, unless bent by fisheye (1 = equidistant here).
  const R = Math.PI / 180;
  const share = (size: number, fov: number, fish: number) => {
    const k = Math.max(1e-3, Math.min(1 - fish, 177 / fov));
    return Math.tan(k * (size / 2) * R) / Math.tan(k * (fov / 2) * R);
  };
  const grow: ClipTrack = { ...path(() => [0, 0]), points: path(() => [0, 0]).points.map((p) => ({ ...p, size: 5 + 30 * Math.sin((Math.PI * p.t) / (4 * S)) })), autoZoom: 1, subjectFrac: 0.2, maxFov: 170, ease: 0 };
  const own = { ...DEFAULT_LOOK, fov: 60, fisheye: 0 };
  it('really keeps the subject the same size on screen', () => {
    for (const lens of [0, 0.6, 1]) for (const s of [0.2, 1, 2, 3, 3.8]) {
      const tr = { ...grow, lens };
      const l = applyTrack(own, tr, s * S, undefined, share);
      if (l.fov < 169) expect(share(trackAt(tr, s * S)!.size!, l.fov, l.fisheye), `lens ${lens} at ${s}s`).toBeCloseTo(0.2, 2);
    }
  });
  it('bends the lens only when wide, smoothly, and never below the clip’s own', () => {
    expect(applyTrack(own, { ...grow, lens: 0.6 }, 0.1 * S, undefined, share).fisheye).toBeLessThan(0.02);
    expect(applyTrack(own, { ...grow, lens: 0.6 }, 2 * S, undefined, share).fisheye).toBeGreaterThan(0.4);
    expect(applyTrack(own, { ...grow, lens: 0 }, 2 * S, undefined, share).fisheye).toBe(0);
    expect(applyTrack({ ...own, fisheye: 0.9 }, { ...grow, lens: 0.6 }, 2 * S, undefined, share).fisheye).toBe(0.9);
    expect(applyTrack(own, { ...grow, autoZoom: 0, lens: 1 }, 2 * S, undefined, share).fisheye).toBe(0);
    let prev = applyTrack(own, grow, 0, undefined, share);
    for (let s = 1 / 60; s < 4; s += 1 / 60) {
      const l = applyTrack(own, grow, s * S, undefined, share);
      if (s > 0.1) { expect(Math.abs(l.fisheye - prev.fisheye)).toBeLessThan(0.05); expect(Math.abs(l.fov - prev.fov)).toBeLessThan(6); }
      prev = l;
    }
  });
  it('respects the widest zoom, and zooming by hand sets the size', () => {
    expect(applyTrack(own, { ...grow, maxFov: 90 }, 2 * S, undefined, share).fov).toBeLessThanOrEqual(90);
    const frac = fracForFov(grow, 1 * S, 70, 0, share)!;
    expect(applyTrack(own, { ...grow, subjectFrac: frac }, 1 * S, undefined, share).fov).toBeCloseTo(70, 1);
  });
});

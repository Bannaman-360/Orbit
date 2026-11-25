import { describe, expect, it } from 'vitest';
import { bezierAt, cleanBezier, evalCurve } from './curves';
import { cleanKeyCurves, curveOf, easeInOut, keyframeNear, lookAt, mixLook, nextKeyTime, prevKeyTime, removeKeyframe, setEasing, setKeyframe, type Keyframe } from './keyframes';
import { blurFrames, DEFAULT_LOOK, gradeFromPreset, NEUTRAL_GRADE, type Look } from './look';

const L = (o: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...o });

describe('look interpolation', () => {
  it('turns yaw the short way round', () => {
    expect(mixLook(L({ yaw: 170 }), L({ yaw: -170 }), 0.5).yaw).toBeCloseTo(180, 9);
    expect(mixLook(L({ yaw: -170 }), L({ yaw: 170 }), 0.5).yaw).toBeCloseTo(-180, 9);
  });

  it('zooms FOV evenly (log space)', () => {
    expect(mixLook(L({ fov: 50 }), L({ fov: 200 }), 0.5).fov).toBeCloseTo(100, 9);
  });

  it('blends every grade value', () => {
    const a = L({ grade: NEUTRAL_GRADE });
    const b = L({ grade: { ...NEUTRAL_GRADE, exposure: 2, saturation: -1 } });
    const m = mixLook(a, b, 0.25).grade;
    expect(m.exposure).toBeCloseTo(0.5, 9);
    expect(m.saturation).toBeCloseTo(-0.25, 9);
  });

  it('ease in/out starts and ends still', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOut(0.01)).toBeLessThan(0.001);
  });
});

describe('keyframes', () => {
  let keys: Keyframe[] = [];
  keys = setKeyframe(keys, 2_000_000, L({ yaw: 90 }), 20_000, 'linear');
  keys = setKeyframe(keys, 0, L({ yaw: 0 }), 20_000, 'linear');

  it('keeps keyframes sorted and holds the ends', () => {
    expect(keys.map((k) => k.t)).toEqual([0, 2_000_000]);
    expect(lookAt(keys, DEFAULT_LOOK, -5).yaw).toBe(0);
    expect(lookAt(keys, DEFAULT_LOOK, 9e9).yaw).toBe(90);
  });

  it('interpolates between keys with the segment easing', () => {
    expect(lookAt(keys, DEFAULT_LOOK, 500_000).yaw).toBeCloseTo(22.5, 9);
    const held = setEasing(keys, keys[0]!.id, 'hold');
    expect(lookAt(held, DEFAULT_LOOK, 1_900_000).yaw).toBe(0);
  });

  it('updates a keyframe instead of duplicating it when close in time', () => {
    const k2 = setKeyframe(keys, 2_010_000, L({ yaw: 45 }));
    expect(k2).toHaveLength(2);
    expect(lookAt(k2, DEFAULT_LOOK, 9e9).yaw).toBe(45);
    expect(keyframeNear(k2, 1_995_000)).toBeDefined();
  });

  it('navigates and removes', () => {
    expect(nextKeyTime(keys, 0)).toBe(2_000_000);
    expect(prevKeyTime(keys, 2_000_000)).toBe(0);
    expect(removeKeyframe(keys, keys[0]!.id)).toHaveLength(1);
  });

  it('uses the base look when there are no keyframes', () => {
    expect(lookAt([], L({ pitch: 12 }), 1).pitch).toBe(12);
  });
});

describe('presets, blur and saves', () => {
  it('fills presets from the neutral grade', () => {
    const g = gradeFromPreset('Black & white');
    expect(g.saturation).toBe(-1);
    expect(g.exposure).toBe(0);
  });

  it('maps motion blur to 1–8 blended frames', () => {
    expect(blurFrames(0)).toBe(1);
    expect(blurFrames(1)).toBe(8);
  });

});

describe('keyframe curves', () => {
  const a = L({ yaw: 0, grade: { ...NEUTRAL_GRADE, exposure: 0 } });
  const b = L({ yaw: 100, grade: { ...NEUTRAL_GRADE, exposure: 1 } });
  const two = (easing: Keyframe['easing'], extra: Partial<Keyframe> = {}): Keyframe[] => [
    { id: 'a', t: 0, look: a, easing, ...extra },
    { id: 'b', t: 1_000_000, look: b, easing: 'smooth' },
  ];
  it('named curves start and end on the keyframes', () => {
    for (const e of ['smooth', 'linear', 'ease-in', 'ease-out', 'overshoot', 'bounce'] as const) {
      expect(lookAt(two(e), DEFAULT_LOOK, 0).yaw).toBeCloseTo(0, 6);
      expect(lookAt(two(e), DEFAULT_LOOK, 999_999).yaw).toBeCloseTo(100, 0);
    }
  });
  it('ease in is slow first, ease out fast first', () => {
    expect(lookAt(two('ease-in'), DEFAULT_LOOK, 250_000).yaw).toBeLessThan(25);
    expect(lookAt(two('ease-out'), DEFAULT_LOOK, 250_000).yaw).toBeGreaterThan(25);
  });
  it('overshoot goes past the next value, bounce never does', () => {
    const ys = (e: Keyframe['easing']) => Array.from({ length: 99 }, (_, i) => lookAt(two(e), DEFAULT_LOOK, (i + 1) * 10_000).yaw);
    expect(Math.max(...ys('overshoot'))).toBeGreaterThan(105);
    expect(Math.max(...ys('bounce'))).toBeLessThanOrEqual(100.0001);
  });
  it('custom handles act like CSS cubic-bezier', () => {
    expect(bezierAt([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 5);
    expect(bezierAt([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 5);
    expect(lookAt(two('custom', { bezier: [0, 1, 0, 1] }), DEFAULT_LOOK, 100_000).yaw).toBeGreaterThan(50);
  });
  it('a group can have its own curve', () => {
    let keys = two('linear');
    keys = setEasing(keys, 'a', 'hold', 'grade');
    const m = lookAt(keys, DEFAULT_LOOK, 500_000);
    expect(m.yaw).toBeCloseTo(50, 6);
    expect(m.grade.exposure).toBe(0);
    keys = setEasing(keys, 'a', null, 'grade');
    expect(keys[0]!.curves).toBeUndefined();
    expect(lookAt(keys, DEFAULT_LOOK, 500_000).grade.exposure).toBeCloseTo(0.5, 6);
  });
  it('setting a named curve drops custom handles', () => {
    const k = setEasing(two('custom', { bezier: [0.1, 0.2, 0.3, 0.4] }), 'a', 'linear');
    expect(k[0]!.bezier).toBeUndefined();
    expect(evalCurve(curveOf(k[0]!), 0.4)).toBeCloseTo(0.4, 9);
  });
  it('loading makes curves safe', () => {
    const k = cleanKeyCurves({ id: 'x', t: 0, look: a, easing: 'wobble' as never, curves: { view: { easing: 'custom', bezier: [2, 0, NaN, 1] as never } } });
    expect(k.easing).toBe('smooth');
    expect(k.curves!.view!.easing).toBe('custom');
    expect(k.curves!.view!.bezier).toEqual([0.5, 0, 0.5, 1]);
    expect(cleanBezier([2, 3, -1, 0])).toEqual([1, 2, 0, 0]);
  });
});

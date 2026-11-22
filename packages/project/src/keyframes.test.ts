import { describe, expect, it } from 'vitest';
import { easeInOut, keyframeNear, lookAt, mixLook, nextKeyTime, prevKeyTime, removeKeyframe, setEasing, setKeyframe, type Keyframe } from './keyframes';
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

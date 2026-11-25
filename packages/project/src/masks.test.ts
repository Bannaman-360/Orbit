import { describe, expect, it } from 'vitest';
import { addMaskKey, fixMasks, insidePolygon, maskOutline, maskPoseAt, newMask, removeMaskKey, setMaskPose } from './masks';
import { applyTrack } from './track';
import { DEFAULT_LOOK } from './look';
import { loadTimeline, newClip } from './timeline';

const S = 1e6;

describe('masks', () => {
  it('keeps its own pose until keyed, then moves between keyframes', () => {
    let m = newMask('rect');
    m = setMaskPose(m, 0, { x: 0.2 });
    expect(m.x).toBe(0.2);
    expect(m.keys).toEqual([]);
    m = addMaskKey(m, 0);
    m = setMaskPose(m, 2 * S, { x: 0.8 });
    expect(m.keys.map((k) => k.x)).toEqual([0.2, 0.8]);
    expect(maskPoseAt(m, 1 * S).x).toBeCloseTo(0.5, 6);
    expect(maskPoseAt(m, 5 * S).x).toBeCloseTo(0.8, 6);
    // Removing the last keyframe keeps that pose.
    const one = removeMaskKey(removeMaskKey(m, m.keys[0]!.id), m.keys[1]!.id);
    expect(one.keys).toEqual([]);
    expect(one.x).toBeCloseTo(0.8, 6);
  });

  it('outlines and hit-tests a turned box in pixels', () => {
    const m = { ...newMask('rect'), w: 0.2, h: 0.1, rotate: 90 };
    const pts = maskOutline(m, m, 16 / 9);
    // A 16:9 frame: the box is 0.2·16/9 = 0.356 high wide; turned, it is 0.356 tall.
    expect(insidePolygon(pts, 0.5, 0.5 + 0.15)).toBe(true);
    expect(insidePolygon(pts, 0.5 + 0.15, 0.5)).toBe(false);
    const e = maskOutline(newMask('ellipse'), newMask('ellipse'), 1);
    expect(insidePolygon(e, 0.5, 0.5)).toBe(true);
    expect(insidePolygon(e, 0.36, 0.36)).toBe(false);
  });

  it('cleans anything saved and loads with the clip', () => {
    expect(fixMasks([])).toBeUndefined();
    const raw = [{ shape: 'path', x: 9, feather: -1, effect: 'nope', keys: [{ t: 0, amount: 3 }] }, 'x', {}, {}, {}, {}];
    const fixed = fixMasks(raw)!;
    expect(fixed).toHaveLength(4);
    expect(fixed[0]).toMatchObject({ shape: 'path', x: 1.5, feather: 0, effect: 'blur' });
    expect(fixed[0]!.points!.length).toBeGreaterThanOrEqual(3);
    expect(fixed[0]!.keys[0]!.amount).toBe(1);
    const tl = loadTimeline({ clips: [{ ...newClip('/a.mp4', S, false), masks: [newMask('ellipse', 'pixelate')] }] });
    expect(tl.clips[0]!.masks![0]).toMatchObject({ shape: 'ellipse', effect: 'pixelate' });
  });

  it('a track that only moves masks leaves the view alone', () => {
    const tr = { points: [{ t: 0, yaw: 40, pitch: 0 }, { t: S, yaw: 40, pitch: 0 }, { t: 2 * S, yaw: 40, pitch: 0 }], smoothing: 0, offsetYaw: 0, offsetPitch: 0 };
    expect(applyTrack(DEFAULT_LOOK, tr, S).yaw).not.toBe(0);
    expect(applyTrack(DEFAULT_LOOK, { ...tr, steer: false }, S).yaw).toBe(0);
  });
});

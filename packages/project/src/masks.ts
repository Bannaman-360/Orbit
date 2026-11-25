// Masks: shapes drawn on a clip's picture that blur, pixelate or hide what is inside (or, inverted,
// outside) them. Each mask has a box (centre, size, turn) in the clip's own picture, as fractions
// of the frame; a freehand shape keeps its points inside that box, so moving or resizing the box
// moves the whole shape. Masks keyframe on their own (media times, like the look's keyframes),
// and can follow the subject the clip is tracking.

import { cleanWindowGrade, type WindowGrade } from './grading';

export type MaskShape = 'rect' | 'ellipse' | 'path';
export type MaskEffect = 'blur' | 'pixelate' | 'hide' | 'grade';

/** What can change over time. */
export interface MaskPose {
  /** Centre, fractions of the frame (0–1). When following a subject: offset from the subject. */
  x: number;
  y: number;
  /** Size, fractions of the frame's width / height. */
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotate: number;
  /** Soft edge, a share of the frame's height (0–0.2). */
  feather: number;
  /** Grows (+) or shrinks (−) the shape, a share of the frame's height (−0.1…0.1). */
  expand: number;
  /** Strength of the effect, 0–1. */
  amount: number;
}

export interface MaskKey extends MaskPose {
  id: string;
  /** Media time, µs. */
  t: number;
}

export interface Mask extends MaskPose {
  id: string;
  shape: MaskShape;
  /** Freehand: the outline, each point −0.5…0.5 inside the box. */
  points?: [number, number][];
  effect: MaskEffect;
  /** Hide: the colour it is filled with. */
  color: string;
  /** Color (a power window): the grade inside the shape. */
  grade?: WindowGrade;
  /** Applies outside the shape instead. */
  invert: boolean;
  /** Moves with the subject the clip tracks (Subject tracking). */
  follow: boolean;
  /** Switched off for now (kept). */
  off?: boolean;
  keys: MaskKey[];
}

/** A clip can have this many masks (they share one small texture, one mask per channel). */
export const MAX_MASKS = 4;

export const MASK_EFFECTS: [MaskEffect, string][] = [['blur', 'Blur'], ['pixelate', 'Pixelate'], ['hide', 'Hide'], ['grade', 'Color']];
export const MASK_SHAPES: [MaskShape, string][] = [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['path', 'Freehand']];

let counter = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newMask(shape: MaskShape, effect: MaskEffect = 'blur', at: Partial<MaskPose> & { points?: [number, number][] } = {}): Mask {
  return {
    id: newId('k'), shape, effect, color: '#000000', invert: false, follow: false, keys: [],
    x: 0.5, y: 0.5, w: 0.25, h: shape === 'rect' ? 0.2 : 0.3, rotate: 0, feather: 0.01, expand: 0, amount: 0.8,
    ...(shape === 'path' ? { points: [[-0.5, -0.3], [0.1, -0.5], [0.5, 0], [0.2, 0.5], [-0.4, 0.4]] as [number, number][] } : {}),
    ...at,
  };
}

const POSE: (keyof MaskPose)[] = ['x', 'y', 'w', 'h', 'rotate', 'feather', 'expand', 'amount'];
export const poseOf = (m: MaskPose): MaskPose => Object.fromEntries(POSE.map((k) => [k, m[k]])) as unknown as MaskPose;

const smooth = (f: number) => f * f * (3 - 2 * f);

/** The mask's pose at media time t (its own values when it has no keyframes). */
export function maskPoseAt(m: Mask, t: number): MaskPose {
  const k = [...m.keys].sort((a, b) => a.t - b.t);
  if (!k.length) return poseOf(m);
  if (t <= k[0]!.t) return poseOf(k[0]!);
  const last = k[k.length - 1]!;
  if (t >= last.t) return poseOf(last);
  let i = 0;
  while (k[i + 1]!.t <= t) i++;
  const a = k[i]!, b = k[i + 1]!, f = smooth((t - a.t) / (b.t - a.t));
  return Object.fromEntries(POSE.map((p) => [p, a[p] + (b[p] - a[p]) * f])) as unknown as MaskPose;
}

/**
 * Changes a mask's pose. With keyframes, the change goes into the keyframe at t (made if there
 * isn't one within `snapUs`); without, into the mask itself.
 */
export function setMaskPose(m: Mask, t: number, patch: Partial<MaskPose>, snapUs = 20_000): Mask {
  const p = cleanPose({ ...maskPoseAt(m, t), ...patch });
  if (!m.keys.length) return { ...m, ...p };
  const near = m.keys.find((k) => Math.abs(k.t - t) <= snapUs);
  if (near) return { ...m, keys: m.keys.map((k) => (k === near ? { ...k, ...p } : k)) };
  return { ...m, keys: [...m.keys, { id: newId('q'), t: Math.round(t), ...p }].sort((a, b) => a.t - b.t) };
}

/** Adds a keyframe at t holding the mask's pose there (the first one keeps the current pose). */
export function addMaskKey(m: Mask, t: number, snapUs = 20_000): Mask {
  if (m.keys.some((k) => Math.abs(k.t - t) <= snapUs)) return m;
  return { ...m, keys: [...m.keys, { id: newId('q'), t: Math.round(t), ...maskPoseAt(m, t) }].sort((a, b) => a.t - b.t) };
}

export const removeMaskKey = (m: Mask, id: string): Mask => {
  const keys = m.keys.filter((k) => k.id !== id);
  // The last keyframe gone: the mask keeps that pose.
  return keys.length ? { ...m, keys } : { ...m, ...poseOf(m.keys.find((k) => k.id === id) ?? m), keys };
};

export function cleanPose(p: MaskPose): MaskPose {
  const c = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
  return {
    x: c(p.x, -0.5, 1.5), y: c(p.y, -0.5, 1.5), w: c(p.w, 0.005, 2), h: c(p.h, 0.005, 2), rotate: c(p.rotate, -360, 360),
    feather: c(p.feather, 0, 0.2), expand: c(p.expand, -0.1, 0.1), amount: c(p.amount, 0, 1),
  };
}

/** Accepts anything previously saved. */
export function fixMasks(raw: unknown): Mask[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out = raw.filter((m) => m && typeof m === 'object').slice(0, MAX_MASKS).map((m: Partial<Mask>) => {
    const base = newMask(m.shape === 'ellipse' || m.shape === 'path' ? m.shape : 'rect');
    const pose = cleanPose({ ...poseOf(base), ...poseOf({ ...base, ...m } as MaskPose) });
    return {
      ...base, ...pose,
      id: typeof m.id === 'string' ? m.id : base.id,
      effect: MASK_EFFECTS.some(([e]) => e === m.effect) ? m.effect! : 'blur',
      color: typeof m.color === 'string' ? m.color : base.color,
      ...(m.effect === 'grade' || m.grade ? { grade: cleanWindowGrade(m.grade) } : {}),
      invert: !!m.invert, follow: !!m.follow, ...(m.off ? { off: true } : {}),
      ...(base.shape === 'path' ? { points: Array.isArray(m.points) && m.points.length >= 3 ? m.points.map(([a, b]) => [Number(a) || 0, Number(b) || 0] as [number, number]) : base.points } : {}),
      keys: (Array.isArray(m.keys) ? m.keys : []).filter((k) => k && Number.isFinite(k.t)).map((k) => ({ id: k.id || newId('q'), t: k.t, ...cleanPose({ ...pose, ...poseOf({ ...pose, ...k } as MaskPose) }) })),
    } satisfies Mask;
  });
  return out.length ? out : undefined;
}

/**
 * The outline of a mask in frame fractions (before feather and expand): a polygon. Rectangles
 * and ellipses are turned into points too, so drawing and hit-testing share one path.
 * `aspect`: frame width / height (turning happens in pixels).
 */
export function maskOutline(m: Mask, pose: MaskPose, aspect: number, centre: { x: number; y: number } = { x: pose.x, y: pose.y }): [number, number][] {
  let pts: [number, number][];
  if (m.shape === 'rect') pts = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  else if (m.shape === 'ellipse') pts = Array.from({ length: 48 }, (_, i) => { const a = (i / 48) * Math.PI * 2; return [Math.cos(a) * 0.5, Math.sin(a) * 0.5] as [number, number]; });
  else pts = m.points ?? [];
  const a = (pose.rotate * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return pts.map(([u, v]) => {
    // In pixels of a frame 1 high: the box is (w·aspect) × h.
    const px = u * pose.w * aspect, py = v * pose.h;
    return [centre.x + (px * cos - py * sin) / aspect, centre.y + px * sin + py * cos];
  });
}

/** Whether a frame point is inside a polygon (even-odd). */
export function insidePolygon(pts: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

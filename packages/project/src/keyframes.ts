// Keyframed looks with per-segment easing.

import { cleanCurve, easeInOut, evalCurve, type Bezier, type Curve, type Easing, type KeyGroup } from './curves';
import { mixWheels } from './grading';
import { IDENTITY_XF, NO_EFFECTS, type Effects, type Grade, type Look, type Transform } from './look';

export type { Easing } from './curves';
export { easeInOut } from './curves';

export interface Keyframe {
  id: string;
  /** Media time in microseconds. */
  t: number;
  look: Look;
  /** How the look moves from this keyframe to the next one. */
  easing: Easing;
  /** Custom curve's handles (easing 'custom'). */
  bezier?: Bezier;
  /** Groups of values that move on a curve of their own. */
  curves?: Partial<Record<KeyGroup, Curve>>;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** The curve a keyframe uses for a group of values (its own, or the keyframe's). */
export function curveOf(k: Pick<Keyframe, 'easing' | 'bezier' | 'curves'>, group?: KeyGroup): Curve {
  const own = group ? k.curves?.[group] : undefined;
  if (own) return own;
  return k.bezier && k.easing === 'custom' ? { easing: k.easing, bezier: k.bezier } : { easing: k.easing };
}

/** How far each group of values has moved at fraction f between keyframe k and the next. */
export type GroupFractions = Record<KeyGroup, number>;
export function keyFractions(k: Pick<Keyframe, 'easing' | 'bezier' | 'curves'>, f: number): GroupFractions {
  const all = evalCurve(curveOf(k), f);
  const g = (x: KeyGroup) => (k.curves?.[x] ? evalCurve(k.curves[x]!, f) : all);
  return { view: g('view'), xf: g('xf'), grade: g('grade'), fx: g('fx') };
}

/** Interpolate yaw along the shortest way round. */
function lerpAngle(a: number, b: number, f: number) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180 && b > a) d = 180;
  return a + d * f;
}

/** FOV zooms feel even when interpolated in log space. */
const lerpFov = (a: number, b: number, f: number) => Math.exp(lerp(Math.log(a), Math.log(b), f));

export function mixTransform(a: Transform, b: Transform, f: number): Transform {
  return {
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    // Zooms feel even in log space.
    scale: Math.exp(lerp(Math.log(Math.max(1e-3, a.scale)), Math.log(Math.max(1e-3, b.scale)), f)),
    crop: a.crop.map((c, i) => lerp(c, b.crop[i]!, f)) as Transform['crop'],
    rotate: lerp(a.rotate, b.rotate, f),
    opacity: lerp(a.opacity, b.opacity, f),
    radius: lerp(a.radius, b.radius, f),
    border: lerp(a.border, b.border, f),
    borderColor: f < 0.5 ? a.borderColor : b.borderColor,
    shadow: lerp(a.shadow, b.shadow, f),
  };
}

/** A look part of the way from a to b: one fraction for everything, or one per group of values. */
export function mixLook(a: Look, b: Look, fr: number | GroupFractions): Look {
  const f = typeof fr === 'number' ? { view: fr, xf: fr, grade: fr, fx: fr } : fr;
  const grade = {} as Grade;
  for (const k of Object.keys(a.grade) as (keyof Grade)[]) grade[k] = lerp(a.grade[k], b.grade[k], f.grade);
  const fx = { ...NO_EFFECTS };
  // (Effects can't go below nothing, even when a curve overshoots.)
  for (const k of Object.keys(fx) as (keyof Effects)[]) fx[k] = Math.max(0, lerp(a.fx?.[k] ?? 0, b.fx?.[k] ?? 0, f.fx));
  const wheels = mixWheels(a.wheels, b.wheels, f.grade);
  return {
    ...(a.xf || b.xf ? { xf: mixTransform(a.xf ?? IDENTITY_XF, b.xf ?? IDENTITY_XF, f.xf) } : {}),
    ...(wheels ? { wheels } : {}),
    ...(a.pan || b.pan ? { pan: { x: lerp(a.pan?.x ?? 0, b.pan?.x ?? 0, f.view), y: lerp(a.pan?.y ?? 0, b.pan?.y ?? 0, f.view) } } : {}),
    yaw: lerpAngle(a.yaw, b.yaw, f.view),
    pitch: lerp(a.pitch, b.pitch, f.view),
    roll: lerp(a.roll, b.roll, f.view),
    fov: lerpFov(a.fov, b.fov, f.view),
    fisheye: lerp(a.fisheye, b.fisheye, f.view),
    motionBlur: Math.max(0, lerp(a.motionBlur, b.motionBlur, f.fx)),
    grade,
    fx,
  };
}

export const sortKeys = (keys: Keyframe[]) => [...keys].sort((a, b) => a.t - b.t);

/** The look at time t. With no keyframes the base look applies. */
export function lookAt(keys: Keyframe[], base: Look, t: number): Look {
  if (!keys.length) return base;
  const k = sortKeys(keys);
  if (t <= k[0]!.t) return k[0]!.look;
  const last = k[k.length - 1]!;
  if (t >= last.t) return last.look;
  let i = 0;
  while (k[i + 1]!.t <= t) i++;
  const a = k[i]!, b = k[i + 1]!;
  return mixLook(a.look, b.look, keyFractions(a, (t - a.t) / (b.t - a.t)));
}

let counter = 0;
const newId = () => `k${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Adds a keyframe at t, or replaces the one within `snapUs` of it. */
export function setKeyframe(keys: Keyframe[], t: number, look: Look, snapUs = 20_000, easing: Easing = 'smooth'): Keyframe[] {
  const existing = keys.find((k) => Math.abs(k.t - t) <= snapUs);
  if (existing) return sortKeys(keys.map((k) => (k === existing ? { ...k, look } : k)));
  return sortKeys([...keys, { id: newId(), t, look, easing }]);
}

export function keyframeNear(keys: Keyframe[], t: number, snapUs = 20_000): Keyframe | undefined {
  return keys.find((k) => Math.abs(k.t - t) <= snapUs);
}

export const removeKeyframe = (keys: Keyframe[], id: string) => keys.filter((k) => k.id !== id);

export function moveKeyframe(keys: Keyframe[], id: string, t: number): Keyframe[] {
  return sortKeys(keys.map((k) => (k.id === id ? { ...k, t } : k)));
}

/** Sets a keyframe's curve: for every value, or (with `group`) for one group of values. null clears a group's own curve. */
export function setEasing(keys: Keyframe[], id: string, easing: Easing | Curve | null, group?: KeyGroup): Keyframe[] {
  return keys.map((k) => {
    if (k.id !== id) return k;
    const c = easing === null ? null : cleanCurve(typeof easing === 'string' ? { easing } : easing);
    if (group) {
      const curves = { ...k.curves };
      if (c) curves[group] = c; else delete curves[group];
      const { curves: _old, ...rest } = k;
      return Object.keys(curves).length ? { ...rest, curves } : rest;
    }
    if (!c) return k;
    const { bezier: _b, ...rest } = k;
    return c.bezier ? { ...rest, easing: c.easing, bezier: c.bezier } : { ...rest, easing: c.easing };
  });
}

/** A keyframe's curves made safe (from a file). */
export function cleanKeyCurves(k: Keyframe): Keyframe {
  const main = cleanCurve({ easing: k.easing, bezier: k.bezier });
  const { bezier: _b, curves: raw, ...rest } = k;
  const out: Keyframe = { ...rest, easing: main.easing, ...(main.bezier ? { bezier: main.bezier } : {}) };
  if (raw && typeof raw === 'object') {
    const curves: Partial<Record<KeyGroup, Curve>> = {};
    for (const g of ['view', 'xf', 'grade', 'fx'] as KeyGroup[]) if (raw[g]) curves[g] = cleanCurve(raw[g]);
    if (Object.keys(curves).length) out.curves = curves;
  }
  return out;
}

export function prevKeyTime(keys: Keyframe[], t: number): number | undefined {
  return sortKeys(keys).reverse().find((k) => k.t < t - 1000)?.t;
}
export function nextKeyTime(keys: Keyframe[], t: number): number | undefined {
  return sortKeys(keys).find((k) => k.t > t + 1000)?.t;
}

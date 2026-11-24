// Keyframed looks with per-segment easing.

import { IDENTITY_XF, NO_EFFECTS, type Effects, type Grade, type Look, type Transform } from './look';

export type Easing = 'smooth' | 'linear' | 'hold';

export interface Keyframe {
  id: string;
  /** Media time in microseconds. */
  t: number;
  look: Look;
  /** How the look moves from this keyframe to the next one. */
  easing: Easing;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Smoothstep-style ease in/out with zero velocity at both keys. */
export const easeInOut = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);

function ease(e: Easing, f: number) {
  if (e === 'hold') return 0;
  if (e === 'linear') return f;
  return easeInOut(f);
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

export function mixLook(a: Look, b: Look, f: number): Look {
  const grade = {} as Grade;
  for (const k of Object.keys(a.grade) as (keyof Grade)[]) grade[k] = lerp(a.grade[k], b.grade[k], f);
  const fx = { ...NO_EFFECTS };
  for (const k of Object.keys(fx) as (keyof Effects)[]) fx[k] = lerp(a.fx?.[k] ?? 0, b.fx?.[k] ?? 0, f);
  return {
    ...(a.xf || b.xf ? { xf: mixTransform(a.xf ?? IDENTITY_XF, b.xf ?? IDENTITY_XF, f) } : {}),
    yaw: lerpAngle(a.yaw, b.yaw, f),
    pitch: lerp(a.pitch, b.pitch, f),
    roll: lerp(a.roll, b.roll, f),
    fov: lerpFov(a.fov, b.fov, f),
    fisheye: lerp(a.fisheye, b.fisheye, f),
    motionBlur: lerp(a.motionBlur, b.motionBlur, f),
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
  return mixLook(a.look, b.look, ease(a.easing, (t - a.t) / (b.t - a.t)));
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

export const setEasing = (keys: Keyframe[], id: string, easing: Easing) => keys.map((k) => (k.id === id ? { ...k, easing } : k));

export function prevKeyTime(keys: Keyframe[], t: number): number | undefined {
  return sortKeys(keys).reverse().find((k) => k.t < t - 1000)?.t;
}
export function nextKeyTime(keys: Keyframe[], t: number): number | undefined {
  return sortKeys(keys).find((k) => k.t > t + 1000)?.t;
}

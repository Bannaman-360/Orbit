// Virtual-camera lens model used when reframing 360 footage.
// CPU reference for the ray generation in the WGSL shader.
//
// One continuous lens family, controlled by a single "fisheye" amount:
//
//   r(θ) = tan(kθ) / k    k > 0   (k = 1 rectilinear, k = ½ stereographic)
//   r(θ) = θ              k = 0   (equidistant fisheye)
//   r(θ) = sin(kθ) / k    k < 0   (k = −½ equisolid fisheye)
//
// where θ is the angle from the view axis and r the distance from the image centre.
// The fisheye slider f ∈ [−½, 1] maps to k = 1 − 1.5f, so:
//  −½ = "beyond linear" (k = 1.75): the opposite of fisheye — centre shrinks, edges stretch,
//       straight lines bow slightly inward; widest possible FOV is about 100°
//   0 = linear (straight lines stay straight)
//   ⅓ = stereographic (classic "tiny planet")
//   ⅔ = equidistant fisheye
//   1 = equisolid fisheye (most compressed edges)

import { type Mat3, type Vec3, mulMat, mulVec, normalize, transpose, viewRotation } from './math';

export interface ViewParams {
  /** Degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Horizontal field of view in degrees, 1–360. */
  fov: number;
  /** −0.5 = beyond linear … 0 = linear … 1 = strong fisheye. */
  fisheye: number;
  /** Automatically add fisheye when the FOV is too wide for the chosen lens. */
  autoLens: boolean;
}

export const DEFAULT_VIEW: ViewParams = { yaw: 0, pitch: 0, roll: 0, fov: 100, fisheye: 0, autoLens: true };
export const TINY_PLANET_VIEW: ViewParams = { yaw: 0, pitch: -90, roll: 0, fov: 260, fisheye: 1 / 3, autoLens: true };

export const MIN_FOV = 1;
export const ABS_MAX_FOV = 360;

const RAD = Math.PI / 180;

export const MIN_FISHEYE = -0.5;
export const lensK = (fisheye: number) => 1 - 1.5 * Math.max(MIN_FISHEYE, Math.min(1, fisheye));
export const fisheyeForK = (k: number) => (1 - k) / 1.5;

/** Widest horizontal FOV (degrees) a lens can show before rays wrap past straight back. */
export function maxFovForK(k: number): number {
  // For k > 0 the lens reaches infinity at θ = π/(2k). Stay a little inside it.
  return k > 0 ? Math.min(ABS_MAX_FOV, (180 / k) * 0.985) : ABS_MAX_FOV;
}

/**
 * The lens and FOV actually rendered: auto-lens adds just enough fisheye to fit the FOV
 * (for "beyond linear" settings that first means easing back towards linear).
 */
export function effectiveLens(view: Pick<ViewParams, 'fov' | 'fisheye' | 'autoLens'>): { k: number; fov: number } {
  const fov = Math.max(MIN_FOV, Math.min(ABS_MAX_FOV, view.fov));
  let k = lensK(view.fisheye);
  if (fov <= maxFovForK(k)) return { k, fov };
  if (view.autoLens) return { k: Math.min(k, (180 * 0.985) / fov), fov };
  return { k, fov: maxFovForK(k) };
}

/** Image radius for angle θ. */
export function lensForward(k: number, theta: number): number {
  if (Math.abs(k) < 1e-4) return theta;
  return k > 0 ? Math.tan(k * theta) / k : Math.sin(k * theta) / k;
}

/** Share of the frame's width that something `size` degrees across fills in the middle of the view. */
export function frameShare(size: number, fov: number, fisheye: number): number {
  const lens = effectiveLens({ fov, fisheye, autoLens: true });
  return lensForward(lens.k, (Math.min(size, lens.fov) * RAD) / 2) / lensForward(lens.k, (lens.fov * RAD) / 2);
}

/**
 * The horizontal field of view that shows the same scene at the same zoom in a frame of another
 * shape: the corner-to-corner angle stays, so 100° across a 16:9 frame becomes about 68° across a
 * 9:16 one (the old width now runs down it) instead of squeezing 100° into the narrow frame.
 */
export function fovForAspect(view: Pick<ViewParams, 'fov' | 'fisheye'>, fromAspect: number, toAspect: number): number {
  if (!(fromAspect > 0) || !(toAspect > 0) || Math.abs(fromAspect - toAspect) < 1e-6) return view.fov;
  const lens = effectiveLens({ ...view, autoLens: true });
  const R = lensForward(lens.k, (lens.fov * RAD) / 2);
  const corner = Math.min(Math.PI * 0.985, lensInverse(lens.k, R * Math.hypot(1, 1 / fromAspect)) || Math.PI * 0.985);
  const fov = (2 * lensInverse(lens.k, lensForward(lens.k, corner) / Math.hypot(1, 1 / toAspect))) / RAD;
  return Number.isFinite(fov) ? Math.max(MIN_FOV, Math.min(ABS_MAX_FOV, fov)) : view.fov;
}

/** Angle θ for image radius r, or NaN if r is outside the lens's image circle. */
export function lensInverse(k: number, r: number): number {
  if (Math.abs(k) < 1e-4) return r;
  if (k > 0) return Math.atan(k * r) / k;
  const s = -k * r;
  return s > 1 ? NaN : Math.asin(s) / -k;
}

/**
 * Ray for a screen point in the virtual camera's own frame (+z forward, +y up).
 * nx, ny are normalised device coords in -1..1 (y up); aspect = width / height.
 * Returns null outside the lens's image circle (only possible for strong fisheye).
 */
export function cameraRay(k: number, fovDeg: number, aspect: number, nx: number, ny: number): Vec3 | null {
  const R = lensForward(k, (fovDeg * RAD) / 2);
  const x = nx * R, y = (ny * R) / aspect;
  const r = Math.hypot(x, y);
  if (r < 1e-12) return [0, 0, 1];
  const theta = lensInverse(k, r);
  if (!Number.isFinite(theta) || theta > Math.PI) return null;
  const s = Math.sin(theta) / r;
  return normalize([x * s, y * s, Math.cos(theta)]);
}

/**
 * Matrix that turns a camera ray into the direction to sample in the footage.
 *   cameraToFootage = correctionᵀ · view
 * `correction` is the camera body's orientation in the world (from telemetry). Sampling
 * through its transpose cancels the body motion, which is how horizon leveling and
 * stabilisation work.
 */
export function sampleMatrix(view: Pick<ViewParams, 'yaw' | 'pitch' | 'roll'>, correction: Mat3): Mat3 {
  return mulMat(transpose(correction), viewRotation(view.yaw * RAD, view.pitch * RAD, view.roll * RAD));
}

export function rayToFootage(m: Mat3, ray: Vec3): Vec3 {
  return mulVec(m, ray);
}

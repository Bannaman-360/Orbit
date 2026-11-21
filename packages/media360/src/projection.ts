// Virtual-camera projections used when reframing 360 footage.
// CPU reference for the ray generation in the WGSL shader.

import { type Mat3, type Vec3, mulMat, mulVec, normalize, transpose, viewRotation } from './math';

export type Projection = 'rectilinear' | 'stereographic';

export interface ViewParams {
  /** Degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Horizontal field of view in degrees. */
  fov: number;
  projection: Projection;
}

export const DEFAULT_VIEW: ViewParams = { yaw: 0, pitch: 0, roll: 0, fov: 100, projection: 'rectilinear' };
export const TINY_PLANET_VIEW: ViewParams = { yaw: 0, pitch: -90, roll: 0, fov: 260, projection: 'stereographic' };

const RAD = Math.PI / 180;

/** Max useful horizontal FOV per projection. */
export const MAX_FOV: Record<Projection, number> = { rectilinear: 150, stereographic: 330 };

/**
 * Ray for a screen point in the virtual camera's own frame.
 * nx, ny are normalised device coords in -1..1 (y up); aspect = width / height.
 */
export function cameraRay(projection: Projection, fovDeg: number, aspect: number, nx: number, ny: number): Vec3 {
  const fov = Math.min(fovDeg, MAX_FOV[projection]) * RAD;
  const px = nx * aspect;
  const py = ny;
  if (projection === 'rectilinear') {
    const k = Math.tan(fov / 2) / aspect;
    return normalize([px * k, py * k, 1]);
  }
  // Stereographic: plane radius r maps to angle θ = 2·atan(r / 2) from the view axis.
  // Scale so the horizontal half-width (r = k·aspect) hits fov/2.
  const k = (2 * Math.tan(fov / 4)) / aspect;
  const x = px * k, y = py * k;
  const r = Math.hypot(x, y);
  if (r < 1e-9) return [0, 0, 1];
  const theta = 2 * Math.atan(r / 2);
  const s = Math.sin(theta) / r;
  return [x * s, y * s, Math.cos(theta)];
}

/**
 * Matrix that turns a camera ray into the direction to sample in the footage.
 *   cameraToFootage = correctionᵀ · view
 * `correction` is the camera body's orientation in the world (from telemetry). Sampling
 * through its transpose cancels the body motion, which is how horizon leveling and
 * stabilisation work.
 */
export function sampleMatrix(view: ViewParams, correction: Mat3): Mat3 {
  return mulMat(transpose(correction), viewRotation(view.yaw * RAD, view.pitch * RAD, view.roll * RAD));
}

export function rayToFootage(m: Mat3, ray: Vec3): Vec3 {
  return mulVec(m, ray);
}

// A lens look that stays the same while zooming: the fisheye follows the field of view so the
// edges are always stretched as much against the middle as in the look that was chosen.
//
// The lens family is the one in media360/projection.ts: fisheye f gives k = 1 − 1.5f, and
// r(θ) = tan(kθ)/k (k > 0), θ (k = 0), sin(kθ)/k (k < 0).

/** The look: the fisheye chosen at one field of view. */
export interface LensLook { fov: number; fisheye: number }

const RAD = Math.PI / 180;
const kOf = (f: number) => 1 - 1.5 * Math.max(-0.5, Math.min(1, f));
const fOf = (k: number) => (1 - k) / 1.5;
const K_MIN = kOf(1);
/** Most k can be at a field of view before the picture wraps (as the renderer allows). */
const kFits = (fov: number) => (180 * 0.985) / Math.max(1, fov);

/** How much more the edge of the picture is magnified than its middle. */
export function edgeStretch(k: number, fov: number): number {
  const t = (Math.min(360, fov) / 2) * RAD;
  if (k > 1e-6) return k * t < Math.PI / 2 - 1e-6 ? 1 / Math.cos(k * t) ** 2 : Infinity;
  if (k < -1e-6) return Math.max(0, Math.cos(-k * t));
  return 1;
}

/** The fisheye that gives the look at a field of view. Never past linear unless the look itself is. */
export function fisheyeForLook(look: LensLook, fov: number): number {
  const k0 = Math.min(kOf(look.fisheye), kFits(look.fov));
  const want = edgeStretch(k0, look.fov);
  const hi = Math.min(Math.max(1, k0), kFits(fov));
  if (edgeStretch(hi, fov) <= want) return fOf(hi);
  if (edgeStretch(K_MIN, fov) >= want) return 1;
  let lo = K_MIN, top = hi;
  for (let i = 0; i < 50; i++) { const m = (lo + top) / 2; if (edgeStretch(m, fov) < want) lo = m; else top = m; }
  return fOf((lo + top) / 2);
}

/** The look new 360 clips start with: straight lines at 100°, more fisheye only as it gets wider. */
export const DEFAULT_LENS_LOOK: LensLook = { fov: 100, fisheye: 0 };

// Equi-Angular Cubemap (EAC) mapping and the GoPro Max dual-stream tile layout.
//
// A GoPro Max .360 file stores the sphere as 6 cube faces split across two video
// streams. Each face is stored as a "tile" (square, or two halves around a lens
// overlap strip; see goproMaxLayout). A tile is described explicitly by
// which world direction its centre faces and which world directions its image-right
// and image-down point to. This makes calibrating against real footage a matter of
// editing data, not shader code.
//
// The same description is uploaded to the GPU (see shader.ts), so the CPU functions
// here are the reference implementation that the unit tests check.

import { type Vec3, cross, dot, normalize } from './math';

export type FaceName = 'front' | 'back' | 'left' | 'right' | 'up' | 'down';

export interface Tile {
  face: FaceName;
  /** Index of the video stream (0 or 1) that holds this tile. */
  stream: number;
  /** Top-left of the face inside the stream frame, and its size in face pixels. */
  x: number;
  y: number;
  size: number;
  /**
   * Pixels of lens overlap stored in the middle of the tile (GoPro stores the side
   * faces in two halves, one per lens, with an overlap strip between them). The tile
   * then spans `size + gap` pixels: left half, `gap` overlap pixels, right half.
   * The first gap/2 overlap pixels continue the left half past the midline, the last
   * gap/2 continue the right half before it. 0 for faces stored in one piece.
   */
  gap?: number;
  /** World axis the face centre looks at. Must be a unit axis (e.g. [0,0,1]). */
  center: Vec3;
  /** World axis that points to the right in the tile image. */
  right: Vec3;
  /** World axis that points down in the tile image. */
  down: Vec3;
}

export interface EacLayout {
  name: string;
  streamWidth: number;
  streamHeight: number;
  tiles: Tile[];
}

const AX = {
  px: [1, 0, 0] as Vec3,
  nx: [-1, 0, 0] as Vec3,
  py: [0, 1, 0] as Vec3,
  ny: [0, -1, 0] as Vec3,
  pz: [0, 0, 1] as Vec3,
  nz: [0, 0, -1] as Vec3,
};

/**
 * GoPro Max / Max 2 layout, derived from stream size. Confirmed on Max 2 footage:
 * both streams have hard breaks at x = 688 and 3408 (4096-wide streams), which is
 * where the stored halves of the side faces meet their overlap strips.
 *
 * Stream 0: left | front | right, upright. Stream 1: down | back | up, laid sideways
 * (the back-lens strip rotated 90° clockwise), so moving right goes down→back→up.
 * The middle face of each stream is one lens and is stored whole. The outer faces
 * straddle both lenses, so each is stored as two halves with the spare width
 * (stream width − 3 faces, split evenly) as an overlap strip at its midline:
 *
 *   4096 = [672 left-back | 32 overlap | 672 left-front][1344 front][672 right-front | 32 | 672 right-back]
 */
export function goproMaxLayout(streamWidth: number, streamHeight: number): EacLayout {
  const s = streamHeight;
  const gap = Math.max(0, (streamWidth - 3 * s) / 2);
  const x0 = 0, x1 = s + gap, x2 = 2 * s + gap;
  return {
    name: `GoPro Max (${streamWidth}x${streamHeight}, ${gap}px lens overlap)`,
    streamWidth,
    streamHeight,
    tiles: [
      { face: 'left', stream: 0, x: x0, y: 0, size: s, gap, center: AX.nx, right: AX.pz, down: AX.ny },
      { face: 'front', stream: 0, x: x1, y: 0, size: s, gap: 0, center: AX.pz, right: AX.px, down: AX.ny },
      { face: 'right', stream: 0, x: x2, y: 0, size: s, gap, center: AX.px, right: AX.nz, down: AX.ny },
      { face: 'down', stream: 1, x: x0, y: 0, size: s, gap, center: AX.ny, right: AX.nz, down: AX.nx },
      { face: 'back', stream: 1, x: x1, y: 0, size: s, gap: 0, center: AX.nz, right: AX.py, down: AX.nx },
      { face: 'up', stream: 1, x: x2, y: 0, size: s, gap, center: AX.py, right: AX.pz, down: AX.nx },
    ],
  };
}

/** Width the tile occupies in the stream, overlap included. */
export const tileWidth = (t: Tile) => t.size + (t.gap ?? 0);

/**
 * Equi-angular tile coordinates (es, ev in -1..1) → stream pixel. For split tiles the
 * two halves sit either side of the overlap strip. `side` picks which half's mapping
 * to use near the midline: 'left' and 'right' extend that half into the overlap
 * (used for blending), 'auto' picks by the sign of es.
 */
export function tilePixel(t: Tile, es: number, ev: number, side: 'auto' | 'left' | 'right' = 'auto'): [number, number] {
  const gap = t.gap ?? 0;
  const half = t.size / 2;
  const y = t.y + ((ev + 1) / 2) * t.size;
  if (!gap) return [t.x + ((es + 1) / 2) * t.size, y];
  const useLeft = side === 'left' || (side === 'auto' && es < 0);
  return [useLeft ? t.x + (es + 1) * half : t.x + half + gap + es * half, y];
}

/** EAC warp: cube-plane coordinate (-1..1) to equi-angular coordinate (-1..1). */
export const toEquiAngular = (a: number) => (4 / Math.PI) * Math.atan(a);
/** Inverse EAC warp: equi-angular coordinate (-1..1) to cube-plane coordinate (-1..1). */
export const fromEquiAngular = (e: number) => Math.tan((e * Math.PI) / 4);

/** Pick the tile whose centre axis is the dominant component of `dir`. */
export function tileForDirection(layout: EacLayout, dir: Vec3): Tile {
  let best = layout.tiles[0]!;
  let bestDot = -Infinity;
  for (const t of layout.tiles) {
    const d = dot(dir, t.center);
    if (d > bestDot) {
      bestDot = d;
      best = t;
    }
  }
  return best;
}

export interface StreamSample {
  stream: number;
  /** Pixel position in the stream frame (continuous, 0..width / 0..height). */
  x: number;
  y: number;
  face: FaceName;
}

/** World direction → pixel in one of the two streams. Mirrors the WGSL shader. */
export function directionToStream(layout: EacLayout, dir: Vec3): StreamSample {
  const d = normalize(dir);
  const t = tileForDirection(layout, d);
  const major = dot(d, t.center);
  const s = dot(d, t.right) / major; // -1..1 on the cube plane
  const v = dot(d, t.down) / major;
  const [x, y] = tilePixel(t, toEquiAngular(s), toEquiAngular(v));
  return { stream: t.stream, x, y, face: t.face };
}

/**
 * Pixel in a stream → world direction, or null outside every tile. Overlap-strip
 * pixels map to the direction they show (just past the tile midline).
 */
export function streamToDirection(layout: EacLayout, stream: number, x: number, y: number): Vec3 | null {
  for (const t of layout.tiles) {
    if (t.stream !== stream) continue;
    if (x < t.x || x >= t.x + tileWidth(t) || y < t.y || y >= t.y + t.size) continue;
    const gap = t.gap ?? 0, half = t.size / 2;
    let es: number;
    if (!gap) es = ((x - t.x) / t.size) * 2 - 1;
    else if (x < t.x + half + gap / 2) es = (x - t.x) / half - 1; // left half (+ its overlap)
    else es = (x - t.x - half - gap) / half; // right half (+ its overlap)
    const ev = ((y - t.y) / t.size) * 2 - 1;
    const s = fromEquiAngular(es);
    const v = fromEquiAngular(ev);
    return normalize([
      t.center[0] + s * t.right[0] + v * t.down[0],
      t.center[1] + s * t.right[1] + v * t.down[1],
      t.center[2] + s * t.right[2] + v * t.down[2],
    ]);
  }
  return null;
}

/** Throws if a layout is not a proper cube (six distinct faces, right-handed tile bases). */
export function validateLayout(layout: EacLayout): void {
  if (layout.tiles.length !== 6) throw new Error('A layout needs exactly 6 tiles');
  const centers = new Set(layout.tiles.map((t) => t.center.join(',')));
  if (centers.size !== 6) throw new Error('Tile centres must cover all 6 cube directions');
  for (const t of layout.tiles) {
    for (const [a, b, n] of [
      [t.center, t.right, 'center/right'],
      [t.center, t.down, 'center/down'],
      [t.right, t.down, 'right/down'],
    ] as const) {
      if (Math.abs(dot(a, b)) > 1e-6) throw new Error(`Tile ${t.face}: ${n} not perpendicular`);
    }
    // Seen from inside the sphere, an un-mirrored image has right × down = -centre.
    const c = cross(t.right, t.down);
    if (dot(c, t.center) > -0.999) throw new Error(`Tile ${t.face}: image is mirrored`);
  }
}

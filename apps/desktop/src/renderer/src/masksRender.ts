// Masks on the picture: each mask's coverage (shape, feather, expand, invert) drawn into one
// small texture, one mask per channel, for the finish pass (see packages/media360/src/finish.ts).
// Shared by the preview, export and frame grabs, so they match.

import { maskOutline, maskPoseAt, trackAt, type Look, type Mask, type MaskPose, type TimelineClip } from '@ace/project';
import type { MaskSet, ReframeRenderer } from '@ace/media360';
import { clipLens, flatDirection, worldToClipView } from './frameRender';
import type { Media } from './media';
import { directionAt } from './tracker';

const KIND = { blur: 1, pixelate: 2, hide: 3, grade: 4 } as const;
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * Where the subject the clip tracks is in its picture at media time t (frame fractions), or null
 * when there is no track there or it is out of view. The view → picture mapping is solved
 * numerically (a few Gauss–Newton steps), the same mapping the tracker uses the other way round.
 */
export function subjectInFrame(clip: TimelineClip, media: Media, look: Look, t: number, aspect: number): { x: number; y: number } | null {
  const tr = clip.track;
  const p = tr && trackAt(tr, t);
  if (!tr || !p) return null;
  const flat = !!clipLens(media, clip);
  const world = tr.space !== 'view';
  // Compare in the space the screen mapping gives directions in.
  const target = flat ? p : world ? worldToClipView(media, clip, t, p.yaw, p.pitch) : p;
  const at = (nx: number, ny: number) => (flat ? flatDirection(clip, media, look, t, aspect, nx, ny)?.world ?? null : directionAt(look, aspect, nx, ny));
  const err = (d: { yaw: number; pitch: number }) => [wrap(d.yaw - target.yaw) * Math.cos((target.pitch * Math.PI) / 180), d.pitch - target.pitch] as const;
  let nx = 0, ny = 0;
  for (let it = 0; it < 10; it++) {
    const d0 = at(nx, ny);
    if (!d0) return null;
    const e = err(d0);
    if (Math.hypot(e[0], e[1]) < 0.02) break;
    const h = 0.01, dx = at(nx + h, ny), dy = at(nx, ny + h);
    if (!dx || !dy) return null;
    const ex = err(dx), ey = err(dy);
    const a = (ex[0] - e[0]) / h, b = (ey[0] - e[0]) / h, c = (ex[1] - e[1]) / h, d = (ey[1] - e[1]) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) return null;
    // Newton step, limited so a far guess can't fly off.
    let sx = (d * e[0] - b * e[1]) / det, sy = (-c * e[0] + a * e[1]) / det;
    const len = Math.hypot(sx, sy);
    if (len > 0.5) { sx *= 0.5 / len; sy *= 0.5 / len; }
    nx -= sx;
    ny -= sy;
  }
  const end = at(nx, ny);
  if (!end) return null;
  const e = err(end);
  if (Math.hypot(e[0], e[1]) > 1.5 || Math.abs(nx) > 3 || Math.abs(ny) > 3) return null;
  return { x: (nx + 1) / 2, y: (1 - ny) / 2 };
}

/** Where each mask is at media time t: its pose and centre (a following mask sits on the subject). */
export function maskPlaces(clip: TimelineClip, media: Media | null, look: Look, t: number, aspect: number): { mask: Mask; pose: MaskPose; centre: { x: number; y: number } }[] {
  const masks = (clip.masks ?? []).filter((m) => !m.off);
  if (!masks.length) return [];
  const subject = media && masks.some((m) => m.follow) ? subjectInFrame(clip, media, look, t, aspect) : null;
  return masks.map((mask) => {
    const pose = maskPoseAt(mask, t);
    const centre = mask.follow && subject ? { x: subject.x + pose.x - 0.5, y: subject.y + pose.y - 0.5 } : { x: pose.x, y: pose.y };
    return { mask, pose, centre };
  });
}

let scratch: { a: OffscreenCanvas; b: OffscreenCanvas } | null = null;
const cache = new WeakMap<ReframeRenderer, { key: string; set: MaskSet }>();
const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  const v = m ? parseInt(m[1]!, 16) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

/**
 * Coverage of up to four masks over a picture of `aspect`, `width` pixels across (one per channel).
 * Inside = 255; feather softens the edge, expand grows or shrinks the shape, invert swaps them.
 */
export function maskCoverage(places: ReturnType<typeof maskPlaces>, aspect: number, width: number): { w: number; h: number; data: Uint8Array } {
  const w = Math.max(16, Math.round(width)), h = Math.max(16, Math.round(width / aspect));
  if (!scratch) scratch = { a: new OffscreenCanvas(w, h), b: new OffscreenCanvas(w, h) };
  const { a, b } = scratch;
  for (const c of [a, b]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ca = a.getContext('2d')!, cb = b.getContext('2d', { willReadFrequently: true })!;
  const data = new Uint8Array(w * h * 4);
  places.slice(0, 4).forEach(({ mask, pose, centre }, i) => {
    ca.clearRect(0, 0, w, h);
    ca.fillStyle = '#fff';
    ca.strokeStyle = '#fff';
    ca.lineJoin = 'round';
    ca.beginPath();
    maskOutline(mask, pose, aspect, centre).forEach(([x, y], k) => (k ? ca.lineTo(x * w, y * h) : ca.moveTo(x * w, y * h)));
    ca.closePath();
    ca.globalCompositeOperation = 'source-over';
    ca.fill();
    const grow = pose.expand * h;
    if (grow > 0.05) { ca.lineWidth = grow * 2; ca.stroke(); }
    else if (grow < -0.05) { ca.globalCompositeOperation = 'destination-out'; ca.lineWidth = -grow * 2; ca.stroke(); ca.globalCompositeOperation = 'source-over'; }
    cb.clearRect(0, 0, w, h);
    const soft = pose.feather * h;
    cb.filter = soft > 0.05 ? `blur(${(soft / 2).toFixed(2)}px)` : 'none';
    cb.drawImage(a, 0, 0);
    cb.filter = 'none';
    const px = cb.getImageData(0, 0, w, h).data;
    for (let p = 0, q = i; p < px.length; p += 4, q += 4) { const v = px[p + 3]!; data[q] = mask.invert ? 255 - v : v; }
  });
  return { w, h, data };
}

/**
 * Gives a renderer the masks of `clip` at media time t (or none). `width`: coverage pixels across
 * (the preview uses fewer than export). Only redrawn when something about them changed.
 */
export function applyMasks(r: ReframeRenderer, clip: TimelineClip, media: Media | null, look: Look, t: number, width = 384) {
  const aspect = r.canvas.width / Math.max(1, r.canvas.height);
  const places = maskPlaces(clip, media, look, t, aspect);
  if (!places.length) { r.setMasks(null); return; }
  const key = `${width}|${aspect.toFixed(4)}|${places.map(({ mask, pose, centre }) => `${mask.id}:${mask.shape}:${mask.invert}:${mask.points?.join(';') ?? ''}:${Object.values(pose).map((v) => v.toFixed(4)).join(',')}:${centre.x.toFixed(4)},${centre.y.toFixed(4)}`).join('|')}`;
  const kinds = places.map((p) => KIND[p.mask.effect]), amounts = places.map((p) => p.pose.amount), colors = places.map((p) => hex(p.mask.color));
  // Colour masks (power windows): the grade inside each.
  const grades = places.map((p): [number, number, number, number] => { const g = p.mask.effect === 'grade' && p.mask.grade; return g ? [g.exposure, g.contrast, g.saturation, g.temperature] : [0, 0, 0, 0]; });
  const held = cache.get(r);
  if (held && held.key === key) { r.setMasks({ ...held.set, kinds, amounts, colors, grades }); return; }
  const cov = maskCoverage(places, aspect, width);
  const set: MaskSet = { width: cov.w, height: cov.h, coverage: cov.data, kinds, amounts, colors, grades, key };
  cache.set(r, { key, set });
  r.setMasks(set);
}

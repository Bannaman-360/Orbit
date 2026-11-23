// Matching the two lenses of a 360 clip: reads the strip both of them see.

import { useSyncExternalStore } from 'react';
import { matchLenses, ReframeRenderer, type LensMatch, type LensSample, type Rgb } from '@ace/media360';
import type { TimelineClip } from '@ace/project';
import { framesAt } from './calib';
import { inputFor } from './color';
import type { Media } from './media';

// --- Which lens is being edited, and whether to point it out in the preview -----------------------------
let ui: { lens: 'front' | 'back'; highlight: boolean } = { lens: 'back', highlight: false };
const subs = new Set<() => void>();
export const setLensUi = (p: Partial<typeof ui>) => { ui = { ...ui, ...p }; subs.forEach((f) => f()); };
export const lensUi = () => ui;
export const useLensUi = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => ui);

/** Two lenses recorded in two pictures: can be corrected one by one. */
export const hasTwoLenses = (m: Media | null | undefined) => !!m?.is360 && !!m.layout && !m.layout.equirect && m.tracks.length === 2;

const BW = 12, BH = 16;

/** What both lenses see of the same places, at some moments. */
export async function lensSamples(media: Media, clip: Pick<TimelineClip, 'inputColor' | 'wideColor'>, times: number[]): Promise<LensSample[]> {
  const L = media.layout!, W = L.streamWidth, H = L.streamHeight;
  const cv = new OffscreenCanvas(W, H), r = await ReframeRenderer.create(cv);
  const out: LensSample[] = [];
  try {
    for (const t of times) {
      const { frames, close } = await framesAt(media, t).catch(() => ({ frames: [] as VideoFrame[], close: () => {} }));
      for (const [s, frame] of frames.entries()) {
        r.resetHistory();
        r.pushFrame({ frames: [frame], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true, input: inputFor(media, clip, frame) });
        r.present({ blendFrames: 1, bypass: true });
        const bmp = await createImageBitmap(cv);
        for (const tile of L.tiles.filter((q) => q.stream === s && q.gap)) {
          const cut = tile.x + (tile.size + tile.gap!) / 2, over = Math.round((tile.gap! * 63) / 32), span = over * 2;
          const c = new OffscreenCanvas(span, H), x = c.getContext('2d', { willReadFrequently: true })!;
          x.drawImage(bmp, cut - over, 0, span, H, 0, 0, span, H);
          const d = x.getImageData(0, 0, span, H).data;
          const block = (x0: number, y0: number): { mean: Rgb; dev: number } => {
            const m: Rgb = [0, 0, 0];
            let l = 0, ll = 0;
            for (let j = 0; j < BH; j++) for (let i = 0; i < BW; i++) {
              const k = ((y0 + j) * span + x0 + i) * 4, y = 0.2126 * d[k]! + 0.7152 * d[k + 1]! + 0.0722 * d[k + 2]!;
              for (let q = 0; q < 3; q++) m[q]! += d[k + q]!;
              l += y;
              ll += y * y;
            }
            const n = BW * BH;
            return { mean: m.map((v) => v / n / 255) as Rgb, dev: Math.sqrt(Math.max(0, ll / n - (l / n) ** 2)) / 255 };
          };
          // Left of the cut is the near half; the same place is `over` pixels to the right.
          const nearFront = tile.right[2] < 0;
          for (let y = 8; y + BH < H - 8; y += BH) for (let o = 3; o + BW <= over - 3; o += BW + 4) {
            const a = block(o, y), b = block(o + over, y);
            out.push(nearFront ? { front: a.mean, back: b.mean, busy: [a.dev, b.dev] } : { front: b.mean, back: a.mean, busy: [b.dev, a.dev] });
          }
        }
        bmp.close();
      }
      close();
    }
  } finally {
    r.destroy();
  }
  return out;
}

/** Corrections that make a clip's lenses alike (null: too little to go by). */
export async function matchClipLenses(media: Media, clip: TimelineClip, mediaUs: number, which?: 'front' | 'back'): Promise<LensMatch | null> {
  const span = clip.outUs - clip.inUs;
  const times = [mediaUs, ...[0.08, 0.25, 0.42, 0.58, 0.75, 0.92].map((f) => clip.inUs + span * f)].map((t) => Math.max(0, Math.min(media.durationUs - 100_000, t)));
  return matchLenses(await lensSamples(media, clip, times), which);
}

import { describe, expect, it } from 'vitest';
import { canUpscale, enhancedSize, enhanceKey, framesPerGap, smoothFactor } from './enhance';
import { newClip } from './timeline';

const S = 1e6;
const clip = (speed: number) => ({ ...newClip('a.mp4', 10 * S, false), speed });

describe('AI improvements', () => {
  it('smooth slow motion makes enough frames for the slowest part', () => {
    expect(smoothFactor(clip(1))).toBe(1);
    expect(smoothFactor(clip(0.5))).toBe(2);
    expect(smoothFactor(clip(0.25))).toBe(4);
    expect(smoothFactor(clip(0.3))).toBe(4);
    expect(smoothFactor(clip(0.05))).toBe(8);
  });

  it('only where the clip plays slowly', () => {
    const c = { ...clip(1), speedKeys: [{ id: 'a', t: 0, speed: 1, ease: 'linear' as const }, { id: 'b', t: 4 * S, speed: 1, ease: 'linear' as const }, { id: 'c', t: 4.5 * S, speed: 0.25, ease: 'linear' as const }, { id: 'd', t: 8 * S, speed: 0.25 }] };
    expect(smoothFactor(c)).toBe(4);
    const times = Array.from({ length: 300 }, (_, i) => (i * S) / 30);
    const n = framesPerGap(c, times);
    expect(n[30]).toBe(1);
    expect(n[150]).toBe(4);
    expect(n.every((x) => x >= 1 && x <= 4)).toBe(true);
  });

  it('upscaled sizes stay within 4K and even', () => {
    expect(enhancedSize(1280, 720, { upscale: 2 })).toEqual({ w: 2560, h: 1440, scale: 2 });
    expect(enhancedSize(1280, 720, { upscale: 4 })).toEqual({ w: 3840, h: 2160, scale: 3 });
    expect(enhancedSize(1920, 1080, { upscale: 4 }).w).toBe(3840);
    expect(canUpscale(3840, 2160)).toBe(false);
    expect(canUpscale(1920, 1080)).toBe(true);
  });

  it('a copy is made again only when what it depends on changes', () => {
    const a = { ...clip(0.5), enhance: { smooth: true } };
    expect(enhanceKey(a)).toBe(enhanceKey({ ...a, look: { ...a.look, yaw: 30 } }));
    expect(enhanceKey(a)).not.toBe(enhanceKey({ ...a, speed: 0.25 }));
    expect(enhanceKey(a)).not.toBe(enhanceKey({ ...a, outUs: 5 * S }));
    expect(enhanceKey({ ...a, enhance: { upscale: 2 } })).toBe(enhanceKey({ ...a, speed: 0.3, enhance: { upscale: 2 } }));
  });
});

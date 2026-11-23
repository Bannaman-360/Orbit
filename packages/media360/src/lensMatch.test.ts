import { describe, expect, it } from 'vitest';
import { lensAdjusted, lensColor, lensUniforms, matchLenses, type LensAdjust, type LensSample } from './lensMatch';
import type { Rgb } from './inputColor';

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const scene = (n: number): Rgb[] => Array.from({ length: n }, () => { const l = 0.06 + 0.8 * rnd(); return [l * (0.75 + 0.5 * rnd()), l * (0.75 + 0.5 * rnd()), l * (0.75 + 0.5 * rnd())].map((v) => Math.min(0.95, v)) as Rgb; });
/** A dirty lens: a veil of light, dimmer, tinted. */
const fog = (c: Rgb, veil: number, dim: number, tint: Rgb = [1, 1, 1]): Rgb => c.map((v, i) => (1 - veil) * v * dim * tint[i]! + veil) as Rgb;
const pair = (f: Rgb, b: Rgb, noise = 0): LensSample => ({ front: f.map((v) => v + noise * (rnd() - 0.5)) as Rgb, back: b.map((v) => v + noise * (rnd() - 0.5)) as Rgb, busy: [0.05, 0.05] });

describe('lens corrections', () => {
  it('nothing set changes nothing', () => {
    for (const c of scene(50)) lensColor(c, {}).forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 9));
    expect(lensAdjusted({})).toBe(false);
    expect(lensAdjusted({ haze: 0 })).toBe(false);
    expect(lensUniforms(undefined)).toEqual(new Array(16).fill(0));
  });
  it('each does what it says', () => {
    const c: Rgb = [0.4, 0.5, 0.45];
    expect(lensColor(c, { brightness: 1 })[1]).toBeCloseTo((0.5 ** 2.2 * 2) ** (1 / 2.2), 6);
    expect(lensColor(c, { warmth: 0.5 })[0]).toBeGreaterThan(c[0]);
    expect(lensColor(c, { warmth: 0.5 })[2]).toBeLessThan(c[2]);
    expect(lensColor([0.2, 0.2, 0.2], { haze: 0.5 })[0]).toBeLessThan(0.2);
    const s = lensColor(c, { saturation: -1 });
    expect(Math.max(...s) - Math.min(...s)).toBeLessThan(1e-9);
    // Taking haze away and adding it undo each other, near enough.
    const h = lensColor(lensColor(c, { haze: -0.4 }), { haze: 0.4 });
    h.forEach((v, i) => expect(Math.abs(v - c[i]!)).toBeLessThan(0.02));
  });
});

describe('automatic matching', () => {
  it('clears a fogged back lens', () => {
    const s = scene(400).map((c) => pair(c, fog(c, 0.16, 0.9), 0.02));
    const m = matchLenses(s)!;
    expect(m.lens).toBe('back');
    expect(m.adjust.haze!).toBeGreaterThan(0.2);
    expect(m.after).toBeLessThan(m.before * 0.3);
  });
  it('works for the front lens too, with a colour cast', () => {
    const s = scene(400).map((c) => pair(fog(c, 0.1, 0.85, [1, 0.97, 0.9]), c, 0.02));
    const m = matchLenses(s)!;
    expect(m.lens).toBe('front');
    expect(m.after).toBeLessThan(m.before * 0.35);
  });
  it('can be told which lens to change', () => {
    const s = scene(300).map((c) => pair(c, fog(c, 0.1, 0.9)));
    expect(matchLenses(s, 'front')!.lens).toBe('front');
  });
  it('is not led astray by near things that don’t match', () => {
    const s = scene(400).map((c, i) => (i % 4 ? pair(c, fog(c, 0.14, 0.95), 0.02) : pair(c, scene(1)[0]!)));
    const m = matchLenses(s, 'back')!;
    const good = s.filter((_, i) => i % 4).map((x) => x);
    const err = good.map((x) => { const q = lensColor(x.back, m.adjust); return q.reduce((e, v, k) => e + Math.abs(v - x.front[k]!), 0) / 3; }).sort((a, b) => a - b);
    expect(err[err.length >> 1]!).toBeLessThan(0.02);
  });
  it('leaves matching lenses alone', () => {
    const m = matchLenses(scene(300).map((c) => pair(c, c, 0.02)))!;
    for (const k of ['brightness', 'haze', 'contrast', 'warmth', 'tint', 'saturation'] as (keyof LensAdjust)[]) expect(Math.abs(m.adjust[k] ?? 0)).toBeLessThan(0.08);
  });
  it('says so when there is too little to go by', () => expect(matchLenses(scene(10).map((c) => pair(c, c)))).toBeNull());
});

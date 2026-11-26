import { describe, expect, it } from 'vitest';
import { bestHighlights, findHighlights, mergeHighlights, type Highlight } from './highlights';
import { hilightTags } from './gpmf-klv';
import { TelemetrySeries, type GpsSample } from './metrics';

/** One KLV item: key, type, struct size, repeat, data (padded to 4 bytes). */
function klv(key: string, type: string | 0, size: number, repeat: number, data: Uint8Array): Uint8Array {
  const len = size * repeat, out = new Uint8Array(8 + ((len + 3) & ~3));
  for (let i = 0; i < 4; i++) out[i] = key.charCodeAt(i);
  out[4] = type === 0 ? 0 : type.charCodeAt(0);
  out[5] = size;
  new DataView(out.buffer).setUint16(6, repeat);
  out.set(data.subarray(0, len), 8);
  return out;
}
const join = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const text = (s: string) => new TextEncoder().encode(s);
const u32 = (...v: number[]) => { const b = new Uint8Array(v.length * 4); v.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x)); return b; };

describe('HiLight tags', () => {
  it('reads the HLMT device of the settings block (HERO6 and later, Max)', () => {
    // Laid out as in a HERO7 file: 36-byte structs, time in ms first, then in/out, place, "MANL".
    const tag = (ms: number) => join(u32(ms, ms, ms, 0, 0, 0), text('MANL'), u32(0x42c80000, 0x42c80000));
    const inner = join(klv('TYPE', 'c', 9, 1, text('LLLllfFff')), klv('HLMT', '?', 36, 3, join(tag(800), tag(4720), tag(8480))));
    const dev = join(klv('DVID', 'F', 4, 1, text('HLMT')), klv('DVNM', 'c', 10, 1, text('Highlights')), klv('STRM', 0, 1, inner.length, inner));
    const block = join(klv('DEVC', 0, 1, 16, join(klv('MINF', 'c', 8, 1, text('HERO7 Bl')))), klv('DEVC', 0, 1, dev.length, dev));
    expect(hilightTags(block)).toEqual([800_000, 4_720_000, 8_480_000]);
  });
  it('reads the HMMT box of older cameras, and leaves empty slots out', () => {
    expect(hilightTags(null, u32(2, 12_000, 30_500, 0, 0))).toEqual([12_000_000, 30_500_000]);
    expect(hilightTags(null, u32(0, 0, 0))).toEqual([]);
  });
  it('a file with no tags (the Max writes an empty HLMT device) has none', () => {
    const dev = join(klv('DVID', 'F', 4, 1, text('HLMT')), klv('DVNM', 'c', 10, 1, text('Highlights')));
    expect(hilightTags(klv('DEVC', 0, 1, dev.length, dev))).toEqual([]);
  });
  it('the same tag in both places counts once', () => {
    const dev = join(klv('DVID', 'F', 4, 1, text('HLMT')), klv('MANL', 'L', 4, 1, u32(5000)));
    expect(hilightTags(klv('DEVC', 0, 1, dev.length, dev), u32(1, 5000))).toEqual([5_000_000]);
  });
});

const RATE = 200;
/** A ride: G series with given stretches, and a GPS speed series. */
function ride(seconds: number, parts: { at: number; len: number; g: number }[], speed: (s: number) => number) {
  const n = seconds * RATE, accl: { t: number; v: [number, number, number] }[] = [];
  for (let i = 0; i < n; i++) {
    const s = i / RATE;
    let g = 1 + 0.2 * Math.sin(s * 3);
    for (const p of parts) if (s >= p.at && s < p.at + p.len) g = p.g;
    accl.push({ t: s * 1e6, v: [0, 0, g * 9.80665] });
  }
  const gps: GpsSample[] = [];
  for (let s = 0; s < seconds; s += 0.1) gps.push({ t: s * 1e6, lat: 46 + s * 1e-5, lon: 7, alt: 500, speed: speed(s), fix: 3 });
  return new TelemetrySeries(gps, accl);
}

describe('highlights', () => {
  const tm = ride(120, [
    { at: 20, len: 0.8, g: 0.05 }, { at: 20.8, len: 0.15, g: 3.5 }, // a jump
    { at: 60, len: 0.06, g: 6 }, // a hard hit
    { at: 100, len: 0.3, g: 0.1 }, { at: 100.3, len: 0.15, g: 5.5 }, // a small jump with a hard landing (not a hit)
  ], (s) => 6 + 6 * Math.exp(-(((s - 80) / 4) ** 2)));
  const h = tm.highlights(120e6, [40e6]);

  it('finds the tag, the jumps, the top speed and the hard hit, in time order', () => {
    expect(h.map((x) => x.kind)).toEqual(['jump', 'tag', 'hit', 'speed', 'jump']);
    expect(Math.abs(h[0]!.t - 20e6)).toBeLessThan(30_000);
    expect(h[1]!.t).toBe(40e6);
    expect(Math.abs(h[2]!.t - 60e6)).toBeLessThan(100_000);
    expect(h[2]!.g).toBeGreaterThan(5);
    expect(Math.abs(h[3]!.t - 80e6)).toBeLessThan(300_000);
    expect(h[3]!.speedMs).toBeCloseTo(12, 0);
  });
  it('shows a little before and after each moment, more before a tag', () => {
    const tag = h[1]!;
    expect(tag.fromUs).toBe(33e6);
    expect(tag.toUs).toBe(42e6);
    const j = h[0]!;
    expect(j.fromUs).toBeLessThan(j.jump!.startUs - 2e6);
    expect(j.toUs).toBeGreaterThan(j.jump!.endUs + 1.5e6);
  });
  it('a landing is part of its jump, not a hard hit', () => {
    expect(h.filter((x) => x.kind === 'hit')).toHaveLength(1);
  });
  it('a calm ride has no speed highlight', () => {
    const calm = ride(60, [], () => 2);
    expect(calm.highlights(60e6)).toEqual([]);
  });
  it('a file with only tags (no ride data) still has them', () => {
    expect(new TelemetrySeries().highlights(30e6, [5e6, 29.5e6]).map((x) => [x.fromUs, x.toUs])).toEqual([[0, 7e6], [22.5e6, 30e6]]);
  });
  it('moments that overlap become one, named after the strongest, and score higher', () => {
    const a: Highlight = { t: 10e6, fromUs: 7e6, toUs: 13e6, kind: 'speed', also: [], score: 0.6, speedMs: 12 };
    const b: Highlight = { t: 11e6, fromUs: 4e6, toUs: 13e6, kind: 'tag', also: [], score: 1 };
    const c: Highlight = { t: 30e6, fromUs: 27e6, toUs: 33e6, kind: 'hit', also: [], score: 0.4, g: 5 };
    const m = mergeHighlights([a, c, b]);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ kind: 'tag', also: ['speed'], fromUs: 4e6, toUs: 13e6, speedMs: 12, score: 1 });
    expect(m[1]!.kind).toBe('hit');
  });
  it('picks the best few, kept in time order', () => {
    const best = bestHighlights(h, 2);
    expect(best.map((x) => x.kind)).toEqual(['jump', 'tag']);
    expect(findHighlights({ durationUs: 10e6 })).toEqual([]);
  });
});

describe('highlights close together', () => {
  it('jumps a few seconds apart stay apart, sharing out the picture between them', () => {
    const jump = (at: number): Highlight => ({ t: at * 1e6, fromUs: (at - 2.5) * 1e6, toUs: (at + 2.6) * 1e6, kind: 'jump', also: [], score: 0.6, jump: { startUs: at * 1e6, endUs: (at + 0.6) * 1e6, airMs: 600, landingG: 3 } });
    const m = mergeHighlights([jump(10), jump(14), jump(18)]);
    expect(m).toHaveLength(3);
    for (let i = 1; i < m.length; i++) expect(m[i]!.fromUs).toBeGreaterThanOrEqual(m[i - 1]!.toUs);
    expect(m[0]!.toUs).toBe(12.3e6); // half way between landing (10.6 s) and the next takeoff (14 s)
    expect(m[1]!.fromUs).toBe(12.3e6);
    expect(m.every((h) => h.fromUs <= h.t && h.toUs >= h.jump!.endUs)).toBe(true);
  });
});

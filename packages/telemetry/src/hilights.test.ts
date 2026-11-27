import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hilightTags } from './gpmf-klv';

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


// A settings block from a real HERO7 with three tags, shipped with the gopro-telemetry package.
const SAMPLE = new URL('../../../node_modules/.pnpm/gopro-telemetry@1.2.11/node_modules/gopro-telemetry/samples/mp4header.raw', import.meta.url);
describe.skipIf(!existsSync(SAMPLE))('HiLight tags in a real file', () => {
  it('reads the three tags of a HERO7 file', () => {
    expect(hilightTags(new Uint8Array(readFileSync(SAMPLE)))).toEqual([800_000, 4_720_000, 8_480_000]);
  });
});

import { describe, expect, it } from 'vitest';
import { skipPerSampleTracks, topLevelBoxes } from './source';

/** A box: 4-byte size, 4-letter type, then the body. */
function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const len = 8 + body.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  let at = 8;
  for (const b of body) { out.set(b, at); at += b.length; }
  return out;
}
const u32 = (...v: number[]) => { const b = new Uint8Array(v.length * 4); v.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x)); return b; };
/** stsz: version/flags, sample size, count. */
const stsz = (size: number, count: number) => box('stsz', u32(0, size, count));
const trak = (size: number, count: number) => box('trak', box('mdia', box('minf', box('stbl', stsz(size, count)))));
const typeAt = (b: Uint8Array, at: number) => String.fromCharCode(...b.slice(at + 4, at + 8));

describe('reading a file’s index', () => {
  it('finds the top-level boxes, including a 64-bit sized one', () => {
    const ftyp = box('ftyp', new Uint8Array(12));
    // A 64-bit "mdat" header (size 1, then the real size) with 8 bytes of data.
    const mdat = new Uint8Array(24);
    new DataView(mdat.buffer).setUint32(0, 1);
    mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
    new DataView(mdat.buffer).setBigUint64(8, 24n);
    const moov = box('moov', box('mvhd', new Uint8Array(4)));
    const file = new Uint8Array([...ftyp, ...mdat, ...moov]);
    const reader = { size: file.length, read: async (o: number, n: number) => file.slice(o, o + n) };
    return topLevelBoxes(reader).then((b) => {
      expect(b.map((x) => x.type)).toEqual(['ftyp', 'mdat', 'moov']);
      expect(b[2]).toEqual({ type: 'moov', offset: ftyp.length + 24, size: moov.length });
    });
  });
  it('stops at a box cut off by the end of the file', async () => {
    const whole = box('ftyp', new Uint8Array(12));
    const cut = box('mdat', new Uint8Array(100)).slice(0, 50);
    const file = new Uint8Array([...whole, ...cut]);
    const b = await topLevelBoxes({ size: file.length, read: async (o, n) => file.slice(o, o + n) });
    expect(b.map((x) => x.type)).toEqual(['ftyp']);
  });
  it('hides tracks listed one tiny sample at a time, keeps the rest', () => {
    const video = trak(0, 13845), pcm = trak(12, 22_172_672), aac = trak(0, 21653);
    const moov = box('moov', box('mvhd', new Uint8Array(4)), video, pcm, aac);
    skipPerSampleTracks(moov);
    const at = [8 + 12, 8 + 12 + video.length, 8 + 12 + video.length + pcm.length];
    expect(at.map((a) => typeAt(moov, a))).toEqual(['trak', 'free', 'trak']);
  });
});

import { describe, expect, it } from 'vitest';
import { equirectXml, isEquirect } from './spherical';

const box = (type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const body = parts.flatMap((p) => [...p]);
  const n = body.length + 8;
  return Uint8Array.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body]);
};
const reader = (d: Uint8Array) => ({ size: d.length, read: async (o: number, n: number) => d.slice(o, o + n) });
const zeros = (n: number) => Array(n).fill(0) as number[];
const uuid = [0xff, 0xcc, 0x82, 0x63, 0xf8, 0x55, 0x4a, 0x93, 0x88, 0x14, 0x58, 0x7a, 0x02, 0x52, 0x1f, 0xdd];
const xml = (extra = '', type = 'equirectangular') => `<rdf:SphericalVideo><GSpherical:Spherical>true</GSpherical:Spherical><GSpherical:ProjectionType>${type}</GSpherical:ProjectionType>${extra}</rdf:SphericalVideo>`;
const v1 = (text: string) => box('moov', box('mvhd', zeros(8)), box('trak', box('tkhd', zeros(8)), box('uuid', uuid, new TextEncoder().encode(text))));
const v2 = (crop: number[], type = 'equi') => box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', zeros(8), box('hvc1', zeros(78), box('sv3d', box('proj', box(type, zeros(4), crop))))))))));

describe('stitched 360 in an MP4', () => {
  it('reads tags', () => {
    expect(equirectXml(xml())).toBe(true);
    expect(equirectXml(xml('', 'cubemap'))).toBe(false);
    expect(equirectXml(xml('<GSpherical:StereoMode>top-bottom</GSpherical:StereoMode>'))).toBe(false);
    expect(equirectXml(xml('<GSpherical:StereoMode>mono</GSpherical:StereoMode>'))).toBe(true);
    expect(equirectXml(xml('<GSpherical:CroppedAreaImageWidthPixels>100</GSpherical:CroppedAreaImageWidthPixels><GSpherical:FullPanoWidthPixels>200</GSpherical:FullPanoWidthPixels>'))).toBe(false);
    expect(equirectXml('<x/>')).toBe(false);
  });
  it('finds both kinds of tag in a file', async () => {
    expect(await isEquirect(reader(Uint8Array.from([...box('ftyp', zeros(4)), ...v1(xml())])))).toBe(true);
    expect(await isEquirect(reader(v1('<x/>')))).toBe(false);
    expect(await isEquirect(reader(v2(zeros(16))))).toBe(true);
    expect(await isEquirect(reader(v2([0, 0, 1, 0, ...zeros(12)])))).toBe(false);
    expect(await isEquirect(reader(v2(zeros(16), 'cbmp')))).toBe(false);
    expect(await isEquirect(reader(box('moov', box('trak', box('tkhd', zeros(8))))))).toBe(false);
  });
});

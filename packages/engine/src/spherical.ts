// Whether an ordinary MP4 holds a stitched 360 picture: Google's spherical video tags, as written
// by GoPro's cloud and most 360 software. (V1: XML in the video track; V2: an 'sv3d' box.)

import { boxes, findBox } from './boxes';
import type { ByteReader } from './source';

const V1 = 'ffcc8263f8554a938814587a02521fdd';

/** Whether V1 XML describes a full, plain (not 3D) equirectangular sphere. */
export function equirectXml(xml: string): boolean {
  const tag = (n: string) => new RegExp(`GSpherical:${n}\\s*(?:>|=\\s*["'])\\s*([^<"']*)`, 'i').exec(xml)?.[1]?.trim().toLowerCase();
  if (tag('Spherical') !== 'true') return false;
  if ((tag('ProjectionType') ?? 'equirectangular') !== 'equirectangular') return false;
  if (!['mono', '', undefined].includes(tag('StereoMode'))) return false;
  const num = (n: string) => Number(tag(n));
  const full = (part: string, all: string) => !(num(part) > 0 && num(all) > 0) || num(part) === num(all);
  return full('CroppedAreaImageWidthPixels', 'FullPanoWidthPixels') && full('CroppedAreaImageHeightPixels', 'FullPanoHeightPixels');
}

export async function isEquirect(reader: ByteReader): Promise<boolean> {
  const moov = await findBox(reader, { from: 0, to: reader.size }, 'moov');
  if (!moov) return false;
  for await (const trak of boxes(reader, moov.from, moov.to)) {
    if (trak.type !== 'trak') continue;
    for await (const b of boxes(reader, trak.from, trak.to)) {
      if (b.type !== 'uuid' || b.to - b.from < 16 || b.to - b.from > 65536) continue;
      const d = await reader.read(b.from, b.to - b.from);
      if ([...d.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('') === V1) return equirectXml(new TextDecoder().decode(d.subarray(16)));
    }
    const stsd = await findBox(reader, trak, 'mdia', 'minf', 'stbl', 'stsd');
    if (!stsd) continue;
    for await (const entry of boxes(reader, stsd.from + 8, stsd.to)) {
      // (A video sample entry's own fields take 78 bytes.)
      const inside = { from: entry.from + 78, to: entry.to };
      const equi = await findBox(reader, inside, 'sv3d', 'proj', 'equi');
      if (!equi) continue;
      const d = await reader.read(equi.from, Math.min(20, equi.to - equi.from));
      const st3d = await findBox(reader, inside, 'st3d');
      const stereo = st3d ? (await reader.read(st3d.from, 5))[4] : 0;
      // Nothing cut off at the top, bottom, left or right.
      return !stereo && d.subarray(4, 20).every((x) => x === 0);
    }
  }
  return false;
}

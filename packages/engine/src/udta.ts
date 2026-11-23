// The camera's own settings block in an MP4 (moov/udta/GPMF).

import { findBox } from './boxes';
import type { ByteReader } from './source';

const SMALL = 256 * 1024;

export async function readUserData(reader: ByteReader, box = 'GPMF'): Promise<Uint8Array | null> {
  const data = await findBox(reader, { from: 0, to: reader.size }, 'moov', 'udta', box);
  if (!data || data.to - data.from > SMALL) return null;
  return reader.read(data.from, data.to - data.from);
}

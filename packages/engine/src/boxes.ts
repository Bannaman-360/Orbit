// Walks MP4 box headers with small reads, so even a huge file costs next to nothing.

import type { ByteReader } from './source';

export interface Box { type: string; /** Content, without the header. */ from: number; to: number }

export async function* boxes(reader: ByteReader, from: number, to: number): AsyncGenerator<Box> {
  let pos = from;
  for (let n = 0; n < 4096 && pos + 8 <= to; n++) {
    const b = await reader.read(pos, 16);
    if (b.length < 8) return;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let size = dv.getUint32(0), head = 8;
    if (size === 1 && b.length >= 16) { size = Number(dv.getBigUint64(8)); head = 16; }
    if (size === 0) size = to - pos;
    if (size < head) return;
    yield { type: String.fromCharCode(b[4]!, b[5]!, b[6]!, b[7]!), from: pos + head, to: Math.min(to, pos + size) };
    pos += size;
  }
}

export async function findBox(reader: ByteReader, within: { from: number; to: number } | null, ...path: string[]): Promise<Box | null> {
  let at = within as Box | null;
  for (const type of path) {
    let hit: Box | null = null;
    if (at) for await (const b of boxes(reader, at.from, at.to)) if (b.type === type) { hit = b; break; }
    at = hit;
    if (!at) return null;
  }
  return at;
}

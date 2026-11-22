// Parser for Adobe/Resolve .cube 3D LUTs.

import type { Lut3D } from './renderer';

export function parseCube(text: string): Lut3D {
  let size = 0;
  let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    if (key === 'TITLE') continue;
    if (key === 'LUT_3D_SIZE') { size = parseInt(parts[1]!, 10); continue; }
    if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported, use a 3D .cube LUT');
    if (key === 'DOMAIN_MIN') { domainMin = parts.slice(1, 4).map(Number); continue; }
    if (key === 'DOMAIN_MAX') { domainMax = parts.slice(1, 4).map(Number); continue; }
    if (/^[-+0-9.eE]/.test(parts[0]!) && parts.length >= 3) values.push(+parts[0]!, +parts[1]!, +parts[2]!);
  }
  if (size < 2 || size > 128) throw new Error('Missing or invalid LUT_3D_SIZE');
  if (values.length !== size * size * size * 3) throw new Error(`Expected ${size ** 3} entries, found ${values.length / 3}`);
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    data[i] = (values[i]! - domainMin[c]!) / (domainMax[c]! - domainMin[c]! || 1);
  }
  return { size, data };
}

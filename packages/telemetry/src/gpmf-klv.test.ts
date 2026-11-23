import { describe, expect, it } from 'vitest';
import { cameraInfo, parseKlv } from './gpmf-klv';

const klv = (key: string, type: string, size: number, data: number[]) => {
  const n = data.length / size, pad = (4 - (data.length % 4)) % 4;
  return [...key].map((c) => c.charCodeAt(0)).concat([type ? type.charCodeAt(0) : 0, size, n >> 8, n & 255], data, Array(pad).fill(0));
};
const txt = (s: string) => [...s].map((c) => c.charCodeAt(0));
const f32 = (v: number) => [...new Uint8Array(new DataView(new ArrayBuffer(4)).buffer)].map((_, i) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v); return d.getUint8(i); });
const f64 = (v: number) => Array.from({ length: 8 }, (_, i) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); return d.getUint8(i); });

describe('GPMF settings', () => {
  const body = [
    ...klv('MINF', 'c', 1, txt('HERO12 Black')), ...klv('SROT', 'f', 4, f32(15.5)), ...klv('EISE', 'c', 1, txt('Y')),
    ...klv('PTCL', 'c', 1, txt('LOG')), ...klv('VFOV', 'c', 1, txt('W')), ...klv('ZFOV', 'f', 4, f32(150)), ...klv('VFPS', 'L', 4, [0, 0, 0xea, 0x60, 0, 0, 3, 0xe9]),
  ];
  const lens = [...klv('DVID', 'F', 4, txt('FRNT')), ...klv('KLNS', 'd', 8, [...f64(1300), ...f64(97)])];
  const file = new Uint8Array([...klv('DEVC', '', 1, body), ...klv('DEVC', '', 1, lens)]);
  it('reads nested settings of every kind', () => {
    const c = cameraInfo(parseKlv(file));
    expect(c).toMatchObject({ model: 'HERO12 Black', stabilizedInCamera: true, colorProfile: 'LOG', fovMode: 'W', lenses: { FRNT: [1300, 97] } });
    expect(c.readoutMs).toBeCloseTo(15.5);
    expect(c.diagonalFov).toBeCloseTo(150);
    expect(c.fps).toBeCloseTo(59.94, 1);
  });
  it('survives damage and padding', () => {
    for (let cut = 0; cut < file.length; cut += 3) expect(() => cameraInfo(parseKlv(file.subarray(0, cut)))).not.toThrow();
    expect(cameraInfo(parseKlv(new Uint8Array(64)))).toEqual({});
  });
});

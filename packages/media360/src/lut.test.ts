import { describe, expect, it } from 'vitest';
import { parseCube } from './lut';

const identity2 = `TITLE "id"
# comment
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('.cube parser', () => {
  it('reads a 3D LUT', () => {
    const l = parseCube(identity2);
    expect(l.size).toBe(2);
    expect(Array.from(l.data.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it('rescales a custom domain', () => {
    const l = parseCube(identity2.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2'));
    expect(l.data[3]).toBe(0.5);
  });

  it('rejects broken files', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow();
    expect(() => parseCube('LUT_1D_SIZE 4')).toThrow();
  });
});

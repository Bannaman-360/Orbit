import { describe, expect, it } from 'vitest';
import { browserSees, convertInput, hlgDecode, highRange, inputUniforms, LOG_BASE, LOG_EV, logDecode, logEncode, needsConversion, PLAIN_INPUT, rec709Encode, recorded, shoulder, srgbDecode, srgbEncode, type InputColor, type Rgb } from './inputColor';

const near = (a: Rgb, b: Rgb, tol: number) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(tol));
const colours: Rgb[] = [[0, 0, 0], [0.02, 0.02, 0.02], [0.18, 0.18, 0.18], [0.5, 0.2, 0.1], [0.1, 0.7, 0.3], [0.05, 0.1, 0.9], [1, 1, 1], [0.9, 0.1, 0.1]];

describe('undoing the browser', () => {
  it('gets the recorded values back, wide colours included', () => {
    for (const gamma of [0, 1, 1.961, 2.2]) for (const browserWide of [false, true]) for (const c of colours) near(recorded(browserSees(c, { gamma, browserWide }), { gamma, browserWide, rangeFix: false }), c, 2e-3);
  });
  it('matches what was measured on this Mac (Rec.709 as γ 1.961)', () => {
    for (const [code, seen] of [[0.2192, 0.2502], [0.5114, 0.555], [0.8037, 0.8274], [0.9543, 0.9605]]) near(browserSees([code!, code!, code!], { gamma: 1.961, browserWide: false }), [seen!, seen!, seen!], 2e-3);
    // HLG is passed on as if it were light.
    for (const [code, seen] of [[0.2192, 0.506], [0.5114, 0.7418], [0.8037, 0.9083]]) near(browserSees([code!, code!, code!], { gamma: 1, browserWide: true }), [seen!, seen!, seen!], 2e-3);
  });
  it('puts full-range values back that were read as video range', () => {
    // Y, Cb, Cr full range 8 bit → what a video-range decoder makes of it.
    for (const c of colours) {
      const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], cb = (c[2] - y) / 1.8556, cr = (c[0] - y) / 1.5748;
      const Y = (y * 255 - 16) / 219, B = (cb * 255) / 224, R = (cr * 255) / 224;
      const wrong: Rgb = [Y + 1.5748 * R, Y - 0.1873 * B - 0.4681 * R, Y + 1.8556 * B];
      near(recorded(wrong, { gamma: 0, browserWide: false, rangeFix: true }), c, 2e-3);
    }
  });
});

describe('curves', () => {
  it('log curves go both ways and match the published samples', () => {
    for (const b of [113, 400, 600]) for (let v = 0; v <= 1; v += 0.05) expect(logEncode(logDecode(v, b), b)).toBeCloseTo(v, 9);
    for (const [l, v] of [[0.0517, 0.542], [0.25, 0.784], [0.5, 0.892], [1, 1]]) expect(Math.abs(logEncode(l!, LOG_BASE.gplog2) - v!)).toBeLessThan(0.002);
    // Colour-science's check value for Protune.
    expect(logEncode(0.18, LOG_BASE.flat)).toBeCloseTo(0.6456234, 6);
  });
  it('GP-Log2 mid grey lands where Rec.709 has it', () => {
    const i: InputColor = { ...PLAIN_INPUT, curve: 'log', base: 600, gain: 2 ** LOG_EV };
    near(convertInput([0.542, 0.542, 0.542], i), [rec709Encode(0.18), rec709Encode(0.18), rec709Encode(0.18)], 0.005);
  });
  it('HLG: reference white becomes white, its knee is continuous', () => {
    expect(hlgDecode(0.5)).toBeCloseTo(1 / 12, 6);
    expect(Math.abs(hlgDecode(0.5) - hlgDecode(0.500001))).toBeLessThan(1e-5);
    near(convertInput([0.75, 0.75, 0.75], { ...PLAIN_INPUT, curve: 'hlg', outGamma: 1.961 }), [1, 1, 1], 0.006);
  });
  it('wide colours come back as the Rec.709 colour they were', () => {
    const M = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.088, 0.8956]];
    for (const c of colours) {
      const w = M.map((r) => r[0]! * c[0] + r[1]! * c[1] + r[2]! * c[2]) as Rgb;
      const v = w.map((x) => logEncode(x, 400)) as Rgb;
      near(convertInput(v, { ...PLAIN_INPUT, curve: 'log', base: 400, gain: 1, wide: true }), c.map(rec709Encode) as Rgb, 0.012);
    }
  });
  it('sRGB both ways', () => { for (let v = -1; v <= 2; v += 0.1) expect(srgbDecode(srgbEncode(v))).toBeCloseTo(v, 6); });
});

describe('ordinary clips', () => {
  it('are left exactly alone', () => {
    expect(needsConversion({ ...PLAIN_INPUT, gamma: 1.961, outGamma: 1.961 })).toBe(false);
    expect(inputUniforms({ ...PLAIN_INPUT, gamma: 1.961, outGamma: 1.961 }, 3)).toEqual(new Array(12).fill(0));
    expect(inputUniforms(undefined, 1)).toEqual(new Array(12).fill(0));
    expect(highRange(undefined)).toBe(false);
  });
  it('a preview copy that stores recorded values looks like the original', () => {
    for (const c of colours) near(convertInput(c, { ...PLAIN_INPUT, gamma: 0, outGamma: 1.961 }), browserSees(c, { gamma: 1.961, browserWide: false }), 1e-9);
  });
  it('highlights are eased, never reversed, never past white', () => {
    let last = -1;
    for (let x = 0; x < 3; x += 0.01) { const y = shoulder(x); expect(y).toBeGreaterThan(last); expect(y).toBeLessThanOrEqual(1); if (x <= 0.8) expect(y).toBe(x); last = y; }
  });
});

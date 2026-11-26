// Reads GoPro's key-length-value blocks (GPMF). Used for the camera settings stored once per
// file (moov/udta/GPMF): model, lens mode, readout time, stabilisation, colour profile.
// Pure: works on bytes, no Node or DOM.

export type KlvValue = string | number[];
export interface KlvNode { key: string; type: string; value: KlvValue; children?: KlvNode[] }

const SIZES: Record<string, number> = { b: 1, B: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, q: 4 };

/** Parses a GPMF payload. Damaged data stops the walk instead of throwing. */
export function parseKlv(bytes: Uint8Array, depth = 0): KlvNode[] {
  const out: KlvNode[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i + 8 <= bytes.length) {
    const key = String.fromCharCode(...bytes.subarray(i, i + 4));
    if (!/^[A-Za-z0-9_ ]{4}$/.test(key)) break; // padding or not GPMF
    const typeCode = bytes[i + 4]!, size = bytes[i + 5]!, repeat = dv.getUint16(i + 6);
    const len = size * repeat, start = i + 8;
    if (start + len > bytes.length) break;
    const data = bytes.subarray(start, start + len);
    i = start + ((len + 3) & ~3);
    if (typeCode === 0) {
      if (depth < 8) out.push({ key, type: '', value: [], children: parseKlv(data, depth + 1) });
      continue;
    }
    const type = String.fromCharCode(typeCode);
    if (type === 'c' || type === 'F' || type === 'U' || !SIZES[type]) {
      out.push({ key, type, value: new TextDecoder('latin1').decode(data).replace(/\0+$/g, '').trim() });
      continue;
    }
    const n = SIZES[type]!, v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const nums: number[] = [];
    for (let o = 0; o + n <= len; o += n)
      nums.push(
        type === 'b' ? v.getInt8(o) : type === 'B' ? v.getUint8(o) : type === 's' ? v.getInt16(o) : type === 'S' ? v.getUint16(o)
        : type === 'l' ? v.getInt32(o) : type === 'L' ? v.getUint32(o) : type === 'f' ? v.getFloat32(o) : type === 'd' ? v.getFloat64(o)
        : type === 'q' ? v.getInt32(o) / 65536 : Number(type === 'j' ? v.getBigInt64(o) : v.getBigUint64(o)),
      );
    out.push({ key, type, value: nums });
  }
  return out;
}

/** What the camera recorded about itself and the shot. Missing facts are undefined. */
export interface CameraInfo {
  model?: string;
  firmware?: string;
  /** Lens mode letter: W wide, L linear, S SuperView, N narrow, H HyperView… */
  fovMode?: string;
  /** Diagonal field of view, degrees. */
  diagonalFov?: number;
  /** Lens polynomial and scale as stored (meaning depends on the camera generation). */
  poly?: number[];
  polyScale?: number;
  aspectUnwarped?: number;
  aspectWarped?: number;
  /** SuperView / HyperView stretch: picture x, y → lens x, y (see GoProLens). */
  mapX?: number[];
  mapY?: number[];
  /** Max-style per-lens calibration: image radius = Σ kᵢ·θ^(2i+1), in calibration pixels. */
  lenses?: Record<string, number[]>;
  calibrationWidth?: number;
  /** Time the sensor takes to read one picture, ms (rolling shutter). */
  readoutMs?: number;
  /** The camera stabilised the picture while recording. */
  stabilizedInCamera?: boolean;
  stabilization?: string;
  /** 'FLAT', 'GOPRO', 'LOG'… */
  colorProfile?: string;
  fps?: number;
  digitalZoom?: boolean;
}

export function cameraInfo(nodes: KlvNode[]): CameraInfo {
  const out: CameraInfo = {};
  const walk = (list: KlvNode[], device: string) => {
    const dev = (list.find((n) => n.key === 'DVID')?.value ?? device) as string | number[];
    const name = typeof dev === 'string' ? dev : device;
    for (const n of list) {
      if (n.children) { walk(n.children, name); continue; }
      const num = Array.isArray(n.value) ? n.value : [], str = typeof n.value === 'string' ? n.value : '';
      switch (n.key) {
        case 'MINF': out.model ??= str; break;
        case 'FMWR': out.firmware ??= str; break;
        case 'VFOV': out.fovMode ??= str; break;
        case 'ZFOV': out.diagonalFov ??= num[0]; break;
        case 'POLY': out.poly ??= num; break;
        case 'ZMPL': out.polyScale ??= num[0]; break;
        case 'MAPX': out.mapX ??= num; break;
        case 'MAPY': out.mapY ??= num; break;
        case 'ARUW': out.aspectUnwarped ??= num[0]; break;
        case 'ARWA': out.aspectWarped ??= num[0]; break;
        case 'KLNS': (out.lenses ??= {})[name] = num; break;
        case 'CALW': out.calibrationWidth ??= num[0]; break;
        case 'SROT': out.readoutMs ??= num[0]; break;
        case 'EISE': out.stabilizedInCamera ??= str === 'Y'; break;
        case 'EISA': out.stabilization ??= str; break;
        case 'PTCL': out.colorProfile ??= str; break;
        case 'VFPS': if (num.length >= 2 && num[1]) out.fps ??= num[0]! / num[1]!; break;
        case 'DZOM': out.digitalZoom ??= str === 'Y'; break;
      }
    }
  };
  walk(nodes, '');
  return out;
}

/**
 * HiLight tags: the moments the rider pressed the camera's button (or said "GoPro, HiLight")
 * while recording, as media times in µs, in order. Two places hold them:
 * - HERO6 and later, Max: a "HLMT" device in the settings block (moov/udta/GPMF), whose HLMT
 *   values are 36-byte structs that start with the time in ms (type "LLLllfFff").
 * - Older cameras: the HMMT box (moov/udta/HMMT): a count, then that many times in ms.
 */
export function hilightTags(gpmf?: Uint8Array | null, hmmt?: Uint8Array | null): number[] {
  const ms: number[] = [];
  const walk = (bytes: Uint8Array, depth: number) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 0;
    while (i + 8 <= bytes.length) {
      const key = String.fromCharCode(...bytes.subarray(i, i + 4));
      if (!/^[A-Za-z0-9_ ]{4}$/.test(key)) break;
      const type = bytes[i + 4]!, size = bytes[i + 5]!, repeat = dv.getUint16(i + 6);
      const len = size * repeat, start = i + 8;
      if (start + len > bytes.length) break;
      if (type === 0 && depth < 8) walk(bytes.subarray(start, start + len), depth + 1);
      else if (key === 'HLMT' && size >= 4) {
        // A struct per tag (type '?'), or plain times (type 'L').
        const step = type === 0x3f ? size : 4;
        for (let o = 0; o + 4 <= len; o += step) ms.push(dv.getUint32(start + o));
      } else if (key === 'MANL' && type === 0x4c) {
        for (let o = 0; o + 4 <= len; o += 4) ms.push(dv.getUint32(start + o));
      }
      i = start + ((len + 3) & ~3);
    }
  };
  if (gpmf) walk(gpmf, 0);
  if (hmmt && hmmt.length >= 4) {
    const dv = new DataView(hmmt.buffer, hmmt.byteOffset, hmmt.byteLength);
    const n = Math.min(dv.getUint32(0), (hmmt.length - 4) >> 2);
    for (let k = 0; k < n; k++) ms.push(dv.getUint32(4 + k * 4));
  }
  // (0 is an empty slot; both places can hold the same tag.)
  const out: number[] = [];
  for (const m of ms.filter((x) => x > 0 && x < 48 * 3600_000).sort((a, b) => a - b)) if (!out.length || m * 1000 - out[out.length - 1]! > 500_000) out.push(m * 1000);
  return out;
}

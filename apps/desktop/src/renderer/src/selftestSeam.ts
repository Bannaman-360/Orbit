// The seam between the two lenses of a 360 camera: pictures and measurements.

import { DEFAULT_LOOK, type Look } from '@ace/project';
import { directionToStream, mulMat, mulVec, normalize, ReframeRenderer, transpose, type Mat3, type Tile, type Vec3 } from '@ace/media360';
import { ace } from './api';
import { framesAt } from './calib';
import { presentLook } from './frameRender';
import { getMedia } from './media';

const save = async (c: OffscreenCanvas, name: string) => {
  const blob = await c.convertToBlob({ type: 'image/png' });
  await ace.writeFile(await ace.selftestOut(name), new Uint8Array(await blob.arrayBuffer()));
};

export async function seamLook() {
  const out: Record<string, unknown> = {};
  const all = await ace.listFixtures();
  const m = await getMedia(all.find((f) => f.endsWith('GS010004.360'))!);
  const T = 85.89e6;
  const { frames, close } = await framesAt(m, T);
  out.ts = frames.map((f) => f.timestamp);
  for (const [i, f] of frames.entries()) {
    const c = new OffscreenCanvas(4096, 1344);
    c.getContext('2d')!.drawImage(f, 0, 0);
    await save(c, `seam-raw${i}.png`);
  }
  const cv = new OffscreenCanvas(1000, 1000), r = await ReframeRenderer.create(cv);
  r.setLayout(m.layout);
  for (const [n, yaw, pitch] of [['left', -90, 0], ['right', 90, 0], ['up', 0, 89.9], ['down', 0, -89.9]] as const) {
    r.resetHistory();
    r.pushFrame({ frames: frames as [VideoFrame, VideoFrame], mode: '360', view: { yaw, pitch, roll: 0, fov: 50, fisheye: 0 } });
    presentLook(r, { ...DEFAULT_LOOK } as Look);
    const c = new OffscreenCanvas(1000, 1000);
    c.getContext('2d')!.drawImage(await createImageBitmap(cv), 0, 0);
    await save(c, `seam-${n}.png`);
  }
  close();
  r.destroy();
  return out;
}

/** Luma of a stream picture, unscaled. */
function luma(f: VideoFrame): Float32Array {
  const c = new OffscreenCanvas(f.displayWidth, f.displayHeight), x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(f, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data, o = new Float32Array(c.width * c.height);
  for (let i = 0; i < o.length; i++) o[i] = 0.3 * d[i * 4]! + 0.59 * d[i * 4 + 1]! + 0.11 * d[i * 4 + 2]!;
  return o;
}

/**
 * How far apart the same thing is on either side of the cut in the middle of each side face:
 * the last columns of one half are looked for in the other half.
 */
export async function seamMeasure(file = 'GS010004.360', times = [12, 40, 60, 85.89, 100, 130, 160, 200, 240, 300, 360, 420]) {
  const out: Record<string, unknown> = {};
  const all = await ace.listFixtures();
  const m = await getMedia(all.find((f) => f.endsWith(file))!);
  const W = m.layout!.streamWidth, H = m.layout!.streamHeight;
  const PW = 22, PH = 40;
  const rows: { t: number; s: number; cut: number; y: number; dx: number; dy: number; ncc: number; second: number }[] = [];
  for (const t of times) {
    const { frames, close } = await framesAt(m, t * 1e6);
    const L = frames.map(luma);
    close();
    for (const st of [0, 1]) for (const tile of m.layout!.tiles.filter((q) => q.stream === st && q.gap)) {
      const cut = tile.x + tile.size / 2 + tile.gap! / 2, img = L[st]!;
      for (let y = 50; y < H - 50; y += 32) {
        const x0 = cut - PW - 1, y0 = y - PH / 2;
        let sa = 0, saa = 0;
        for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) { const v = img[(y0 + j) * W + x0 + i]!; sa += v; saa += v * v; }
        const n = PW * PH, va = saa - (sa * sa) / n;
        if (va / n < 60) continue;
        let best = -1, bx = 0, by = 0;
        const map = new Map<string, number>();
        for (let dy = -24; dy <= 24; dy++) for (let dx = PW + 2; dx <= PW + 100; dx++) {
          const x1 = x0 + dx, y1 = y0 + dy;
          if (y1 < 0 || y1 + PH > H || x1 < cut + 1 || x1 + PW > W) continue;
          let sb = 0, sbb = 0, sab = 0;
          for (let j = 0; j < PH; j += 2) for (let i = 0; i < PW; i += 1) { const a = img[(y0 + j) * W + x0 + i]!, b = img[(y1 + j) * W + x1 + i]!; sb += b; sbb += b * b; sab += a * b; }
          const n2 = n / 2;
          let sa2 = 0, saa2 = 0;
          for (let j = 0; j < PH; j += 2) for (let i = 0; i < PW; i++) { const v = img[(y0 + j) * W + x0 + i]!; sa2 += v; saa2 += v * v; }
          const c = (sab - (sa2 * sb) / n2) / Math.sqrt(Math.max(1, (saa2 - (sa2 * sa2) / n2) * (sbb - (sb * sb) / n2)));
          map.set(`${dx},${dy}`, c);
          if (c > best) { best = c; bx = dx; by = dy; }
        }
        let second = -1;
        for (const [key, c] of map) { const [x, yy] = key.split(',').map(Number) as [number, number]; if ((Math.abs(x - bx) > 6 || Math.abs(yy - by) > 6) && c > second) second = c; }
        if (best > 0.8 && best - second > 0.06) rows.push({ t, s: st, cut, y, dx: bx, dy: by, ncc: +best.toFixed(2), second: +second.toFixed(2) });
      }
    }
  }
  const med = (v: number[]) => { const q = [...v].sort((a, b) => a - b); return q.length ? q[q.length >> 1]! : NaN; };
  for (const st of [0, 1]) for (const cut of [688, 3408]) {
    const mine = rows.filter((r) => r.s === st && r.cut === cut);
    out[`stream ${st} cut ${cut}`] = { n: mine.length, medianDx: med(mine.map((r) => r.dx)), medianDy: med(mine.map((r) => r.dy)), byY: [0, 1, 2, 3, 4, 5, 6].map((k) => { const q = mine.filter((r) => Math.floor(r.y / 192) === k); return `${k * 192}: n${q.length} dx ${med(q.map((r) => r.dx))} dy ${med(q.map((r) => r.dy))}`; }), byTime: times.map((t) => { const q = mine.filter((r) => r.t === t); return `${t}s: n${q.length} ${med(q.map((r) => r.dx))},${med(q.map((r) => r.dy))}`; }) };
  }
  out.at85 = rows.filter((r) => r.t === 85.89).map((r) => `s${r.s} x${r.cut} y${r.y}: ${r.dx},${r.dy} (${r.ncc}/${r.second})`);
  return out;
}

const rotVec = (v: Vec3): Mat3 => { const a = Math.hypot(...v); if (a < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1]; const [x, y, z] = v.map((q) => q / a) as Vec3, c = Math.cos(a), s = Math.sin(a), t = 1 - c; return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c]; };
const bilin = (I: Float32Array, W: number, H: number, x: number, y: number) => { const x0 = Math.floor(x), y0 = Math.max(0, Math.min(H - 2, Math.floor(y))), fx = x - x0, fy = y - y0, X0 = ((x0 % W) + W) % W, X1 = (X0 + 1) % W; return (I[y0 * W + X0]! * (1 - fx) + I[y0 * W + X1]! * fx) * (1 - fy) + (I[(y0 + 1) * W + X0]! * (1 - fx) + I[(y0 + 1) * W + X1]! * fx) * fy; };

/** True angle of each column of the side faces, from GoPro's own stitched version of the recording. */
export async function seamFit() {
  const out: Record<string, unknown> = {};
  const all = await ace.listFixtures();
  const A = await getMedia(all.find((f) => f.endsWith('GS010004.360'))!), B = await getMedia(all.find((f) => f.endsWith('GS010004.mp4'))!);
  const W = 4096, H = 1344, EW = 2160, EH = 1080, S = 1344;
  const eq = (I: Float32Array, d: Vec3) => bilin(I, EW, EH, (Math.atan2(d[0], d[2]) / (2 * Math.PI) + 0.5) * EW - 0.5, (0.5 - Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI) * EH - 0.5);
  const lay = A.layout!;
  const obs: { u: number; half: string; face: string; ev: number; angle: number; now: number; ncc: number; cross: number }[] = [];
  const info: unknown[] = [];
  for (const t of [40, 85.89, 130, 200, 240, 360]) {
    const fa = await framesAt(A, t * 1e6), fb = await framesAt(B, t * 1e6);
    const L = fa.frames.map(luma), E = luma(fb.frames[0]!);
    info.push([fa.frames[0]!.timestamp, fb.frames[0]!.timestamp]);
    fa.close();
    fb.close();
    const raw = (d: Vec3) => { const q = directionToStream(lay, d); return { v: bilin(L[q.stream]!, W, H, q.x - 0.5, q.y - 0.5), face: q.face }; };
    // Whole-sphere rotation, from the two faces each seen by one lens alone (and their edges).
    const dirs: Vec3[] = [];
    for (let i = 0; i < 900; i++) { const a = (i % 30) / 30 * 2 - 1 + 1 / 30, b = Math.floor(i / 30) / 30 * 2 - 1 + 1 / 30; dirs.push(normalize([Math.tan(a * 0.75), Math.tan(b * 0.75), 1])); }
    const vals = dirs.map((d) => raw(d).v);
    const corr = (M: Mat3, step = 1) => { let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0; for (let i = 0; i < dirs.length; i += step) { const a = vals[i]!, b = eq(E, mulVec(M, dirs[i]!)); sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++; } return (sab - (sa * sb) / n) / Math.sqrt(Math.max(1e-6, (saa - (sa * sa) / n) * (sbb - (sb * sb) / n))); };
    let best: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1], bc = -1;
    const D = Math.PI / 180;
    const cands: [number, Mat3][] = [];
    for (let yaw = 0; yaw < 360; yaw += 8) for (let pitch = -90; pitch <= 90; pitch += 8) for (let roll = -60; roll <= 60; roll += 8) {
      const M = mulMat(mulMat(rotVec([0, yaw * D, 0]), rotVec([pitch * D, 0, 0])), rotVec([0, 0, roll * D]));
      cands.push([corr(M, 7), M]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    for (const [, M0] of cands.slice(0, 40)) { let M = M0, c = corr(M); for (let st = 4 * D; st > 0.02 * D; st *= 0.6) for (let g = 0; g < 2; g++) for (let ax = 0; ax < 3; ax++) for (const sg of [1, -1]) { const v: Vec3 = [0, 0, 0]; v[ax] = sg * st; const N = mulMat(rotVec(v), M), q = corr(N); if (q > c) { c = q; M = N; } } if (c > bc) { bc = c; best = M; } }
    info.push(`t${t} rotation corr ${bc.toFixed(3)}`);
    if (bc < 0.8) continue;
    // Each small patch of a side face: at which angle is it in GoPro's version?
    for (const tile of lay.tiles as Tile[]) {
      const st = tile.stream;
      const spans: [string, number][] = tile.gap ? [['near', tile.x + 0], ['far', tile.x + S / 2 + tile.gap / 2]] : [['whole', tile.x]];
      for (const [half, x0] of spans) {
        const wide = tile.gap ? S / 2 + tile.gap / 2 : S;
        for (let uc = 20; uc < wide - 16; uc += 24) for (let yc = 120; yc < H - 100; yc += 64) {
          const P = 14, px: number[] = [];
          let sa = 0, saa = 0;
          for (let j = -P; j <= P; j += 2) for (let i = -P; i <= P; i += 2) { const v = L[st]![(yc + j) * W + Math.round(x0 + uc) + i]!; px.push(v); sa += v; saa += v * v; }
          const n = px.length, va = (saa - (sa * sa) / n) / n;
          if (va < 80) continue;
          // Angle along the tile's x (−45° … 45°), from this half's outer edge with the present scale.
          const now = half === 'far' ? ((uc - 32) / 656) * 45 : half === 'near' ? (uc / 656) * 45 - 45 : (uc / S) * 90 - 45;
          const score = (da: number, db: number) => {
            let sb = 0, sbb = 0, sab = 0, k = 0;
            for (let j = -P; j <= P; j += 2) for (let i = -P; i <= P; i += 2) {
              const es = ((now + da + (i / (tile.gap ? 656 : 672)) * 45) * Math.PI) / 180, ev = ((yc + j + 0.5) / S) * 90 - 45 + db;
              const tx = Math.tan(es), ty = Math.tan((ev * Math.PI) / 180);
              const d = normalize([0, 1, 2].map((q) => tile.center[q]! + tx * tile.right[q]! + ty * tile.down[q]!) as Vec3);
              const b = eq(E, mulVec(best, d)), a = px[k++]!;
              sb += b; sbb += b * b; sab += a * b;
            }
            return (sab - (sa * sb) / n) / Math.sqrt(Math.max(1e-6, (saa - (sa * sa) / n) * (sbb - (sb * sb) / n)));
          };
          let bda = 0, bdb = 0, bs = -1;
          for (let db = -1.2; db <= 1.2; db += 0.3) for (let da = -3; da <= 3; da += 0.2) { const c = score(da, db); if (c > bs) { bs = c; bda = da; bdb = db; } }
          for (let stp = 0.1; stp > 0.01; stp /= 2) for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const c = score(bda + x * stp, bdb + y * stp); if (c > bs) { bs = c; bda += x * stp; bdb += y * stp; } }
          if (bs > 0.85 && Math.abs(bda) < 2.9) obs.push({ u: uc, half, face: tile.face, ev: yc, angle: now + bda, now, ncc: bs, cross: bdb });
        }
      }
    }
  }
  void transpose;
  out.info = info;
  const med = (v: number[]) => { const q = [...v].sort((a, b) => a - b); return q.length ? q[q.length >> 1]! : NaN; };
  for (const face of ['front', 'back', 'left', 'right', 'up', 'down']) for (const half of ['whole', 'near', 'far']) {
    const o = obs.filter((x) => x.face === face && x.half === half);
    if (!o.length) continue;
    const bins: string[] = [];
    for (let k = 0; k * 48 < 1400; k++) { const q = o.filter((x) => Math.floor(x.u / 48) === k); if (q.length >= 5) bins.push(`u${k * 48 + 24}: ${med(q.map((x) => x.angle - x.now)).toFixed(2)}/${med(q.map((x) => x.cross)).toFixed(2)} (n${q.length})`); }
    out[`${face} ${half}`] = bins.join('  ');
  }
  return out;
}

/** What remains at the seam: lens brightness, sharpness and the join itself, for several recordings. */
export async function seamCheck() {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const med = (v: number[]) => { const q = [...v].sort((a, b) => a - b); return q.length ? q[q.length >> 1]! : NaN; };
  for (const [file, times] of [['GS010004.360', [40, 85.89, 130, 200, 240, 360]], ['GS010083.360', [2, 8, 15, 22]], ['GS010119.360', [5, 30, 60]], ['GS010113.360', [5, 20, 40]]] as [string, number[]][]) {
    const m = await getMedia(all.find((f) => f.endsWith(file))!);
    const W = m.layout!.streamWidth, H = m.layout!.streamHeight;
    const dx: number[] = [], dy: number[] = [], bright: number[] = [];
    const perCut: Record<string, number[]> = {};
    for (const t of times) {
      if (t * 1e6 > m.durationUs) continue;
      const { frames, close } = await framesAt(m, t * 1e6);
      const L = frames.map(luma);
      close();
      for (const tile of m.layout!.tiles.filter((q) => q.gap)) {
        const cut = tile.x + (tile.size + tile.gap!) / 2, over = Math.round((tile.gap! * 63) / 32), img = L[tile.stream]!;
        for (let y = 40; y < H - 60; y += 32) {
          const PW = 26, PH = 32, x0 = cut - PW - 2;
          let sa = 0, saa = 0, sb0 = 0;
          for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) { const v = img[(y + j) * W + x0 + i]!; sa += v; saa += v * v; sb0 += img[(y + j) * W + x0 + i + over]!; }
          const n = PW * PH;
          let best = -1, bx = 0, by = 0;
          for (let ey = -5; ey <= 5; ey++) for (let ex = -5; ex <= 5; ex++) {
            let sb = 0, sbb = 0, sab = 0;
            for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) { const a = img[(y + j) * W + x0 + i]!, b = img[(y + j + ey) * W + x0 + i + over + ex]!; sb += b; sbb += b * b; sab += a * b; }
            const c = (sab - (sa * sb) / n) / Math.sqrt(Math.max(1, (saa - (sa * sa) / n) * (sbb - (sb * sb) / n)));
            if (c > best) { best = c; bx = ex; by = ey; }
          }
          if ((saa - (sa * sa) / n) / n > 60 && best > 0.9) { dx.push(bx); dy.push(by); bright.push((sb0 - sa) / n); (perCut[tile.face] ??= []).push((sb0 - sa) / n); }
        }
      }
    }
    const far = dx.filter((v, i) => Math.max(Math.abs(v), Math.abs(dy[i]!)) > 2).length;
    ok(`${file}: the halves meet`, dx.length > 20 && Math.abs(med(dx)) <= 1 && Math.abs(med(dy)) <= 1 && (dx.length < 100 || far < dx.length * 0.15), { compared: dx.length, medianPx: [med(dx), med(dy)], over2px: far, brightness: Object.fromEntries(Object.entries(perCut).map(([k, v]) => [k, +med(v).toFixed(1)])) });
  }
  // Sharpness across the seam, against just beside it.
  const m = await getMedia(all.find((f) => f.endsWith('GS010004.360'))!);
  const N = 900, cv = new OffscreenCanvas(N, N), r = await ReframeRenderer.create(cv);
  r.setLayout(m.layout);
  const read = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true })!;
  const ratio: number[] = [];
  for (const t of [40, 85.89, 130, 200, 240, 360]) {
    const { frames, close } = await framesAt(m, t * 1e6);
    for (const yaw of [-90, 90]) {
      r.resetHistory();
      r.pushFrame({ frames: frames as [VideoFrame, VideoFrame], mode: '360', view: { yaw, pitch: 20, roll: 0, fov: 40, fisheye: 0 } });
      presentLook(r, { ...DEFAULT_LOOK } as Look);
      read.drawImage(await createImageBitmap(cv), 0, 0);
      const d = read.getImageData(0, 0, N, N).data;
      const g = (a: number, b: number) => { let s2 = 0, n = 0; for (let y = 100; y < 800; y++) for (let x = a; x < b; x++) { const i = (y * N + x) * 4 + 1; s2 += (d[i + 8]! - d[i]!) ** 2; n++; } return Math.sqrt(s2 / n); };
      // (The seam is the vertical middle; the blend is about ±50 px here.)
      ratio.push(g(425, 475) / ((g(250, 300) + g(600, 650)) / 2));
    }
    close();
  }
  out.sharpnessAtSeam = { median: +med(ratio).toFixed(2), each: ratio.map((v) => +v.toFixed(2)) };
  r.destroy();
  return { fails, ...out };
}

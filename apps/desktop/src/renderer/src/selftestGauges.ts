// Gauges: steady (no shaking or ghosting), and the same in preview and export.

import { addClip, emptyTimeline, GAUGE_DESIGNS, gaugeLooks, GAUGES, gaugeSet, lookPatch, newClip, newGaugeOverlay, type GaugeStyle, type GaugeKind, type Timeline } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import { TelemetrySeries } from '@ace/telemetry';
import { drawOverlays, gaugeReading } from './overlayRender';
import type { EditorApi } from './selftest';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Draws the timeline's overlays at T into a fresh canvas. */
function draw(tl: Timeline, T: number, W = 1280, H = 720) {
  const c = new OffscreenCanvas(W, H), x = c.getContext('2d')!;
  drawOverlays(x, W, H, tl, T);
  return x.getImageData(0, 0, W, H);
}

export async function gaugesCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const m = await getMedia(all.find((f) => f.endsWith('max2/GS010083.360'))!);
  await api.importPaths([m.path]);
  const end = Math.min(m.durationUs, 60 * S);
  const g = (kind: GaugeKind, style: GaugeStyle, x: number, y: number) => ({ ...newGaugeOverlay(kind, 0, end), style, x, y, animation: 'none' as const });
  let tl = addClip(emptyTimeline(), { ...newClip(m.path, m.durationUs, true), outUs: end });
  tl = { ...tl, overlays: [g('gforce', 'graph', 0.25, 0.3), g('speed', 'graph', 0.75, 0.3), g('gforce', 'needle', 0.25, 0.75), g('speed', 'dial', 0.75, 0.75)] };
  out.accel = m.telemetry.accelRange ? 'yes' : 'no';

  // 1. A scrolling graph only slides: frame n+1 equals frame n moved left by the elapsed time.
  const graphBox = (o: (typeof tl.overlays)[number], W: number, H: number) => { const s = o.size * H, w = s * 3.2, h = s * 1.2; return { x: Math.round(o.x * W - w / 2 + s * 0.14), y: Math.round(o.y * H - h / 2 + s * 0.46), w: Math.round(w - s * 0.28), h: Math.round(h - s * 0.6) }; };
  const W = 1280, H = 720, dt = 1e6 / 60;
  const only = (i: number): Timeline => ({ ...tl, overlays: [tl.overlays[i]!] });
  for (const [i, name] of [[0, 'G-force graph'], [1, 'speed graph']] as const) {
    const o = tl.overlays[i]!, b = graphBox(o, W, H), span = 10 * S;
    const errs: number[] = [];
    // A step of exactly one pixel, so a steady line is the same picture moved one pixel left.
    const pxDt = span / b.w;
    for (let k = 0; k < 40; k++) {
      const T = 15 * S + k * 0.37 * S;
      const a = draw(only(i), T), c = draw(only(i), T + pxDt);
      const shift = 1;
      // Compare a's graph moved by `shift` px with c (bilinear in x), ignoring the newest 6 px.
      let d = 0, n = 0;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x + 2; x < b.x + b.w - 8; x++) {
        const sx = x + shift, x0 = Math.floor(sx), f = sx - x0;
        const ia = (y * W + x0) * 4 + 3, ib = ia + 4, ic = (y * W + x) * 4 + 3;
        const va = a.data[ia]! * (1 - f) + a.data[ib]! * f;
        d += Math.abs(va - c.data[ic]!); n++;
      }
      errs.push(d / n);
    }
    errs.sort((p, q) => p - q);
    const p95 = errs[Math.floor(errs.length * 0.95)]!;
    ok(`${name} slides without wobbling`, p95 < 1.2, { meanAbsDiffP95: +p95.toFixed(3) });
  }

  // 2. Needles and numbers: no shiver at 60 fps, number changes at most 10 times a second.
  for (const [i, name] of [[2, 'G-force needle'], [3, 'speed dial']] as const) {
    const o = tl.overlays[i]!, shiver: number[] = [];
    let changes = 0, last = '', avail = 0, flips = 0;
    for (let k = 0; k < 60 * 20; k++) {
      const T = 5 * S + k * dt, r = [0, 1, 2].map((j) => gaugeReading(o, tl, T + j * dt));
      if (r.every((x) => x.available)) {
        avail++;
        // Shiver: how much the needle's movement changes from one frame to the next (a real
        // swing is smooth; shaking reverses every frame).
        shiver.push(Math.abs(r[2]!.fraction - 2 * r[1]!.fraction + r[0]!.fraction) * 270);
        const v1 = (r[1]!.fraction - r[0]!.fraction) * 270, v2 = (r[2]!.fraction - r[1]!.fraction) * 270;
        if (v1 * v2 < 0 && Math.min(Math.abs(v1), Math.abs(v2)) > 0.05) flips++;
      }
      if (r[0]!.value !== last) { changes++; last = r[0]!.value; }
    }
    shiver.sort((p, q) => p - q);
    const tip = (o.size * H * 0.42 * Math.PI) / 180; // px per degree at the needle tip
    const p95 = shiver[Math.floor(shiver.length * 0.95)] ?? 0;
    // Shaking = the needle turning back and forth many times a second.
    const perSec = flips / (avail / 60 || 1);
    ok(`${name} moves smoothly`, !avail || perSec < 4, { frames: avail, reversalsPerSecond: +perSec.toFixed(2), p95accelPx: +(p95 * tip).toFixed(3) });
    ok(`${name} number is readable`, changes / 20 <= 10.5, { changesPerSecond: changes / 20 });
  }

  // 3. No ghosting: the preview's overlay layer after playing holds exactly the current frame.
  api.setTimeline(tl);
  await sleep(500);
  api.player.seek(10 * S);
  await sleep(300);
  api.player.play();
  await sleep(2500);
  api.player.pause();
  await sleep(300);
  const layer = document.querySelector<HTMLCanvasElement>('.overlay-layer')!;
  const shown = layer.getContext('2d')!.getImageData(0, 0, layer.width, layer.height);
  const fresh = draw(tl, api.player.time, layer.width, layer.height);
  let off = 0, drawn = 0;
  for (let i = 3; i < shown.data.length; i += 4) { if (fresh.data[i]! > 16) drawn++; if (Math.abs(shown.data[i]! - fresh.data[i]!) > 24) off++; }
  ok('no ghosting: the layer shows only the current moment', off < drawn * 0.01, { differingPixels: off, drawnPixels: drawn });
  ok('the layer is drawn at screen pixels', Math.abs(layer.width - layer.clientWidth * devicePixelRatio) <= 2, [layer.width, layer.clientWidth]);
  await ace.capture('gauges');
  // The look picker: select the needle gauge by clicking it on the preview.
  {
    const frame = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect(), o = tl.overlays[2]!;
    const at = { x: Math.round(frame.left + o.x * frame.width), y: Math.round(frame.top + o.y * frame.height) };
    await ace.selftestInput({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await ace.selftestInput({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(500);
    const tiles = document.querySelectorAll('.look-grid .look');
    ok('the Inspector shows every look as a picture', tiles.length === gaugeLooks('gforce').length && !!document.querySelector('.look.on'), { tiles: tiles.length, looks: gaugeLooks('gforce').length });
    (tiles[tiles.length - 1] as HTMLElement | undefined)?.click();
    await sleep(300);
    const picked = api.getTimeline().overlays.find((x) => x.id === o.id);
    ok('picking one changes the gauge', picked?.design === gaugeLooks('gforce').at(-1)!.design, picked?.design);
    await ace.capture('gauges-picker');
  }
  await designSheet(ok, out);
  return { fails, ...out };
}

/** Every look of every gauge, drawn on a backdrop: a contact sheet, a check each one draws, and its cost. */
async function designSheet(ok: (n: string, pass: boolean, info?: unknown) => void, out: Record<string, unknown>) {
  const all = await ace.listFixtures();
  const m = await getMedia(all.find((f) => f.endsWith('GS010115.360'))!);
  const gps = Array.from({ length: 241 }, (_, i) => {
    const a = (i / 240) * Math.PI * 2;
    return { t: i * 100_000, lat: 46.2 + 0.0004 * Math.sin(a), lon: 7.3 + 0.0006 * Math.cos(a) * (1 + 0.3 * Math.sin(a * 3)), alt: 520 + 8 * Math.sin(a * 2), speed: 8 + 3 * Math.sin(a * 3), fix: 3 };
  });
  m.telemetry = new TelemetrySeries(gps, m.stabilizer.data?.accl);
  const tlBase = addClip(emptyTimeline(), newClip(m.path, m.durationUs, true));
  const j = m.telemetry.jumps()[2]!;
  const T = j.startUs + 300_000; // mid-jump: the airtime gauges count
  const W = 1600, cellW = 400, cellH = 230;
  const timings: Record<string, number> = {};
  let empty: string[] = [];
  for (const [kind] of GAUGES) {
    const looks = gaugeLooks(kind);
    const cols = 4, rows = Math.ceil(looks.length / cols), H = rows * cellH;
    const c = new OffscreenCanvas(W, H), x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#6f8fae'); g.addColorStop(0.5, '#a7a28c'); g.addColorStop(1, '#3d4a2f');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < looks.length; i++) {
      const L = looks[i]!, cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
      const base = { ...newGaugeOverlay(kind, 0, m.durationUs), animation: 'none' as const, ...lookPatch(L.design, L.style) };
      const o0 = { ...base, x: 0.5, y: 0.5, size: 1 };
      const box = (await import('./overlayRender')).overlayBox(o0, 1, 1);
      const size = Math.min((cellH - 46) / box.h, (cellW - 30) / box.w) / H;
      const o = { ...base, size, x: (cx + cellW / 2) / W, y: (cy + (cellH - 24) / 2 + 4) / H };
      const tl = { ...tlBase, overlays: [o] };
      const t0 = performance.now();
      for (let k = 0; k < 20; k++) {
        const scratch = new OffscreenCanvas(W, H).getContext('2d')!;
        drawOverlays(scratch, W, H, tl, T + k * 16_667);
      }
      timings[`${kind}/${L.name}`] = +((performance.now() - t0) / 20).toFixed(2);
      const before = x.getImageData(cx, cy, cellW, cellH - 24).data;
      drawOverlays(x, W, H, tl, T);
      const after = x.getImageData(cx, cy, cellW, cellH - 24).data;
      let changed = 0;
      for (let p = 0; p < after.length; p += 16) if (Math.abs(after[p]! - before[p]!) + Math.abs(after[p + 1]! - before[p + 1]!) > 30) changed++;
      if (changed < 40) empty.push(`${kind}/${L.name}`);
      x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(cx, cy + cellH - 24, cellW, 24);
      x.fillStyle = '#fff'; x.font = '600 14px -apple-system, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(L.name, cx + cellW / 2, cy + cellH - 12);
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    await ace.writeFile(await ace.selftestOut(`designs-${kind}.png`), new Uint8Array(await blob.arrayBuffer()));
  }
  // Matching sets, one per design, on a 16:9 frame each.
  {
    const fw = 480, fh = 270, cols = 3, rows = Math.ceil(GAUGE_DESIGNS.length / cols);
    const c = new OffscreenCanvas(fw * cols, fh * rows), x = c.getContext('2d')!;
    for (let i = 0; i < GAUGE_DESIGNS.length; i++) {
      const d = GAUGE_DESIGNS[i]!, ox = (i % cols) * fw, oy = Math.floor(i / cols) * fh;
      const f = new OffscreenCanvas(fw, fh), fx = f.getContext('2d')!;
      const g = fx.createLinearGradient(0, 0, 0, fh);
      g.addColorStop(0, '#8fb3d6'); g.addColorStop(0.55, '#b9b49a'); g.addColorStop(1, '#4b5a35');
      fx.fillStyle = g; fx.fillRect(0, 0, fw, fh);
      drawOverlays(fx, fw, fh, { ...tlBase, overlays: gaugeSet(d.id, 0, m.durationUs).map((o) => ({ ...o, animation: 'none' as const })) }, T + 2.2e6);
      fx.fillStyle = 'rgba(0,0,0,0.5)'; fx.fillRect(0, 0, 90, 20); fx.fillStyle = '#fff'; fx.font = '600 12px sans-serif'; fx.fillText(d.name, 6, 14);
      x.drawImage(f, ox, oy);
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    await ace.writeFile(await ace.selftestOut('designs-sets.png'), new Uint8Array(await blob.arrayBuffer()));
  }
  const worst = Object.entries(timings).sort((a, b) => b[1] - a[1]).slice(0, 5);
  ok('every look draws something', !empty.length, empty);
  ok('every look is quick to draw (under 1.5 ms a frame)', worst[0]![1] < 1.5, worst);
  out.looks = Object.keys(timings).length;
  empty = [];
}

/** Every dip below 0.8 G (lightly smoothed): how low, how long, and the spike after it. */
function dipsOf(tm: any) {
  const t: Float64Array = tm.aT, g: Float64Array = tm.rawG, n = t.length;
  const rate = (n - 1) / ((t[n - 1]! - t[0]!) / 1e6), r = Math.max(0, Math.round(rate * 0.02));
  const v = Array.from(g, (_, i) => { let a = 0, c = 0; for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { a += g[k]!; c++; } return a / c; });
  const out: string[] = [];
  for (let i = 1; i < n; i++) {
    if (v[i]! < 0.8 && v[i - 1]! >= 0.8) {
      let j = i, lo = 9, b6 = 0, b4 = 0;
      while (j < n && v[j]! < 0.8) { lo = Math.min(lo, v[j]!); if (v[j]! < 0.6) b6++; if (v[j]! < 0.4) b4++; j++; }
      const ms = (t[Math.min(j, n - 1)]! - t[i]!) / 1000;
      if (ms < 100) continue;
      let pk = 0; for (let k = j; k < n && t[k]! - t[Math.min(j, n - 1)]! < 300_000; k++) pk = Math.max(pk, v[k]!);
      out.push(`${(t[i]! / 1e6).toFixed(2)}s ${Math.round(ms)}ms min${lo.toFixed(2)} <.6:${Math.round(b6 / rate * 1000)} <.4:${Math.round(b4 / rate * 1000)} pk${pk.toFixed(1)}`);
    }
  }
  return out;
}

/** Airtime on the real recordings: what the accelerometer reads, and the jumps found. */
export async function airtimeCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const all = (await ace.listFixtures()).filter((f) => /max2\/G[SX]01\d+\.(360|MP4)$/.test(f) && !/GS010004/.test(f));
  for (const p of all) {
    const m = await getMedia(p);
    const tm = m.telemetry, r = tm.accelRange;
    if (!r) { out[p.split('/').pop()!] = 'no accelerometer'; continue; }
    // Lowest readings (10 ms steps): how far down it gets.
    const lows: number[] = [];
    for (let t = r[0]; t < r[1]; t += 10_000) lows.push(tm.gforceAt(t));
    lows.sort((a, b) => a - b);
    const j = tm.jumps();
    out[p.split('/').pop()!] = {
      seconds: +((r[1] - r[0]) / 1e6).toFixed(1), gps: tm.gpsRange ? tm.gpsRange.map((x) => +(x / 1e6).toFixed(1)) : 'none', maxKmh: +(tm.maxSpeed * 3.6).toFixed(1),
      lowestG: +lows[0]!.toFixed(2), p1G: +lows[Math.floor(lows.length * 0.01)]!.toFixed(2),
      jumps: j.map((x) => `${(x.startUs / 1e6).toFixed(2)}s ${x.airMs}ms ${x.distanceM ?? '-'}m @${x.speedMs !== undefined ? (x.speedMs * 3.6).toFixed(1) : '-'}km/h land ${x.landingG}G`),
      atHalfG: tm.jumps({ below: 0.5 }).length, atThirdG: tm.jumps({ below: 0.3 }).length,
      before: tm.jumps({ joinMs: 80 }).length,
      byShortest: Object.fromEntries([80, 150, 200, 300, 400, 600, 1000].map((ms) => [ms, tm.jumps({ minMs: ms }).length])),
    };
  }
  // The jump at 6:44.8 in GS010004 lifts mid-air: it must stay one jump.
  {
    const f = (await ace.listFixtures()).find((x) => /GS010004/.test(x));
    if (f) {
      const near = (await getMedia(f)).telemetry.jumps().filter((x) => x.endUs > 404.3e6 && x.startUs < 405.4e6);
      const t4 = (await getMedia(f)).telemetry;
      out['GS010004 jumps'] = t4.jumps().map((x) => `${(x.startUs / 1e6).toFixed(1)}s ${x.airMs}ms ${x.distanceM ?? '-'}m @${x.speedMs !== undefined ? (x.speedMs * 3.6).toFixed(1) : '-'}km/h`);
      out['GS010004 at 6:44'] = near.map((x) => `${(x.startUs / 1e6).toFixed(2)}s ${x.airMs}ms ${x.distanceM ?? '-'}m land ${x.landingG}G`);
      if (near.length !== 1) fails.push('GS010004 at 6:44 is one jump');
    }
  }
  // In the editor: marks on the timeline, the gauge counting and holding, the Inspector's list.
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const m = await getMedia(all.find((f) => f.endsWith('GS010115.360'))!);
  await api.importPaths([m.path]);
  const gauge = { ...newGaugeOverlay('airtime', 0, m.durationUs), animation: 'none' as const };
  const tl = { ...addClip(emptyTimeline(), newClip(m.path, m.durationUs, true)), overlays: [gauge] };
  api.setTimeline(tl);
  await sleep(800);
  const j = m.telemetry.jumps();
  const marks = [...document.querySelectorAll<HTMLElement>('.clip-jump')];
  ok('each jump is marked on the timeline', marks.length === j.length && j.length > 0, { marks: marks.length, jumps: j.length });
  const mid = j[1]!, r = (T: number) => gaugeReading(gauge, tl, T);
  ok('the gauge counts up in the air', Math.abs(r(mid.startUs + 200_000).num - 0.2) < 0.01 && r(mid.startUs + 300_000).num > r(mid.startUs + 200_000).num, [r(mid.startUs + 200_000).value, r(mid.startUs + 300_000).value]);
  ok('and holds the jump after landing', Math.abs(r(mid.endUs + 0.5e6).num - mid.airMs / 1000) < 0.006, r(mid.endUs + 0.5e6).value);
  const later = j[j.length - 1]!.endUs + 3.5e6;
  if (later < m.durationUs) ok('then shows the best so far', Math.abs(r(later).num - Math.max(...j.map((x) => x.airMs)) / 1000) < 0.006 && /BEST/.test(r(later).label), [r(later).value, r(later).label]);
  // A trimmed clip still counts the jumps before its in point (the whole recording counts).
  {
    // (Just after a landing, so no jump is under way; the running total doesn't hold the last jump.)
    const cut = { ...tl, clips: tl.clips.map((c) => ({ ...c, inUs: mid.endUs + 20_000 })) };
    const tot = { ...gauge, airShow: 'running' as const };
    const before = j.filter((x) => x.endUs <= mid.endUs + 120_000).reduce((a, x) => a + x.airMs / 1000, 0);
    const v = gaugeReading(tot, cut, 100_000).num;
    ok('a trimmed clip counts jumps from the whole recording', Math.abs(v - before) < 0.006 && before > 0, [v, before]);
  }
  // The jump distance gauge (on GS010004, which has GPS): grows through a jump, then holds it.
  const f4 = (await ace.listFixtures()).find((x) => /GS010004/.test(x));
  if (f4) {
    const m4 = await getMedia(f4);
    const tl4 = addClip(emptyTimeline(), newClip(m4.path, m4.durationUs, true));
    const dg = { ...newGaugeOverlay('jumpdist', 0, m4.durationUs), animation: 'none' as const };
    const jd = m4.telemetry.jumps().find((x) => x.startUs > 404e6)!;
    const dr = (T: number) => gaugeReading(dg, tl4, T);
    const half = dr((jd.startUs + jd.endUs) / 2).num, after = dr(jd.endUs + 0.5e6).num;
    ok('jump distance grows in the air and holds on landing', half > 0.3 * jd.distanceM! && half < 0.7 * jd.distanceM! && Math.abs(after - jd.distanceM!) < 0.06, [half, after, jd.distanceM]);
    // Running total: only ever the sum, growing through each jump, flat in between.
    const rg = { ...dg, airShow: 'running' as const };
    const all4 = m4.telemetry.jumps(), before = all4.filter((x) => x.endUs <= jd.startUs).reduce((a, x) => a + x.distanceM!, 0);
    const rr = (T: number) => gaugeReading(rg, tl4, T).num;
    ok('running total adds each jump as it happens', Math.abs(rr(jd.startUs - 50_000) - before) < 0.06 && rr((jd.startUs + jd.endUs) / 2) > before + 0.3 * jd.distanceM! && Math.abs(rr(jd.endUs + 0.5e6) - (before + jd.distanceM!)) < 0.06 && Math.abs(rr(jd.endUs + 5e6) - rr(jd.endUs + 0.5e6)) < 0.06 || all4.some((x) => x.startUs > jd.endUs && x.startUs < jd.endUs + 5e6), [rr(jd.startUs - 50_000), rr(jd.endUs + 0.5e6), before + jd.distanceM!]);
    ok('no GPS, no jump distance', !gaugeReading(dg, tl, mid.endUs + 0.5e6).available);
  }
  {
    const ra = { ...gauge, airShow: 'running' as const }, rr = (T: number) => gaugeReading(ra, tl, T).num;
    const prev = j.filter((x) => x.endUs <= mid.startUs).reduce((a, x) => a + x.airMs / 1000, 0);
    ok('running total airtime grows through a jump and holds', Math.abs(rr(mid.startUs + 200_000) - (prev + 0.2)) < 0.01 && Math.abs(rr(mid.endUs + 0.5e6) - (prev + mid.airMs / 1000)) < 0.006, [rr(mid.startUs + 200_000), rr(mid.endUs + 0.5e6), prev + mid.airMs / 1000]);
  }
  // Clicking a mark goes to that jump.
  marks[1]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  await sleep(200);
  // The "Ignore jumps shorter than" setting changes what the editor shows.
  api.setTimeline({ ...tl, clips: tl.clips.map((c) => ({ ...c, airtime: { minMs: 600 } })) });
  await sleep(500);
  ok('a longer shortest-jump hides short jumps', document.querySelectorAll('.clip-jump').length === m.telemetry.jumps({ minMs: 600 }).length && m.telemetry.jumps({ minMs: 600 }).length < j.length, { marks: document.querySelectorAll('.clip-jump').length, want: m.telemetry.jumps({ minMs: 600 }).length, had: j.length });
  api.setTimeline(tl);
  await sleep(400);
  ok('clicking a mark goes to its takeoff', Math.abs(api.player.time - j[1]!.startUs) < 30_000, api.player.time);
  api.player.seek(mid.startUs + 250_000);
  await sleep(600);
  await ace.capture('airtime');
  return { fails, ...out };
}

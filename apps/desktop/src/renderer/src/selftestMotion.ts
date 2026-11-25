// Milestone 3 (motion and sound): keyframe curves, motion titles and text on a path, sound tools
// (wind reduction, EQ, compressor, ducking, true-peak loudness), and the export queue with
// presets and batch export. Preview and export are compared where they draw the same thing.

import { addClip, CURVES, emptyTimeline, lookAt, newAudioClip, newClip, newTextOverlay, newTitleOverlay, NEUTRAL_GRADE, TITLE_TEMPLATES, type Overlay, type Timeline, type TimelineClip } from '@ace/project';
import { ace } from './api';
import { loadSoundWorklet, mixTimeline } from './audioEngine';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { cancelJob, enqueue, pauseJob, queueJobs, resumeJob } from './exportQueue';
import { measureLufs, truePeakDb } from './loudness';
import { getMedia, getMusic, type Media } from './media';
import { drawTitle } from './motionTitles';
import { drawOverlays } from './overlayRender';
import type { EditorApi } from './selftest';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (q: string) => document.querySelector<HTMLElement>(q);
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

interface Pic { w: number; h: number; d: Uint8ClampedArray }
async function readPicture(path: string, crop?: { x: number; y: number; w: number; h: number }, size?: { w: number; h: number }): Promise<Pic> {
  const bmp = await createImageBitmap(new Blob([(await ace.readAll(path)) as Uint8Array<ArrayBuffer>]));
  const c = crop ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const w = size?.w ?? c.w, h = size?.h ?? c.h;
  const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return { w, h, d: x.getImageData(0, 0, w, h).data };
}
function diff(a: Pic, b: Pic): number {
  let s = 0, n = 0;
  for (let i = 0; i < a.d.length; i += 8) { for (let k = 0; k < 3; k++) s += Math.abs(a.d[i + k]! - b.d[i + k]!); n += 3; }
  return n ? s / n : 0;
}
/** Energy of a band (Hz) in a mono mix of a buffer, over its middle. */
function bandEnergy(b: AudioBuffer, from: number, to: number): number {
  const N = 16384, re = new Float32Array(N), im = new Float32Array(N);
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
  const start = Math.max(0, Math.floor(L.length / 2 - N / 2));
  for (let i = 0; i < N; i++) re[i] = ((L[start + i] ?? 0) + (R[start + i] ?? 0)) / 2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  // (A plain DFT over the band's bins is enough here.)
  let e = 0;
  for (let k = Math.round((from * N) / b.sampleRate); k <= Math.round((to * N) / b.sampleRate); k++) {
    let a = 0, c = 0;
    for (let i = 0; i < N; i += 2) { const w = (2 * Math.PI * k * i) / N; a += re[i]! * Math.cos(w); c -= re[i]! * Math.sin(w); }
    e += a * a + c * c;
  }
  void im;
  return e;
}
const rms = (x: Float32Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i]! * x[i]!; return Math.sqrt(s / Math.max(1, b - a)); };

export async function motionCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const step = async (name: string, f: () => Promise<void>) => { try { await f(); } catch (e) { ok(`${name} ran`, false, String(e instanceof Error ? e.stack : e)); } };
  const all = await ace.listFixtures();
  const m: Media = await getMedia(all.find((f) => f.endsWith('GX010133.MP4'))!);
  // (The fixture list has videos only: the music sits beside them.)
  const musicPath = `${m.path.slice(0, m.path.lastIndexOf('/fixtures/'))}/fixtures/synthetic/beats-120.wav`;
  await api.importPaths([m.path]);
  const base = (): TimelineClip => ({ ...newClip(m.path, m.durationUs, false), inUs: 0, outUs: 6 * S });
  const tlWith = (c: TimelineClip, extra: Partial<Timeline> = {}): Timeline => ({ ...addClip(emptyTimeline(), c), ...extra });
  /** Shows an Inspector tab and opens a section in it. */
  const openSection = async (panel: string | null, name: string) => {
    if (panel) { $(`[role="tab"][data-panel="${panel}"]`)?.click(); await sleep(250); }
    const t = $(`[data-section="${name}"] .section-toggle`);
    if (t?.getAttribute('aria-expanded') === 'false') { t.click(); await sleep(250); }
  };
  const redraw = async () => { for (let i = 0; i < 6; i++) await Promise.race([api.nextRender(), sleep(1500)]); await sleep(250); };

  // --- Curves ----------------------------------------------------------------------------------
  await step('curves', async () => {
    const c0 = base();
    const keys = [
      { id: 'ka', t: 1 * S, look: { ...c0.look, grade: { ...NEUTRAL_GRADE, exposure: 0 } }, easing: 'linear' as const },
      { id: 'kb', t: 3 * S, look: { ...c0.look, grade: { ...NEUTRAL_GRADE, exposure: 1 } }, easing: 'smooth' as const },
    ];
    api.setTimeline(tlWith({ ...c0, keyframes: keys }));
    api.player.seek(2 * S);
    await redraw();
    // The Curves section shows the move the playhead is in.
    await openSection('reframe', 'Curves');
    $('[data-section="Curves"]')?.scrollIntoView({ block: 'start' });
    await sleep(200);
    ok('the Curves section shows the move under the playhead', !!$('.curve-graph') && $$('.curves-presets button').length === CURVES.length, { graph: !!$('.curve-graph'), presets: $$('.curves-presets button').length });
    $$('.curves-presets button').find((b) => b.textContent?.includes('Overshoot'))?.click();
    await sleep(250);
    const k1 = api.getTimeline().clips[0]!.keyframes.find((k) => k.id === 'ka');
    ok('picking a curve sets it on the keyframe', k1?.easing === 'overshoot', k1?.easing);
    const c = api.getTimeline().clips[0]!;
    const ys = Array.from({ length: 40 }, (_, i) => lookAt(c.keyframes, c.look, 1 * S + (i / 39) * 2 * S).grade.exposure);
    ok('overshoot goes past the next keyframe and settles', Math.max(...ys) > 1.05 && Math.abs(ys[39]! - 1) < 0.01, +Math.max(...ys).toFixed(3));
    // Only the colour moves on its own curve.
    $$('.curves-groups button').find((b) => b.textContent === 'Colour')?.click();
    await sleep(150);
    $$('.curves-presets button').find((b) => b.textContent?.includes('Hold'))?.click();
    await sleep(250);
    const k2 = api.getTimeline().clips[0]!.keyframes.find((k) => k.id === 'ka');
    ok('a group can have its own curve', k2?.easing === 'overshoot' && k2?.curves?.grade?.easing === 'hold', { easing: k2?.easing, grade: k2?.curves?.grade });
    // Dragging a handle makes a custom curve.
    // (The overshoot's first handle sits above the box: it can still be grabbed.)
    $$('.curves-groups button').find((b) => b.textContent === 'All')?.click();
    await sleep(250);
    const h = $('.curve-handle[data-handle="1"]');
    if (h) {
      const r = h.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      await ace.selftestInput({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await ace.selftestInput({ type: 'mouseMove', x: x - 20, y: y - 30, button: 'left' });
      await ace.selftestInput({ type: 'mouseUp', x: x - 20, y: y - 30, button: 'left', clickCount: 1 });
      await sleep(300);
    }
    const k3 = api.getTimeline().clips[0]!.keyframes.find((k) => k.id === 'ka');
    ok('dragging a handle makes a custom curve', k3?.easing === 'custom' && !!k3.bezier, k3?.easing);
    await ace.capture('motion-curves');
    const text = api.saveText!();
    await api.restore!(text);
    await sleep(600);
    const k4 = api.getTimeline().clips[0]!.keyframes.find((k) => k.id === 'ka');
    ok('curves are saved and opened again', k4?.easing === 'custom' && k4.bezier?.length === 4 && k4.curves?.grade?.easing === 'hold', k4);
  });

  // --- Motion titles: every template draws, moves and is quick -----------------------------------
  await step('titles sheet', async () => {
    const W = 1920, H = 1080, cols = 5, cw = 384, ch = 216;
    const sheet = new OffscreenCanvas(cw * cols, ch * Math.ceil(TITLE_TEMPLATES.length / cols)), sx = sheet.getContext('2d')!;
    const cv = new OffscreenCanvas(W, H), x = cv.getContext('2d', { willReadFrequently: true })!;
    const ink = (T: number, o: Overlay) => { x.clearRect(0, 0, W, H); drawTitle(x, o, W, H, T); const d = x.getImageData(0, 0, W, H).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i]! > 20) n++; return { n, d }; };
    const bad: string[] = [], still: string[] = [];
    let worst = 0;
    TITLE_TEMPLATES.forEach((t, i) => {
      const o = { ...newTitleOverlay(t.id, 0, 4 * S), text: t.text.replace(/\{\w+\}/g, '49.2827° N'), subtitle: t.subtitle.replace(/\{\w+\}/g, '1,234 m') };
      const early = ink(0.15 * S, o), mid = ink(t.id === 'end-credits' ? 2 * S : 2 * S, o);
      if (mid.n < 200) bad.push(`${t.id}:${mid.n}`);
      let changed = 0;
      for (let k = 3; k < mid.d.length; k += 64) if (Math.abs(mid.d[k]! - early.d[k]!) > 30) changed++;
      if (changed < 50) still.push(`${t.id}:${changed}`);
      const t0 = performance.now();
      for (let r = 0; r < 5; r++) { x.clearRect(0, 0, W, H); drawTitle(x, o, W, H, 0.5 * S + r * 0.1 * S); }
      worst = Math.max(worst, (performance.now() - t0) / 5);
      const g = sx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, '#3a4a63'); g.addColorStop(1, '#2d3326');
      const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
      sx.fillStyle = g; sx.fillRect(cx, cy, cw, ch);
      ink(2 * S, o);
      sx.drawImage(cv, cx, cy, cw, ch);
      sx.fillStyle = '#fff'; sx.font = '14px sans-serif'; sx.fillText(t.name, cx + 6, cy + 18);
    });
    ok('every title template draws', !bad.length, bad);
    ok('every title moves in', !still.length, still);
    ok('titles draw quickly at 1080p', worst < 6, `${worst.toFixed(2)} ms`);
    const blob = await sheet.convertToBlob({ type: 'image/png' });
    await ace.writeFile(await ace.selftestOut('motion-titles-sheet.png'), new Uint8Array(await blob.arrayBuffer()));
  });

  // --- Titles and text on a path: preview against export -------------------------------------------
  await step('titles preview', async () => {
    const T = 2 * S;
    const title = { ...newTitleOverlay('lt-box', 0, 6 * S), text: 'Sam Rider', subtitle: 'Enduro' };
    const arc = { ...newTextOverlay(0, 6 * S, 'ON A CURVE'), x: 0.7, y: 0.35, size: 0.09, color: '#ffd400', path: { kind: 'arc' as const, bend: 0.6 } };
    const tl = tlWith(base(), { overlays: [title, arc] });
    api.setTimeline(tl);
    api.player.seek(T);
    await redraw();
    const frame = $('.frame')!.getBoundingClientRect();
    const shot = await ace.capture('motion-titles-preview');
    const sx = (await createImageBitmap(new Blob([(await ace.readAll(shot)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
    const shown = await readPicture(shot, { x: frame.left * sx, y: frame.top * sx, w: frame.width * sx, h: frame.height * sx }, { w: 192, h: 108 });
    const f = await framesAt(m, T);
    const layers: LayerFrame[] = [{ clip: tl.clips[0]!, index: 0, track: 0, media: m, layout: m.layout, level: 1, mediaUs: T, frames: f.frames }];
    const p = await ace.selftestOut('motion-titles-export.png');
    await grabFrame(tl, T, layers, p, 720);
    f.close();
    const exported = await readPicture(p, undefined, { w: 192, h: 108 });
    const d = diff(shown, exported);
    ok('titles look the same in the preview and the export', d < 9, +d.toFixed(2));
    // The white box of the lower third is where it should be in both.
    const white = (q: Pic, fx: number, fy: number) => { const i = (Math.round(fy * (q.h - 1)) * q.w + Math.round(fx * (q.w - 1))) * 4; return q.d[i]! > 220 && q.d[i + 1]! > 220 && q.d[i + 2]! > 220; };
    ok('the lower third sits bottom left', white(exported, 0.15, 0.86) && white(shown, 0.15, 0.86));
    // Text on a path draws along a curve: its ink spreads further up and down than straight text.
    const cv = new OffscreenCanvas(1280, 720), x = cv.getContext('2d', { willReadFrequently: true })!;
    const rows = (o: Overlay) => { x.clearRect(0, 0, 1280, 720); drawOverlays(x, 1280, 720, { ...tl, overlays: [o] }, T); const d2 = x.getImageData(0, 0, 1280, 720).data; let top = 720, bot = 0; for (let y = 0; y < 720; y++) for (let xx = 0; xx < 1280; xx += 4) if (d2[(y * 1280 + xx) * 4 + 3]! > 100) { top = Math.min(top, y); bot = Math.max(bot, y); } return bot - top; };
    const straight = rows({ ...arc, path: undefined }), curved = rows(arc), circle = rows({ ...arc, path: { kind: 'circle', bend: 1 } });
    ok('text bends along an arc and round a circle', curved > straight * 1.4 && circle > curved, { straight, curved, circle });
  });

  await step('titles inspector', async () => {
    api.setTimeline(tlWith(base()));
    api.player.seek(1 * S);
    await redraw();
    api.run!('titles');
    await sleep(500);
    await openSection(null, 'Motion title');
    const o = api.getTimeline().overlays[0];
    ok('Add a motion title adds one and selects it', o?.title === 'lt-bar' && $$('.title-picker .look').length >= 5, { title: o?.title, tiles: $$('.title-picker .look').length });
    $$('.title-cats button').find((b) => b.textContent === 'Title cards')?.click();
    await sleep(200);
    $('.title-picker .look[data-title="tc-drop"]')?.click();
    await sleep(300);
    const o2 = api.getTimeline().overlays[0];
    ok('picking another template changes the title (and its starting words)', o2?.title === 'tc-drop' && o2.text === 'DROP IN', { title: o2?.title, text: o2?.text });
    await ace.capture('motion-titles-inspector');
    const text = api.saveText!();
    await api.restore!(text);
    await sleep(500);
    ok('titles are saved and opened again', api.getTimeline().overlays[0]?.title === 'tc-drop');
  });

  // --- Sound tools ----------------------------------------------------------------------------------
  await step('sound', async () => {
    const ctx = new OfflineAudioContext(2, 4800, 48000);
    ok('the sound tools load', await loadSoundWorklet(ctx));
    const len = 6 * S;
    const plain = await mixTimeline(tlWith(base()), len);
    const windy = await mixTimeline(tlWith({ ...base(), sound: { low: 0, mid: 0, high: 0, lowCut: 0, comp: 'off', wind: 1 } }), len);
    const cut = await mixTimeline(tlWith({ ...base(), sound: { low: 0, mid: 0, high: 0, lowCut: 200, comp: 'off', wind: 0 } }), len);
    if (!plain || !windy || !cut) { ok('the clip has sound to test with', false); return; }
    const lowDrop = (b: AudioBuffer) => 10 * Math.log10(bandEnergy(plain, 30, 120) / Math.max(1e-12, bandEnergy(b, 30, 120)));
    ok('a low cut takes out rumble', lowDrop(cut) > 10, `${lowDrop(cut).toFixed(1)} dB`);
    ok('wind reduction turns the low band down', lowDrop(windy) > 0.5, `${lowDrop(windy).toFixed(1)} dB`);
    const voiceKeep = 10 * Math.log10(bandEnergy(plain, 1000, 3000) / Math.max(1e-12, bandEnergy(windy, 1000, 3000)));
    ok('and keeps the middle of the sound', Math.abs(voiceKeep) < 2, `${voiceKeep.toFixed(1)} dB`);
    await getMusic(musicPath);
    // A compressor brings the beats' peaks closer to the rest (on the music alone: the clip is silent).
    const silent = { ...base(), volume: 0 };
    const beat = (comp: 'off' | 'limit') => ({ ...newAudioClip(musicPath, 6 * S, 0), volume: 0.8, fadeOutUs: 0, sound: { low: 0, mid: 0, high: 0, lowCut: 0, comp, wind: 0 } });
    const crest = (b: AudioBuffer) => { const c = b.getChannelData(0); let pk = 0; for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]!)); return 20 * Math.log10(pk / Math.max(1e-9, rms(c))); };
    const raw = await mixTimeline(tlWith(silent, { audio: [beat('off')] }), len), squeezed = await mixTimeline(tlWith(silent, { audio: [beat('limit')] }), len);
    ok('the compressor evens out the sound', !!raw && !!squeezed && crest(squeezed) < crest(raw) - 1, raw && squeezed ? { before: +crest(raw).toFixed(1), after: +crest(squeezed).toFixed(1) } : 'silent');
    // Ducking: music goes down while the clip marked as talking plays.
    // (The "talking" is a clip's detached sound with bursts, the beats; the music a steady tone.)
    const tonePath = musicPath.replace('beats-120.wav', 'test-tone.wav');
    await getMusic(tonePath);
    const music = (duck: number) => ({ ...newAudioClip(tonePath, 6 * S, 0), volume: 0.5, fadeOutUs: 0, ...(duck ? { sound: { low: 0, mid: 0, high: 0, lowCut: 0, comp: 'off' as const, wind: 0, duck } } : {}) });
    const clip = { ...base(), audioDetached: true };
    const words = { ...newAudioClip(musicPath, 6 * S, 0), volume: 0.6, fadeOutUs: 0, linkedClipId: clip.id, sound: { low: 0, mid: 0, high: 0, lowCut: 0, comp: 'off' as const, wind: 0, voice: true } };
    const voiceOnly = await mixTimeline(tlWith(clip, { audio: [words] }), len);
    const both = await mixTimeline(tlWith(clip, { audio: [words, music(18)] }), len);
    const undDucked = await mixTimeline(tlWith(clip, { audio: [words, music(0)] }), len);
    const musicPart = (b: AudioBuffer) => { const a = b.getChannelData(0), v = voiceOnly!.getChannelData(0), d = new Float32Array(a.length); for (let i = 0; i < a.length; i++) d[i] = a[i]! - (v[i] ?? 0); return rms(d, 48000, a.length - 48000); };
    const ducked = 20 * Math.log10(musicPart(undDucked!) / Math.max(1e-9, musicPart(both!)));
    out.duckInfo = { voiceRms: +rms(voiceOnly!.getChannelData(0)).toFixed(5), music: +musicPart(undDucked!).toFixed(5), musicDucked: +musicPart(both!).toFixed(5) };
    // (On average over beats with a steady bass under them; how deep it goes under speech is in sound.test.ts.)
    ok('music ducks under talking', ducked > 3, `${ducked.toFixed(1)} dB`);
    // Live playback with the tools on starts and stops cleanly.
    api.setTimeline(tlWith({ ...base(), sound: { low: 2, mid: 0, high: 0, lowCut: 80, comp: 'gentle', wind: 0.6 } }));
    api.player.seek(0.5 * S);
    await redraw();
    api.player.play();
    await sleep(1500);
    const moved = api.player.time > 1 * S;
    api.player.pause();
    ok('plays with sound tools on', moved, api.player.time);
  });

  // --- Export queue, loudness, presets, batch ----------------------------------------------------------
  await step('queue', async () => {
    const short = tlWith({ ...base(), outUs: 2.5 * S }, { audio: [{ ...newAudioClip(musicPath, 2.5 * S, 0), volume: 0.8, fadeOutUs: 0 }] });
    const pa = await ace.selftestOut('motion-queue-a.mp4'), pb = await ace.selftestOut('motion-queue-b.mp4'), pc = await ace.selftestOut('motion-queue-c.mp4');
    const a = enqueue('a', short, { path: pa, resolution: 720, fps: 30, codec: 'avc', quality: 'standard', loudness: -14 });
    const b = enqueue('b', short, { path: pb, resolution: 720, fps: 30, codec: 'avc', quality: 'standard', loudness: null });
    const c = enqueue('c', short, { path: pc, resolution: 720, fps: 30, codec: 'avc', quality: 'standard' });
    cancelJob(c);
    const job = (id: string) => queueJobs().find((j) => j.id === id)!;
    ok('exports wait their turn', job(a).status === 'running' && job(b).status === 'waiting' && job(c).status === 'cancelled', [job(a).status, job(b).status, job(c).status]);
    // Pause once it is drawing frames.
    for (let i = 0; i < 200 && !(job(a).progress?.stage.startsWith('Rendering')); i++) await sleep(50);
    pauseJob(a);
    await sleep(400);
    const f0 = job(a).progress?.fraction ?? 0;
    await sleep(1200);
    const f1 = job(a).progress?.fraction ?? 0;
    ok('a paused export waits', job(a).status === 'paused' && f1 === f0 && job(b).status === 'waiting', { status: job(a).status, f0, f1 });
    resumeJob(a);
    for (let i = 0; i < 1200 && !['done', 'failed'].includes(job(b).status); i++) await sleep(100);
    ok('both exports finish after resuming', job(a).status === 'done' && job(b).status === 'done', [job(a).status, job(a).error, job(b).status, job(b).error]);
    const sa = job(a).result?.sound;
    ok('the export is at −14 LUFS with true peaks under −1 dBTP', !!sa && Math.abs(sa.after + 14) < 1 && sa.truePeak <= -0.9, sa);
    const sb = job(b).result?.sound;
    ok('“Leave as mixed” keeps the level and still holds the peaks', !!sb && sb.gainDb === 0 && sb.truePeak <= -0.9, sb);
    // Read the file back: its sound really is at that level.
    const back = await getMusic(pa).catch(() => null);
    if (back) {
      const buf = await back.sound.fetch(0);
      const ch = buf ? Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)) : [];
      if (ch.length) ok('the file’s sound measures the same', Math.abs(measureLufs(ch, buf!.sampleRate) + 14) < 1.5 && truePeakDb(ch) < -0.5, { lufs: +measureLufs(ch, buf!.sampleRate).toFixed(2), peak: +truePeakDb(ch).toFixed(2) });
    }
    // Batch: one export per video, with free names in the folder.
    const dir = (await ace.selftestOut('x')).replace(/[\\/][^\\/]+$/, '');
    const n1 = await ace.pathInFolder(dir, 'GX010133.MP4', 'mp4'), n2 = await ace.pathInFolder(dir, 'GX010133.MP4', 'mp4');
    ok('batch export gives each video a free name', n1 !== n2 && /GX010133( 2)?\.mp4$/.test(n2), [n1, n2]);
  });

  await step('export dialog', async () => {
    api.setTimeline(tlWith(base()));
    await redraw();
    api.run!('export');
    await sleep(600);
    const loud = $$('.modal select').find((s) => s.getAttribute('title')?.startsWith('How loud'));
    ok('Export has a sound level setting (−14 LUFS first)', (loud as HTMLSelectElement | undefined)?.value === '-14');
    ok('Export offers YouTube 1080p and Archive presets', ['YouTube 1080p', 'Archive (ProRes)'].every((n) => $$('.export-presets button').some((b) => b.textContent === n)));
    $$('.modal button').find((b) => b.textContent?.startsWith('Save these settings'))?.click();
    await sleep(200);
    const input = $('.modal input[aria-label="Name for these settings"]') as HTMLInputElement | null;
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My rides');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      $$('.modal button').find((b) => b.textContent === 'Save')?.click();
      await sleep(200);
    }
    ok('your own settings can be saved as a preset', $$('.export-presets .user-preset button').some((b) => b.textContent === 'My rides'));
    await ace.capture('motion-export');
    $$('.modal button').find((b) => b.textContent === 'Close')?.click();
    localStorage.removeItem('ace.exportPresets.v1');
    await sleep(200);
  });

  return { fails, ...out };
}

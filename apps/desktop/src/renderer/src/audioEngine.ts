// Audio for the edit: each clip's own sound (at its speed and volume) plus music,
// with fades. The same scheduling drives live playback and the offline export mix.

import { audioSpan, clipDuration, clipStarts, hasRamp, localAt, mediaAt, playLength, slowSpans, speedAt, speedBreaks, timelineDuration, transitionUs, type ConnectedClip, type Timed, type Timeline } from '@ace/project';
import { keepsPitch, stretchedSound } from './stretch';
import { BLOCK_PAD_S, clipSound, getMedia, getMusic, mediaNow, musicNow, type Sound } from './media';
import { compSettings, isNeutralSound, type SoundFx } from '@ace/project';
import workletUrl from './soundWorklet.ts?worker&url';

type Ctx = BaseAudioContext;

/** Contexts with the sound tools' worklet loaded (wind reduction and ducking need it). */
const workletReady = new WeakMap<BaseAudioContext, Promise<boolean>>();
export function loadSoundWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = workletReady.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(workletUrl).then(() => { hasWorklet.add(ctx); return true; }, (e) => { console.warn('Sound tools worklet failed to load', e); return false; });
    workletReady.set(ctx, p);
  }
  return p;
}
const hasWorklet = new WeakSet<BaseAudioContext>();

/** Worklet nodes made for one playback, so they can be stopped (they would run on otherwise). */
type Made = AudioWorkletNode[];

/**
 * A sound's tools as a chain of nodes ending in `dest`: wind reduction, low cut, 3-band EQ,
 * compressor. Returns the node to connect the sound to (`dest` itself when there's nothing to do).
 * With `tap`, the processed sound also goes there (talking that music ducks under).
 */
function soundChain(ctx: Ctx, fx: SoundFx | undefined, dest: AudioNode, made: Made, tap?: AudioNode): AudioNode {
  if (isNeutralSound(fx)) { if (tap) { const g = ctx.createGain(); g.connect(dest); g.connect(tap); return g; } return dest; }
  const nodes: AudioNode[] = [];
  if (fx!.wind > 0 && hasWorklet.has(ctx)) {
    const w = new AudioWorkletNode(ctx, 'ace-wind', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { strength: fx!.wind } });
    made.push(w);
    nodes.push(w);
  }
  if (fx!.lowCut > 0) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = fx!.lowCut; f.Q.value = 0.707;
    nodes.push(f);
  }
  const band = (type: BiquadFilterType, freq: number, gain: number, q?: number) => {
    if (!gain) return;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.gain.value = gain;
    if (q) f.Q.value = q;
    nodes.push(f);
  };
  band('lowshelf', 150, fx!.low);
  band('peaking', 1000, fx!.mid, 0.9);
  band('highshelf', 6000, fx!.high);
  const cs = compSettings(fx!.comp);
  if (cs) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = cs.threshold; c.knee.value = cs.knee; c.ratio.value = cs.ratio; c.attack.value = cs.attack; c.release.value = cs.release;
    const up = ctx.createGain();
    up.gain.value = 10 ** (cs.makeup / 20);
    nodes.push(c, up);
  }
  if (!nodes.length) return dest;
  for (let i = 0; i + 1 < nodes.length; i++) nodes[i]!.connect(nodes[i + 1]!);
  const last = nodes[nodes.length - 1]!;
  last.connect(dest);
  if (tap) last.connect(tap);
  return nodes[0]!;
}

/** Music that ducks under talking: music → duck ← talking (speech band only). */
function duckChain(ctx: Ctx, depthDb: number, dest: AudioNode, key: AudioNode, made: Made): AudioNode {
  if (!hasWorklet.has(ctx) || depthDb <= 0) return dest;
  const d = new AudioWorkletNode(ctx, 'ace-duck', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { depth: depthDb } });
  made.push(d);
  key.connect(d, 0, 1);
  d.connect(dest);
  return d;
}

/** One stretch of one sound: what is heard, when, and how far it has been scheduled. */
interface Voice {
  sound: Sound;
  out: GainNode;
  /** The stretch of media heard (s). */
  from: number;
  to: number;
  /** Context time at which a media time (s) is heard, and the other way round. */
  when(media: number): number;
  media(when: number): number;
  /** Speed at a media time. */
  rate(media: number): number;
  /** Media times (s) between which the speed changes in one go; null = one speed throughout. */
  breaks: number[] | null;
  /** Next block to schedule (-1 = none left). */
  next: number;
}
const FADE_S = 0.005;
const MUTE_FADE_S = 0.12;

/**
 * Everything audible from timeline time T onwards, starting at context time `when`
 * (volumes and fades are set up; the sound itself is scheduled by `feed`).
 */
function voices(ctx: Ctx, dest: AudioNode, tl: Timeline, T: number, when: number, sounds: Map<string, Sound | null>, made: Made = []): Voice[] {
  const out: Voice[] = [];
  // Talking that music ducks under: only built when some music ducks.
  const ducks = tl.audio.some((a) => (a.sound?.duck ?? 0) > 0) && hasWorklet.has(ctx);
  let key: AudioNode | undefined;
  if (ducks) {
    // Just the speech band, so footsteps and rumble don't duck the music.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.6;
    key = bp;
  }
  const tapFor = (fx: SoundFx | undefined) => (key && fx?.voice ? key : undefined);
  /** `c` from `skip` µs after its start, `len` µs long, heard from context time `at`. */
  const add = (base: Sound, gain: GainNode, at: number, clip: Timed & { keepPitch?: boolean }, skip: number, len: number, muteBelow = 0, id = '') => {
    // Pitch kept: the sound is already in clip time, played as it is.
    const kept = keepsPitch(clip) && base.blockS !== Infinity;
    const sound = kept ? stretchedSound(base, clip, id) : base;
    const c: Timed = kept ? { inUs: 0, outUs: playLength(clip), speed: 1 } : clip;
    const from = mediaAt(c, skip) / 1e6, to = Math.min(sound.seconds, mediaAt(c, skip + len) / 1e6);
    if (to <= from) return;
    const slow = muteBelow > 0 ? slowSpans(clip, muteBelow).filter(([a, b]) => b > skip && a < skip + len) : [];
    if (slow.length && slow[0]![0] <= skip && slow[0]![1] >= skip + len) return;
    let node = gain;
    if (slow.length) {
      // Silent where it is too slow, fading out just before and in just after.
      const g = ctx.createGain(), F = MUTE_FADE_S;
      const t = (local: number) => Math.max(at, at + (local - skip) / 1e6);
      g.gain.setValueAtTime(slow[0]![0] <= skip ? 0 : 1, at);
      for (const [a, b] of slow) {
        if (a > skip) { g.gain.setValueAtTime(1, Math.max(at, t(a) - F)); g.gain.linearRampToValueAtTime(0, t(a)); }
        if (b < skip + len) { g.gain.setValueAtTime(0, t(b)); g.gain.linearRampToValueAtTime(1, t(b) + F); }
      }
      g.connect(gain);
      node = g;
    }
    out.push({
      sound, out: node, from, to, next: Math.floor(from / sound.blockS) || 0,
      when: (m) => at + (localAt(c, m * 1e6) - skip) / 1e6,
      media: (w) => mediaAt(c, skip + (w - at) * 1e6) / 1e6,
      rate: (m) => speedAt(c, m * 1e6),
      breaks: hasRamp(c) ? speedBreaks(c, from * 1e6, to * 1e6).map((x) => x / 1e6) : null,
    });
  };
  const starts = clipStarts(tl);
  // Solo sound: while a clip set to solo plays, the other clips' sound is silent (music isn't).
  const solos = mergeSpans(soloSpans(tl).filter((x) => x.end > T));
  const ct = (t: number) => when + Math.max(0, t - T) / 1e6;
  /** Where a clip's sound goes: straight out, or through a gate that is shut while another clip is solo. */
  const outFor = (id: string, from: number, to: number): AudioNode => {
    // (Clips set to solo are all heard, like solo in a mixer.)
    if (solos.some((x) => x.ids.includes(id))) return dest;
    const shut = solos.filter((x) => x.end > Math.max(from, T) && x.start < to);
    if (!shut.length) return dest;
    const q = ctx.createGain(), F = MUTE_FADE_S;
    q.connect(dest);
    q.gain.setValueAtTime(shut.some((x) => x.start <= T && x.end > T) ? 0 : 1, when);
    for (const x of shut) {
      if (x.start > T) { q.gain.setValueAtTime(1, Math.max(when, ct(x.start) - F)); q.gain.linearRampToValueAtTime(0, ct(x.start)); }
      q.gain.setValueAtTime(0, ct(x.end));
      q.gain.linearRampToValueAtTime(1, ct(x.end) + F);
    }
    return q;
  };
  tl.clips.forEach((c, i) => {
    const sound = sounds.get(c.mediaPath);
    if (!sound || c.volume <= 0 || c.audioDetached) return;
    const s = starts[i]!, d = clipDuration(c);
    if (s + d <= T) return;
    const skip = Math.max(0, T - s); // timeline µs already played
    const g = ctx.createGain();
    g.connect(soundChain(ctx, c.sound, outFor(c.id, s, s + d), made, tapFor(c.sound)));
    const at = when + Math.max(0, s - T) / 1e6;
    // Crossfade the sound across transitions (fade in over the incoming overlap, out over the outgoing one).
    const fin = transitionUs(tl, i) / 1e6, fout = transitionUs(tl, i + 1) / 1e6, len = d / 1e6;
    const env = (x: number) => c.volume * Math.min(1, fin > 0 ? x / fin : 1, fout > 0 ? (len - x) / fout : 1);
    const x0 = skip / 1e6;
    g.gain.setValueAtTime(env(x0), at);
    const ramp = (a: number, b: number) => { for (let x = Math.max(x0, Math.ceil(a * 20) / 20); x <= Math.min(len, b); x += 0.05) g.gain.linearRampToValueAtTime(Math.max(0, env(x)), at + (x - x0)); };
    // (Only where it changes: a long clip would need tens of thousands of points.)
    if (fin > 0) { ramp(0, fin); g.gain.linearRampToValueAtTime(Math.max(0, env(Math.max(x0, fin))), at + Math.max(0, fin - x0)); }
    if (fout > 0) {
      const from = Math.max(x0, len - fout);
      g.gain.setValueAtTime(Math.max(0, env(from)), at + (from - x0));
      ramp(from, len);
    }
    add(sound, g, at, c, skip, d - skip, c.muteBelow, c.mediaPath);
  });

  // Clips on the tracks above the main row (not on muted or hidden tracks), cut at the end of the edit.
  const total = timelineDuration(tl);
  for (const c of heardConnected(tl)) {
    const sound = sounds.get(c.mediaPath);
    const s = c.startUs, d = Math.min(playLength(c), total - s);
    if (!sound || c.volume <= 0 || d <= 0 || s + d <= T) continue;
    const skip = Math.max(0, T - s);
    const g = ctx.createGain();
    g.connect(soundChain(ctx, c.sound, outFor(c.id, s, s + d), made, tapFor(c.sound)));
    const at = when + Math.max(0, s - T) / 1e6;
    g.gain.setValueAtTime(c.volume, at);
    add(sound, g, at, c, skip, d - skip, c.muteBelow, c.mediaPath);
  }

  for (const a of tl.audio) {
    const m = musicNow.get(a.path);
    if (!m) continue;
    const { start, end } = audioSpan(tl, a);
    if (end <= T || end <= start) continue;
    const skip = Math.max(0, T - start);
    const g = ctx.createGain();
    // (A clip's own detached sound is silenced like the clip; music plays on.)
    const after = a.linkedClipId ? outFor(a.linkedClipId, start, end) : dest;
    const ducked = key && (a.sound?.duck ?? 0) > 0 && !a.linkedClipId ? duckChain(ctx, a.sound!.duck!, after, key, made) : after;
    g.connect(soundChain(ctx, a.sound, ducked, made, a.linkedClipId ? tapFor(a.sound) : undefined));
    const at = when + Math.max(0, start - T) / 1e6;
    const len = (end - start) / 1e6;
    // Volume envelope in timeline seconds relative to the music's start.
    const env = (x: number) => {
      const fi = a.fadeInUs / 1e6, fo = a.fadeOutUs / 1e6;
      let v = a.volume;
      if (fi > 0 && x < fi) v *= x / fi;
      if (fo > 0 && x > len - fo) v *= Math.max(0, (len - x) / fo);
      return v;
    };
    const t0 = skip / 1e6;
    g.gain.setValueAtTime(env(t0), at);
    for (let x = Math.ceil(t0 * 10) / 10; x <= len; x += 0.1) g.gain.linearRampToValueAtTime(env(x), at + (x - t0));
    add(m.sound, g, at, a, skip, end - start - skip, a.muteBelow, a.path);
  }
  return out;
}

interface SoloSpan { start: number; end: number; ids: string[] }
/** Where clips set to solo play (timeline µs). */
export function soloSpans(tl: Timeline): SoloSpan[] {
  const out: SoloSpan[] = [];
  const starts = clipStarts(tl);
  tl.clips.forEach((c, i) => { if (c.soloSound) out.push({ start: starts[i]!, end: starts[i]! + clipDuration(c), ids: [c.id] }); });
  for (const c of heardConnected(tl)) if (c.soloSound) out.push({ start: c.startUs, end: c.startUs + playLength(c), ids: [c.id] });
  return out;
}
/** Overlapping spans joined (keeping which clips each came from). */
function mergeSpans(list: SoloSpan[]): SoloSpan[] {
  const out: SoloSpan[] = [];
  for (const x of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) { last.end = Math.max(last.end, x.end); last.ids = [...last.ids, ...x.ids]; } else out.push({ ...x, ids: [...x.ids] });
  }
  return out;
}

/** Track clips whose sound is heard. */
const heardConnected = (tl: Timeline): ConnectedClip[] =>
  tl.connected.filter((c) => { const t = tl.tracks.find((x) => x.id === c.trackId); return !!t && !t.muted && !t.hidden; });

/** Makes a source's speed follow the ramp from media time `a` to `b`, starting at context time `at`. */
function follow(rate: AudioParam, v: Voice, a: number, b: number, at: number) {
  const marks = [a, ...v.breaks!.filter((x) => x > a && x < b), b];
  rate.value = v.rate(a);
  rate.setValueAtTime(v.rate(a + 1e-7), at);
  for (let i = 0; i + 1 < marks.length; i++) {
    const m0 = marks[i]! + 1e-7, m1 = marks[i + 1]! - 1e-7, t0 = Math.max(at, v.when(m0)), t1 = v.when(m1);
    const s0 = v.rate(m0), s1 = v.rate(m1);
    rate.setValueAtTime(s0, t0);
    if (Math.abs(s0 - s1) < 1e-6) continue;
    const n = Math.min(2000, Math.max(8, Math.ceil((t1 - t0) / 0.015)));
    for (let k = 1; k <= n; k++) { const t = t0 + ((t1 - t0) * k) / n; rate.linearRampToValueAtTime(k === n ? s1 : v.rate(v.media(t)), t); }
  }
}

/** Schedules a voice's blocks that are decoded and start before `until`. Returns the block it waits for, if any. */
function feed(ctx: Ctx, v: Voice, until: number, now: number, nodes: AudioScheduledSourceNode[], get: (s: Sound, i: number) => AudioBuffer | null | undefined): number | null {
  while (v.next >= 0) {
    const L = v.sound.blockS, i = v.next, base = L === Infinity ? 0 : i * L;
    const a = Math.max(v.from, base), b = Math.min(v.to, base + L);
    if (b <= a) { v.next = -1; break; }
    const start = v.when(a);
    if (start >= until) return null;
    const buf = get(v.sound, i);
    if (buf === undefined) return i;
    v.next = b >= v.to - 1e-9 ? -1 : i + 1;
    if (!buf) continue;
    // Decoded too late to start on time: join in where it should be by now.
    const late = now > start ? v.media(now) - a : 0;
    if (a + late >= b) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const at = Math.max(start, now), more = v.next >= 0 ? Math.min(BLOCK_PAD_S, FADE_S * v.rate(b)) : 0;
    if (!v.breaks) src.playbackRate.value = v.rate(a);
    else follow(src.playbackRate, v, a + late, b, at);
    let out: AudioNode = v.out;
    // Blocks overlap for a moment and are faded across, so the seam can't be heard.
    const fadeIn = a > v.from && late === 0;
    if (fadeIn || more > 0) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(fadeIn ? 0 : 1, at);
      if (fadeIn) g.gain.linearRampToValueAtTime(1, at + FADE_S);
      if (more > 0) {
        const end = v.when(b);
        g.gain.setValueAtTime(1, Math.max(at + (fadeIn ? FADE_S : 0), end));
        g.gain.linearRampToValueAtTime(0, end + FADE_S);
      }
      g.connect(v.out);
      out = g;
    }
    src.connect(out);
    src.start(at, a + late - base, b - a - late + more);
    nodes.push(src);
  }
  return null;
}

/** Everything with sound that the timeline needs. */
export async function loadTimelineAudio(tl: Timeline): Promise<Map<string, Sound | null>> {
  const out = new Map<string, Sound | null>();
  for (const c of [...tl.clips, ...heardConnected(tl)]) {
    if (out.has(c.mediaPath)) continue;
    const m = mediaNow(c.mediaPath) ?? (await getMedia(c.mediaPath).catch(() => null));
    out.set(c.mediaPath, m ? clipSound(m) : null);
  }
  for (const a of tl.audio) await getMusic(a.path).then((m) => musicNow.set(a.path, m)).catch(() => {});
  return out;
}

/** How far ahead of the playhead sound is decoded and scheduled (s). */
const AHEAD_S = 25;

export class AudioPlayer {
  private ctx = new AudioContext({ latencyHint: 'interactive' });
  private nodes: AudioScheduledSourceNode[] = [];
  private sounds = new Map<string, Sound | null>();
  private master = this.ctx.createGain();
  private live: Voice[] = [];
  private made: Made = [];
  private run = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.master.connect(this.ctx.destination);
  }

  /** Call after the timeline's media changes; loading happens in the background. */
  async prepare(tl: Timeline) {
    await loadSoundWorklet(this.ctx);
    this.sounds = await loadTimelineAudio(tl);
  }

  /** Decodes what would be heard first from T, so pressing play starts with sound. */
  prime(tl: Timeline, T: number) {
    const starts = clipStarts(tl);
    tl.clips.forEach((c, i) => {
      const s = this.sounds.get(c.mediaPath), from = starts[i]!;
      if (!s || c.audioDetached || from + clipDuration(c) <= T || from > T + 2e6) return;
      const local = Math.max(0, T - from);
      if (s.blockS === Infinity) return;
      if (keepsPitch(c)) { const st = stretchedSound(s, c, c.mediaPath); void st.fetch(Math.floor(local / 1e6 / st.blockS)); return; }
      const block = (l: number) => Math.max(0, Math.floor(mediaAt(c, l) / 1e6 / s.blockS));
      void s.fetch(block(local)); void s.fetch(block(local + 3e6));
    });
    for (const c of heardConnected(tl)) {
      const s = this.sounds.get(c.mediaPath);
      if (!s || s.blockS === Infinity || c.startUs + playLength(c) <= T || c.startUs > T + 2e6) continue;
      const local = Math.max(0, T - c.startUs);
      if (keepsPitch(c)) { const st = stretchedSound(s, c, c.mediaPath); void st.fetch(Math.floor(local / 1e6 / st.blockS)); continue; }
      void s.fetch(Math.max(0, Math.floor(mediaAt(c, local) / 1e6 / s.blockS)));
    }
    for (const a of tl.audio) {
      const s = musicNow.get(a.path)?.sound;
      const { start, end } = audioSpan(tl, a);
      if (s && s.blockS !== Infinity && end > T && start <= T + 2e6) void s.fetch(Math.floor(mediaAt(a, Math.max(0, T - start)) / 1e6 / s.blockS));
    }
  }

  play(tl: Timeline, T: number) {
    this.stop();
    void this.ctx.resume();
    this.live = voices(this.ctx, this.master, tl, T, this.ctx.currentTime + 0.03, this.sounds, this.made);
    this.more();
    this.timer = setInterval(() => this.more(), 1000);
  }

  private more() {
    const run = this.run;
    for (const v of this.live) {
      const waits = feed(this.ctx, v, this.ctx.currentTime + AHEAD_S, this.ctx.currentTime + 0.005, this.nodes, (s, i) => s.ready(i));
      if (waits !== null) void v.sound.fetch(waits).then(() => { if (run === this.run) this.more(); });
    }
  }

  stop() {
    this.run++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.live = [];
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.nodes = [];
    for (const w of this.made) { w.port.postMessage('stop'); w.disconnect(); }
    this.made = [];
  }

  set muted(m: boolean) {
    this.master.gain.value = m ? 0 : 1;
  }
}

/** Renders the whole edit's audio for export. Returns null if the edit is silent. */
export async function mixTimeline(tl: Timeline, durationUs: number, sampleRate = 48000): Promise<AudioBuffer | null> {
  const sounds = await loadTimelineAudio(tl);
  const anything = [...sounds.values()].some(Boolean) || tl.audio.some((a) => musicNow.has(a.path));
  if (!anything || durationUs <= 0) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil((durationUs / 1e6) * sampleRate), sampleRate);
  await loadSoundWorklet(ctx);
  const held = new Map<Sound, Map<number, AudioBuffer | null>>();
  for (const v of voices(ctx, ctx.destination, tl, 0, 0, sounds)) {
    for (;;) {
      const waits = feed(ctx, v, Infinity, 0, [], (s, i) => held.get(s)?.get(i));
      if (waits === null) break;
      const b = await v.sound.fetch(waits);
      if (!held.has(v.sound)) held.set(v.sound, new Map());
      held.get(v.sound)!.set(waits, b);
    }
  }
  return ctx.startRendering();
}

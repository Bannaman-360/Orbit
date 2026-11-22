// Audio for the edit: each clip's own sound (at its speed and volume) plus music,
// with fades. The same scheduling drives live playback and the offline export mix.

import { audioSpan, clipDuration, clipStarts, transitionUs, type Timeline } from '@ace/project';
import { getClipAudio, getMedia, getMusic, mediaNow, musicNow } from './media';

type Ctx = BaseAudioContext;

/**
 * Schedules everything audible from timeline time T onwards, starting at context
 * time `when`. Returns the created nodes so they can be stopped.
 */
function schedule(ctx: Ctx, dest: AudioNode, tl: Timeline, T: number, when: number, clipBuffers: Map<string, AudioBuffer | null>): AudioScheduledSourceNode[] {
  const nodes: AudioScheduledSourceNode[] = [];
  const starts = clipStarts(tl);
  tl.clips.forEach((c, i) => {
    const buf = clipBuffers.get(c.mediaPath);
    if (!buf || c.volume <= 0 || c.audioDetached) return;
    const s = starts[i]!, d = clipDuration(c);
    if (s + d <= T) return;
    const skip = Math.max(0, T - s); // timeline µs already played
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;
    const g = ctx.createGain();
    src.connect(g).connect(dest);
    const at = when + Math.max(0, s - T) / 1e6;
    // Crossfade the sound across transitions (fade in over the incoming overlap, out over the outgoing one).
    const fin = transitionUs(tl, i) / 1e6, fout = transitionUs(tl, i + 1) / 1e6, len = d / 1e6;
    const env = (x: number) => c.volume * Math.min(1, fin > 0 ? x / fin : 1, fout > 0 ? (len - x) / fout : 1);
    const x0 = skip / 1e6;
    g.gain.setValueAtTime(env(x0), at);
    if (fin > 0 || fout > 0) for (let x = Math.ceil(x0 * 20) / 20; x <= len; x += 0.05) g.gain.linearRampToValueAtTime(Math.max(0, env(x)), at + (x - x0));
    src.start(at, (c.inUs + skip * c.speed) / 1e6, ((d - skip) * c.speed) / 1e6);
    nodes.push(src);
  });

  for (const a of tl.audio) {
    const m = musicNow.get(a.path);
    if (!m) continue;
    const { start, end } = audioSpan(tl, a);
    if (end <= T || end <= start) continue;
    const skip = Math.max(0, T - start);
    const rate = a.speed ?? 1;
    const src = ctx.createBufferSource();
    src.buffer = m.buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    src.connect(g).connect(dest);
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
    src.start(at, (a.inUs + skip * rate) / 1e6, ((end - start - skip) * rate) / 1e6);
    nodes.push(src);
  }
  return nodes;
}

/** Loads every audio buffer the timeline needs. */
export async function loadTimelineAudio(tl: Timeline): Promise<Map<string, AudioBuffer | null>> {
  const out = new Map<string, AudioBuffer | null>();
  for (const c of tl.clips) {
    if (out.has(c.mediaPath)) continue;
    const m = mediaNow(c.mediaPath) ?? (await getMedia(c.mediaPath).catch(() => null));
    out.set(c.mediaPath, m ? await getClipAudio(m) : null);
  }
  for (const a of tl.audio) await getMusic(a.path).then((m) => musicNow.set(a.path, m)).catch(() => {});
  return out;
}

export class AudioPlayer {
  private ctx = new AudioContext({ latencyHint: 'interactive' });
  private nodes: AudioScheduledSourceNode[] = [];
  private buffers = new Map<string, AudioBuffer | null>();
  private master = this.ctx.createGain();

  constructor() {
    this.master.connect(this.ctx.destination);
  }

  /** Call after the timeline's media changes; loading happens in the background. */
  async prepare(tl: Timeline) {
    this.buffers = await loadTimelineAudio(tl);
  }

  play(tl: Timeline, T: number) {
    this.stop();
    void this.ctx.resume();
    this.nodes = schedule(this.ctx, this.master, tl, T, this.ctx.currentTime + 0.03, this.buffers);
  }

  stop() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.nodes = [];
  }

  set muted(m: boolean) {
    this.master.gain.value = m ? 0 : 1;
  }
}

/** Renders the whole edit's audio for export. Returns null if the edit is silent. */
export async function mixTimeline(tl: Timeline, durationUs: number, sampleRate = 48000): Promise<AudioBuffer | null> {
  const buffers = await loadTimelineAudio(tl);
  const anything = [...buffers.values()].some(Boolean) || tl.audio.some((a) => musicNow.has(a.path));
  if (!anything || durationUs <= 0) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil((durationUs / 1e6) * sampleRate), sampleRate);
  schedule(ctx, ctx.destination, tl, 0, 0, buffers);
  return ctx.startRendering();
}

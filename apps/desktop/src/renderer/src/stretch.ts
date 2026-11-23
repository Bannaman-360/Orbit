// A clip's sound at the clip's speed (or ramp) without changing its pitch. Blocks are in clip
// time (seconds from the clip's start), made from the recording's own blocks.

import { hasRamp, mediaAt, playLength, type Timed } from '@ace/project';
import { BLOCK_PAD_S, type Sound } from './media';
import { HOP, SEEK, WIN, wsola } from './wsola';

const BLOCK_S = 10;
const KEEP = 6;

let worker: Worker | null = null, nextId = 0;
const waiting = new Map<number, (out: Float32Array[]) => void>();
function stretchAway(src: Float32Array[], centres: Float64Array, length: number): Promise<Float32Array[]> {
  try {
    worker ??= new Worker(new URL('./stretchWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; out: Float32Array[] }>) => { waiting.get(e.data.id)?.(e.data.out); waiting.delete(e.data.id); };
  } catch {
    return Promise.resolve(wsola(src, centres, length));
  }
  const id = nextId++;
  return new Promise((res) => { waiting.set(id, res); worker!.postMessage({ id, src, centres, length }, src.map((s) => s.buffer as ArrayBuffer)); });
}

/** Whether a clip's sound needs stretching (another speed, and its pitch kept). */
export const keepsPitch = (c: Timed & { keepPitch?: boolean }) => c.keepPitch !== false && (hasRamp(c) || Math.abs((c.speed ?? 1) - 1) > 1e-6);

class StretchedSound implements Sound {
  readonly blockS = BLOCK_S;
  readonly seconds: number;
  private blocks = new Map<number, AudioBuffer | null>();
  private loading = new Map<number, Promise<AudioBuffer | null>>();
  constructor(private base: Sound, private clip: Timed) {
    this.seconds = playLength(clip) / 1e6;
  }
  ready(i: number) { return this.blocks.get(i); }
  fetch(i: number): Promise<AudioBuffer | null> {
    const b = this.blocks.get(i);
    if (b !== undefined) return Promise.resolve(b);
    let p = this.loading.get(i);
    if (!p) {
      p = this.make(i).catch(() => null).then((x) => {
        this.loading.delete(i);
        this.blocks.set(i, x);
        for (const k of this.blocks.keys()) { if (this.blocks.size <= KEEP) break; this.blocks.delete(k); }
        return x;
      });
      this.loading.set(i, p);
    }
    return p;
  }
  private async make(i: number): Promise<AudioBuffer | null> {
    const t0 = i * BLOCK_S, t1 = Math.min(this.seconds, (i + 1) * BLOCK_S + BLOCK_PAD_S);
    if (t1 <= t0) return null;
    // Where the original is read, for each step (from one window before the block on).
    const first = await this.base.fetch(Math.max(0, Math.floor(mediaAt(this.clip, t0 * 1e6) / 1e6 / this.base.blockS)));
    if (!first) return null;
    const rate = first.sampleRate, lead = WIN, length = Math.ceil((t1 - t0) * rate);
    const steps = Math.ceil((length + lead) / HOP) + 2;
    const centres = new Float64Array(steps);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < steps; k++) {
      const t = t0 + (k * HOP + WIN / 2 - lead) / rate;
      const s = (mediaAt(this.clip, t * 1e6) / 1e6) * rate;
      centres[k] = s;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    const from = Math.max(0, Math.floor(lo - WIN - SEEK)), to = Math.ceil(hi + WIN + SEEK);
    // The original's samples for that, from its own blocks.
    const L = this.base.blockS;
    const chans = first.numberOfChannels, src = Array.from({ length: chans }, () => new Float32Array(to - from));
    for (let b = Math.floor(from / rate / L); b * L * rate < to; b++) {
      const buf = b === Math.floor(mediaAt(this.clip, t0 * 1e6) / 1e6 / L) ? first : await this.base.fetch(b);
      if (!buf) continue;
      const start = Math.round(b * L * rate);
      for (let c = 0; c < chans; c++) {
        const d = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        const a = Math.max(from, start), z = Math.min(to, start + d.length);
        if (z > a) src[c]!.set(d.subarray(a - start, z - start), a - from);
      }
    }
    for (let k = 0; k < steps; k++) centres[k] = centres[k]! - from;
    const out = await stretchAway(src, centres, length + lead);
    const ab = new AudioBuffer({ length, numberOfChannels: chans, sampleRate: rate });
    out.forEach((o, c) => ab.copyToChannel(new Float32Array(o.subarray(lead, lead + length)), c));
    return ab;
  }
}

const made = new Map<string, StretchedSound>();
/** The stretched sound of a clip (one per sound, start and speed). */
export function stretchedSound(base: Sound, c: Timed, id: string): Sound {
  const key = `${id}|${c.inUs}|${c.speed ?? 1}|${c.speedKeys?.map((k) => `${k.t}@${k.speed}${k.ease ?? ''}`).join() ?? ''}`;
  let s = made.get(key);
  if (!s) {
    made.set(key, (s = new StretchedSound(base, { inUs: c.inUs, outUs: c.outUs, speed: c.speed, speedKeys: c.speedKeys })));
    for (const k of made.keys()) { if (made.size <= 12) break; made.delete(k); }
  }
  return s;
}

// Captions (auto subtitles): what was said and when, as text overlays tagged `caption`, and as
// an .srt file. Long sentences are split into short captions that are easy to read.

import { newTextOverlay, TEXT_PRESETS, type Overlay } from './overlays';
import type { Timeline } from './timeline';

/** Something said, on the timeline (µs). */
export interface Spoken { startUs: number; endUs: number; text: string }

/** At most this many characters on a line, and two lines on screen. */
export const CAPTION_LINE = 42;
const MIN_US = 900_000, MAX_US = 6_000_000;

/** Breaks text into lines of at most `width` characters, at spaces. */
export function wrapLines(text: string, width = CAPTION_LINE): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Turns what was said into captions: each at most two lines, shown for at least 0.9 s and at most
 * 6 s, never overlapping the next. A long stretch is split with its time shared out by length.
 */
export function makeCaptions(said: Spoken[]): Spoken[] {
  const out: Spoken[] = [];
  for (const s of said) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    if (!text || s.endUs <= s.startUs) continue;
    const lines = wrapLines(text);
    const groups: string[] = [];
    for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2).join('\n'));
    const total = groups.reduce((n, g) => n + g.length, 0);
    let t = s.startUs;
    for (const g of groups) {
      const d = ((s.endUs - s.startUs) * g.length) / total;
      out.push({ startUs: Math.round(t), endUs: Math.round(t + d), text: g });
      t += d;
    }
  }
  out.sort((a, b) => a.startUs - b.startUs);
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!, next = out[i + 1];
    let end = Math.min(c.startUs + MAX_US, Math.max(c.endUs, c.startUs + MIN_US));
    if (next) end = Math.min(end, next.startUs);
    c.endUs = Math.max(c.startUs + 1, end);
  }
  return out;
}

const SUBTITLE_STYLE = TEXT_PRESETS.find(([n]) => n === 'Subtitle')![1];

/** Caption overlays for the timeline, styled as subtitles near the bottom. */
export function captionOverlays(captions: Spoken[]): Overlay[] {
  return captions.map((c) => ({ ...newTextOverlay(c.startUs, c.endUs, c.text), ...SUBTITLE_STYLE, y: 0.86, size: 0.045, animation: 'none', caption: true }));
}

/** The timeline with its captions replaced by these (other text stays). */
export function withCaptions(tl: Timeline, captions: Overlay[]): Timeline {
  return { ...tl, overlays: [...tl.overlays.filter((o) => !o.caption), ...captions] };
}

const srtTime = (us: number) => {
  const ms = Math.max(0, Math.round(us / 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** The timeline's captions as an .srt file. */
export function toSrt(tl: Timeline): string {
  return tl.overlays
    .filter((o) => o.caption && o.text.trim())
    .sort((a, b) => a.startUs - b.startUs)
    .map((o, i) => `${i + 1}\n${srtTime(o.startUs)} --> ${srtTime(o.endUs)}\n${o.text.trim()}\n`)
    .join('\n');
}

/** Reads an .srt file (for checking, and to bring captions back in). */
export function fromSrt(text: string): Spoken[] {
  const t = (s: string) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? ((+m[1]! * 60 + +m[2]!) * 60 + +m[3]!) * 1e6 + +m[4]!.padEnd(3, '0').slice(0, 3) * 1000 : NaN; };
  return text.replace(/\r/g, '').split(/\n\s*\n/).map((block) => {
    const lines = block.trim().split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) return null;
    const [a, b] = lines[at]!.split('-->');
    return { startUs: t(a!), endUs: t(b!), text: lines.slice(at + 1).join('\n') };
  }).filter((x): x is Spoken => !!x && Number.isFinite(x.startUs) && Number.isFinite(x.endUs));
}

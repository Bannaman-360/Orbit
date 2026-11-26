// Highlights: the moments of a clip worth showing (HiLight tags, jumps, top speed, hard hits; see
// packages/telemetry/src/highlights.ts). The Highlights section lists them; they can be marked on
// the timeline or cut into a highlight reel at the end of it.

import { useState } from 'react';
import { localAt, mediaToTimeline, newId, type TimelineClip } from '@ace/project';
import { bestHighlights, type Highlight, type HighlightKind } from '@ace/telemetry';
import type { Media } from './media';
import { fmtJumpLength, usesFeet } from './gaugeMath';
import { fmtTime, Section, Seg } from './ui';

export const KIND_NAME: Record<HighlightKind, string> = { tag: 'HiLight tag', jump: 'Jump', speed: 'Top speed', hit: 'Hard hit' };

export const fmtRideSpeed = (ms: number, feet = usesFeet()) => (feet ? `${Math.round(ms * 2.23694)} mph` : `${Math.round(ms * 3.6)} km/h`);

/** What makes it a highlight, in a few words: "Jump · 0.82 s · 6.1 m". */
export function highlightDetail(h: Highlight): string {
  const bits: string[] = [];
  if (h.kind === 'jump' && h.jump) {
    bits.push(`${(h.jump.airMs / 1000).toFixed(2)} s`);
    if (h.jump.distanceM !== undefined) bits.push(fmtJumpLength(h.jump.distanceM));
  }
  if (h.kind === 'speed' && h.speedMs !== undefined) bits.push(fmtRideSpeed(h.speedMs));
  if (h.kind === 'hit' && h.g !== undefined) bits.push(`${h.g.toFixed(1)} G`);
  return bits.join(' · ');
}
/** A note for a marker: "Jump 0.82 s, 6.1 m, with hiLight tag". */
export function highlightNote(h: Highlight): string {
  const d = highlightDetail(h);
  const also = h.also.map((k) => KIND_NAME[k].toLowerCase()).join(' and ');
  return `${KIND_NAME[h.kind]}${d ? ` ${d.replace(/ · /g, ', ')}` : ''}${also ? `, with ${also}` : ''}`;
}

/** The highlights of a clip: moments inside its in and out points, their parts kept inside them too. */
export function clipHighlights(clip: TimelineClip, media: Media): Highlight[] {
  return media.telemetry.highlights(media.durationUs, media.hilights, clip.airtime ?? {})
    .filter((h) => h.t >= clip.inUs && h.t < clip.outUs)
    .map((h) => ({ ...h, fromUs: Math.max(clip.inUs, h.fromUs), toUs: Math.min(clip.outUs, h.toUs) }))
    .filter((h) => h.toUs - h.fromUs >= 500_000);
}

/** Copies of a clip cut to each highlight, for a reel (same look, speed and settings). */
export function reelPieces(clip: TimelineClip, list: Highlight[]): TimelineClip[] {
  return list.map((h) => ({ ...clip, id: newId('c'), inUs: Math.round(h.fromUs), outUs: Math.round(h.toUs) }));
}

export type HighlightPick = 'all' | '10' | '5' | '3';
const PICK_KEY = 'ace.highlightPick';
export const pickHighlights = (list: Highlight[], pick: HighlightPick) => (pick === 'all' ? list : bestHighlights(list, Number(pick)));
/** (Best 10 to begin with: a pump track can have 40 jumps, too many for one reel.) */
const loadPick = (): HighlightPick => { try { const v = localStorage.getItem(PICK_KEY); return v === 'all' || v === '5' || v === '3' ? v : '10'; } catch { return '10'; } };

export function HighlightsSection({ clip, media, clipStartUs, onSeekMedia, onMark, onReel, onReelAll, clipCount, marks, onMarks }: {
  clip: TimelineClip;
  media: Media;
  clipStartUs: number;
  onSeekMedia: (mediaUs: number) => void;
  /** Adds a marker for each (timeline times and notes). */
  onMark: (list: { t: number; note: string }[]) => void;
  /** Adds the pieces at the end of the timeline; null on a track above the main row. */
  onReel: ((pieces: TimelineClip[]) => void) | null;
  /** The same for every clip on the main row. */
  onReelAll: ((pick: HighlightPick) => void) | null;
  clipCount: number;
  marks: boolean;
  onMarks: () => void;
}) {
  const [pick, setPick] = useState<HighlightPick>(loadPick);
  const choose = (v: HighlightPick) => { setPick(v); try { localStorage.setItem(PICK_KEY, v); } catch { /* private mode */ } };
  const all = clipHighlights(clip, media);
  const used = pickHighlights(all, pick);
  const usedSet = new Set(used);
  const reelUs = used.reduce((a, h) => a + (h.toUs - h.fromUs), 0);
  const rideData = media.telemetry.hasAccel || media.telemetry.hasGps;
  return (
    <Section title="Highlights" badge={all.length ? `${all.length}` : undefined}>
      {all.length ? (
        <>
          <div className="air-list hl-list">
            {all.map((h) => (
              <button key={h.t} className={`air-row hl-row${usedSet.has(h) ? '' : ' unused'}`} title="Go to this moment" onClick={() => onSeekMedia(h.t)}>
                <span className={`hl-kind ${h.kind}`}>{KIND_NAME[h.kind]}{h.also.length > 0 && <small className="muted"> + {h.also.map((k) => KIND_NAME[k].toLowerCase()).join(', ')}</small>}</span>
                <span className="muted">{fmtTime(mediaToTimeline(clipStartUs, clip, h.t))}</span>
                <b>{highlightDetail(h)}</b>
              </button>
            ))}
          </div>
          {all.length > 3 && (
            <div className="field-row">
              <span>Use</span>
              <Seg value={pick} options={[['all', 'All'], ['10', 'Best 10'], ['5', 'Best 5'], ['3', 'Best 3']]} onChange={choose} />
            </div>
          )}
          <div className="row-buttons">
            <button title="Adds a marker on the timeline at each highlight, with a note saying what it is" onClick={() => onMark(used.map((h) => ({ t: clipStartUs + localAt(clip, h.t), note: highlightNote(h) })))}>Mark them</button>
            {onReel && <button title="Adds a copy of this clip for each highlight, a few seconds around it, at the end of the timeline" onClick={() => onReel(reelPieces(clip, used))}>Make a highlight reel</button>}
          </div>
          {onReel && <p className="hint">The reel is {used.length} piece{used.length === 1 ? '' : 's'}, about {fmtTime(reelUs)} long, added at the end of the timeline. This clip stays as it is.</p>}
        </>
      ) : (
        <p className="hint">{rideData || media.hilights.length
          ? 'Nothing stands out in this clip yet: no HiLight tags, jumps, top speed or hard hits. Press the HiLight button on the camera while riding to tag a moment.'
          : 'This clip has no HiLight tags or ride data (GPS and motion), so its highlights can’t be found. GoPro cameras record both.'}</p>
      )}
      {onReelAll && clipCount > 1 && <div className="row-buttons"><button title="A highlight reel from every clip on the main row, in order, at the end of the timeline" onClick={() => onReelAll(pick)}>Reel from every clip</button></div>}
      <label className="check"><input type="checkbox" checked={marks} onChange={onMarks} /> Show highlights and jumps on the timeline</label>
    </Section>
  );
}

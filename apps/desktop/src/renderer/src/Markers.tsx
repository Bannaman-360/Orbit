// The Markers panel: every marker with its time and note. Click a time to go there, type to change
// the note, click the dot to change the colour. "Copy as YouTube chapters" makes the description
// text YouTube turns into chapters.

import { useState } from 'react';
import { MARKER_COLORS, youtubeChapters, type Marker, type MarkerColor, type Timeline } from '@ace/project';
import { ace } from './api';
import { fmtTime } from './ui';
import { Icon } from './ui/Icon';

export const MARKER_HEX: Record<MarkerColor, string> = { red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158', blue: '#0a84ff', purple: '#bf5af2', gray: '#98989d' };
export const nextColor = (c: MarkerColor): MarkerColor => MARKER_COLORS[(MARKER_COLORS.indexOf(c) + 1) % MARKER_COLORS.length]!;

export function MarkersPanel({ timeline, time, onSeek, onAdd, onChange, onRemove }: {
  timeline: Timeline;
  time: number;
  onSeek: (t: number) => void;
  onAdd: () => void;
  onChange: (id: string, patch: Partial<Omit<Marker, 'id'>>) => void;
  onRemove: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const chapters = youtubeChapters(timeline);
  const list = timeline.markers;
  // The marker just before the playhead is highlighted, so you can see where you are.
  const current = [...list].reverse().find((m) => m.t <= time + 1);
  return (
    <aside className="markers">
      <header>
        <span className="muted">{list.length ? `${list.length} marker${list.length === 1 ? '' : 's'}` : 'No markers yet'}</span>
        <button onClick={onAdd} title="Add a marker at the playhead (M)"><Icon name="marker" size={14} /> Add</button>
      </header>
      <div className="marker-list">
        {!list.length && <p className="empty-panel">Press M while watching to mark a moment. Add a note to remember why.</p>}
        {list.map((m) => (
          <div key={m.id} className={`marker-row${m === current ? ' current' : ''}`}>
            <button className="marker-dot" style={{ background: MARKER_HEX[m.color] }} title="Change colour" aria-label={`Colour: ${m.color}`} onClick={() => onChange(m.id, { color: nextColor(m.color) })} />
            <button className="marker-time link" onClick={() => onSeek(m.t)} title="Go to this marker">{fmtTime(m.t)}</button>
            <input className="marker-note" value={m.note} placeholder="Add a note" aria-label="Note" onChange={(e) => onChange(m.id, { note: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
            <button className="marker-del" title="Delete marker" aria-label="Delete marker" onClick={() => onRemove(m.id)}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>
      {list.length > 0 && (
        <footer>
          <button onClick={() => { void ace.copyText(chapters.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); }}>{copied ? 'Copied' : 'Copy as YouTube chapters'}</button>
          {chapters.problem && <p className="hint">{chapters.problem}</p>}
        </footer>
      )}
    </aside>
  );
}

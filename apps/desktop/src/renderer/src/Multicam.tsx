// Multicam: making a group from Media clips, and the angle viewer for cutting between them.

import { useState } from 'react';
import { groupOf, MAX_ANGLES, newClip, type Timeline, type TimelineClip } from '@ace/project';
import { baseName } from './api';
import { stripPicture, useFilmstrip } from './filmstrip';
import { mediaNow } from './media';

/** Choose 2–4 recordings of the same moment and how to line them up. */
export function MulticamDialog(p: { files: string[]; busy: string | null; onMake: (paths: string[], method: 'sound' | 'clock') => void; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [method, setMethod] = useState<'sound' | 'clock'>('sound');
  const toggle = (f: string) => setPicked((l) => (l.includes(f) ? l.filter((x) => x !== f) : l.length >= MAX_ANGLES ? l : [...l, f]));
  return (
    <div className="modal-backdrop">
      <div className="modal multicam-dialog" role="dialog" aria-label="New multicam clip">
        <h2>New multicam clip</h2>
        <p className="hint">Pick 2 to 4 videos of the same moment from different cameras. They’re lined up in time, then you cut between them while it plays (keys 1–4).</p>
        <div className="multicam-list">
          {p.files.length === 0 && <p className="muted">Import the videos first: they appear in Media.</p>}
          {p.files.map((f) => (
            <label key={f} className="check">
              <input type="checkbox" checked={picked.includes(f)} disabled={!picked.includes(f) && picked.length >= MAX_ANGLES} onChange={() => toggle(f)} />
              {picked.includes(f) && <b className="badge">{picked.indexOf(f) + 1}</b>} {baseName(f)}
            </label>
          ))}
        </div>
        <label className="field">Line up by
          <select value={method} onChange={(e) => setMethod(e.target.value as 'sound' | 'clock')}>
            <option value="sound">Sound (most exact; the cameras must hear the same things)</option>
            <option value="clock">Camera clocks (when each started recording)</option>
          </select>
        </label>
        {p.busy && <p className="busy">{p.busy}</p>}
        <div className="modal-actions">
          <button onClick={p.onClose}>Cancel</button>
          <button className="primary" disabled={picked.length < 2 || !!p.busy} onClick={() => p.onMake(picked, method)}>Make multicam clip</button>
        </div>
      </div>
    </div>
  );
}

/** One stand-in clip per recording, so its pictures are made once and kept. */
const angleClips = new Map<string, TimelineClip>();
const angleClip = (path: string, dur: number, is360: boolean) => {
  let c = angleClips.get(path);
  if (!c) angleClips.set(path, (c = { ...newClip(path, dur, is360), id: `angle:${path}` }));
  return c;
};

/** Every angle at the playhead; click one (or press 1–4) to cut to it. */
export function AngleViewer(p: { timeline: Timeline; clip: TimelineClip; mediaUs: number; onPick: (angle: number) => void }) {
  useFilmstrip();
  const g = groupOf(p.timeline, p.clip);
  if (!g) return null;
  const now = p.clip.multicam!.angle;
  const clock = p.mediaUs + g.angles[now]!.offsetUs;
  return (
    <div className="angle-viewer" aria-label="Multicam angles">
      <span className="angle-title">{g.name}</span>
      {g.angles.map((a, i) => {
        const m = mediaNow(a.path);
        const t = clock - a.offsetUs;
        const live = t >= 0 && t < a.durationUs;
        const pic = m && t >= 0 && t < a.durationUs ? stripPicture(angleClip(a.path, a.durationUs, m.is360), m, Math.min(a.durationUs - 1, t), 0).url : null;
        return (
          <button key={i} className={`angle${i === now ? ' on' : ''}`} disabled={!live && i !== now} title={live ? `Cut to ${baseName(a.path)} here (${i + 1})` : `${baseName(a.path)} isn’t recording for all of this clip`} onClick={() => p.onPick(i)}>
            <i style={{ backgroundImage: pic ? `url(${pic})` : undefined }} />
            <span><b>{i + 1}</b> {baseName(a.path)}</span>
          </button>
        );
      })}
    </div>
  );
}

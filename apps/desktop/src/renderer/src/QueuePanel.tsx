// The export queue panel (pause, resume, cancel, reorder), and batch export: several Media
// videos, each exported on its own with one preset into one folder.

import { useState, useSyncExternalStore } from 'react';
import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace, baseName } from './api';
import { EXPORT_PRESETS, presetSettings, userPresets } from './exportPresets';
import { cancelJob, clearJobs, enqueue, moveJob, onQueue, pauseJob, queueJobs, resumeJob, type ExportJob } from './exportQueue';
import { getMedia } from './media';
import { LoudnessMeter } from './ExportDialog';

const STATUS: Record<ExportJob['status'], string> = { waiting: 'Waiting', running: 'Exporting', paused: 'Paused', done: 'Done', failed: 'Stopped', cancelled: 'Cancelled' };

export function QueuePanel({ onClose }: { onClose: () => void }) {
  const jobs = useSyncExternalStore(onQueue, queueJobs);
  const [open, setOpen] = useState<string | null>(null);
  const finished = jobs.some((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');
  return (
    <div className="queue-panel" role="dialog" aria-label="Export queue">
      <div className="queue-head">
        <h3>Export queue</h3>
        <span className="grow" />
        {finished && <button className="link" onClick={() => clearJobs()}>Clear finished</button>}
        <button className="ghost" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {!jobs.length && <p className="hint">Nothing to export. In Export, “Add to queue…” exports in the background while you keep editing; Media ▸ ••• ▸ Export several videos does a batch.</p>}
      <div className="queue-list">
        {jobs.map((j, i) => {
          const live = j.status === 'running' || j.status === 'paused' || j.status === 'waiting';
          const f = j.progress?.fraction ?? 0;
          return (
            <div key={j.id} className={`queue-job ${j.status}`} data-job={j.id}>
              <div className="queue-row">
                <b title={j.opts.path}>{j.name}</b>
                <span className="muted">{STATUS[j.status]}{j.status === 'running' && j.progress ? ` · ${Math.round(f * 100)}%` : ''}</span>
              </div>
              {live && <div className="bar"><div style={{ width: `${f * 100}%` }} /></div>}
              {j.status === 'running' && j.progress && <span className="muted small">{j.progress.stage}{j.progress.fps ? ` · ${j.progress.fps.toFixed(0)} fps` : ''}</span>}
              {j.status === 'failed' && <span className="error small">{j.error}</span>}
              <div className="queue-actions">
                {j.status === 'running' && <button onClick={() => pauseJob(j.id)}>Pause</button>}
                {j.status === 'paused' && <button onClick={() => resumeJob(j.id)}>Resume</button>}
                {j.status === 'waiting' && <button onClick={() => pauseJob(j.id)} title="Keep it waiting until you resume it">Hold</button>}
                {j.status === 'waiting' && i > 0 && <button className="ghost" aria-label="Earlier" title="Export earlier" onClick={() => moveJob(j.id, -1)}>↑</button>}
                {j.status === 'waiting' && i < jobs.length - 1 && <button className="ghost" aria-label="Later" title="Export later" onClick={() => moveJob(j.id, 1)}>↓</button>}
                {live && <button className="danger" onClick={() => cancelJob(j.id)}>Cancel</button>}
                {j.status === 'done' && <button onClick={() => void ace.reveal(j.opts.path)}>Show</button>}
                {j.status === 'done' && j.result?.sound && <button className="link" onClick={() => setOpen(open === j.id ? null : j.id)}>Sound level</button>}
                {!live && <button className="ghost" aria-label="Remove from the list" title="Remove from the list" onClick={() => clearJobs(j.id)}>✕</button>}
              </div>
              {open === j.id && j.result?.sound && <LoudnessMeter sound={j.result.sound} target={j.opts.loudness ?? null} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Choose videos from Media, a preset and a folder; each video becomes its own export in the queue. */
export function BatchDialog({ items, onClose, onQueued }: { items: { path: string; name?: string; rating?: number; flag?: string }[]; onClose: () => void; onQueued: (n: number) => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(items.filter((i) => i.flag !== 'reject').map((i) => i.path)));
  const presets = [...EXPORT_PRESETS.filter((p) => p.codec !== 'prores').map((p) => ({ id: p.id, name: p.name })), ...userPresets().filter((u) => u.codec !== 'prores' && u.codec !== 'hevc10').map((u) => ({ id: u.id, name: u.name }))];
  const [presetId, setPresetId] = useState(presets[0]?.id ?? 'youtube');
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const go = async () => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    let n = 0;
    try {
      for (const it of items.filter((i) => picked.has(i.path))) {
        const m = await getMedia(it.path);
        const tl = { ...addClip(emptyTimeline(), newClip(m.path, m.durationUs, m.is360), 0), framing: m.is360 ? '16:9' : (m.width >= m.height ? '16:9' : '9:16') };
        const built = EXPORT_PRESETS.find((p) => p.id === presetId);
        const mine = userPresets().find((u) => u.id === presetId);
        const s = built ? presetSettings(built, Math.round(m.fps), Math.min(m.width, m.height), tl.framing) : null;
        const opts = s
          ? { resolution: s.resolution, fps: s.fps, codec: s.codec, quality: 'high' as const, loudness: s.loudness, ...(s.framing !== tl.framing ? { framing: s.framing } : {}), ...(s.bitrate ? { bitrate: s.bitrate } : {}) }
          : { resolution: mine!.resolution, fps: mine!.fps, codec: mine!.codec, quality: mine!.quality, loudness: mine!.loudness, ...(mine!.framing && mine!.framing !== tl.framing ? { framing: mine!.framing } : {}) };
        const path = await ace.pathInFolder(folder, it.name ?? baseName(it.path), 'mp4');
        enqueue(path.split(/[\\/]/).pop()!, tl, { path, ...opts });
        n++;
      }
      onQueued(n);
      onClose();
    } catch (e) {
      setError(`Couldn’t add every video (${n} added): ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Export several videos</h2>
        <p className="hint">Each video is exported whole, on its own, with the settings you pick. They wait in the export queue, so you can keep editing.</p>
        <div className="batch-list" role="group" aria-label="Videos to export">
          {items.map((it) => (
            <label key={it.path} className="check">
              <input type="checkbox" checked={picked.has(it.path)} onChange={() => toggle(it.path)} />
              <span>{it.name ?? baseName(it.path)}{it.rating ? ` ${'★'.repeat(it.rating)}` : ''}{it.flag === 'fav' ? ' ♥' : ''}</span>
            </label>
          ))}
        </div>
        <div className="row-buttons">
          <button className="link" onClick={() => setPicked(new Set(items.map((i) => i.path)))}>All</button>
          <button className="link" onClick={() => setPicked(new Set(items.filter((i) => (i.rating ?? 0) >= 3 || i.flag === 'fav').map((i) => i.path)))}>3 stars and favourites</button>
          <button className="link" onClick={() => setPicked(new Set())}>None</button>
        </div>
        <div className="form">
          <label>Settings
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>Folder
            <button onClick={() => void ace.exportFolderDialog().then((f) => f && setFolder(f))}>{folder ? baseName(folder) : 'Choose…'}</button>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !folder || !picked.size} onClick={() => void go()}>{busy ? 'Adding…' : `Export ${picked.size} video${picked.size === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  );
}

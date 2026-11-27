import { useEffect, useState, useSyncExternalStore } from 'react';
import { timelineDuration, type Timeline } from '@ace/project';
import { ace } from './api';
import { outputSize, type ExportOptions, type Quality, type Resolution } from './exporter';
import { mediaNow } from './media';
import { EXPORT_PRESETS, LOUDNESS_CHOICES, presetSettings, saveUserPresets, userPresets, type Codec, type ExportPreset, type UserPreset } from './exportPresets';
import { cancelJob, enqueue, onQueue, queueJobs } from './exportQueue';
import type { LoudnessResult } from './loudness';
import { fmtTime } from './ui';

/** Loudness and peak of an exported sound, on a scale from −40 to 0. */
export function LoudnessMeter({ sound, target }: { sound: LoudnessResult; target: number | null }) {
  const at = (db: number) => `${Math.max(0, Math.min(100, ((db + 40) / 40) * 100))}%`;
  const lufs = Number.isFinite(sound.after) ? sound.after : -70;
  const peak = Number.isFinite(sound.truePeak) ? sound.truePeak : -70;
  return (
    <div className="loudness-meter" aria-label="Exported sound level">
      <div className="lm-row"><span>Loudness</span><div className="lm-bar"><div className="lm-fill" style={{ width: at(lufs) }} />{target !== null && <i className="lm-target" style={{ left: at(target) }} title={`Aimed at ${target} LUFS`} />}</div><b>{Number.isFinite(sound.after) ? `${sound.after.toFixed(1)} LUFS` : 'Silent'}</b></div>
      <div className="lm-row"><span>Peak</span><div className="lm-bar"><div className={`lm-fill${peak > -1.05 ? ' hot' : ''}`} style={{ width: at(peak) }} /><i className="lm-target" style={{ left: at(-1) }} title="Ceiling: −1 dBTP" /></div><b>{Number.isFinite(sound.truePeak) ? `${sound.truePeak.toFixed(1)} dBTP` : '—'}</b></div>
      {Number.isFinite(sound.before) && Math.abs(sound.gainDb) >= 0.1 && <p className="hint">The mix was {sound.before.toFixed(1)} LUFS, so it was turned {sound.gainDb > 0 ? 'up' : 'down'} {Math.abs(sound.gainDb).toFixed(1)} dB.</p>}
    </div>
  );
}

export function ExportDialog({ timeline, onClose, onShowQueue }: { timeline: Timeline; onClose: () => void; onShowQueue?: () => void }) {
  const firstFps = Math.round(mediaNow(timeline.clips[0]?.mediaPath ?? '')?.fps ?? 30);
  const [res, setRes] = useState<Resolution>(1080);
  const [fps, setFps] = useState(firstFps >= 50 ? 30 : firstFps);
  const [codec, setCodec] = useState<Codec>('avc');
  // 10-bit and ProRes need the bundled encoder and suitable hardware.
  const [deep, setDeep] = useState<{ hevc10?: string; prores?: string }>({});
  useEffect(() => { void ace.encoderAvailable().then(setDeep, () => {}); }, []);
  const [quality, setQuality] = useState<Quality>('high');
  const [loudness, setLoudness] = useState<number | null>(-14);
  /** In another shape: reframe each clip for it (on), or only change the frame's shape. */
  const [autoReframe, setAutoReframe] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const jobs = useSyncExternalStore(onQueue, queueJobs);
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const [mine, setMine] = useState<UserPreset[]>(userPresets);
  const [naming, setNaming] = useState<string | null>(null);
  /** A preset: its shape and bit rate (changing a setting by hand leaves it). */
  const [preset, setPreset] = useState<{ id: string; name: string; note?: string; maxSeconds?: number; framing: string; bitrate?: number } | null>(null);
  const tallest = (() => {
    const flat = [...timeline.clips, ...timeline.connected].map((c) => mediaNow(c.mediaPath)).filter((m) => m && !m.is360);
    return flat.length ? Math.max(...flat.map((m) => Math.min(m!.width, m!.height))) : 1080;
  })();
  const pickPreset = (p: ExportPreset) => {
    const s = presetSettings(p, firstFps, tallest, timeline.framing);
    const c = s.codec === 'prores' && !deep.prores ? 'avc' : s.codec;
    setRes(s.resolution); setFps(s.fps); setCodec(c); setLoudness(s.loudness);
    setPreset({ id: p.id, name: p.name, note: p.note, maxSeconds: p.maxSeconds, framing: s.framing, bitrate: c === 'prores' || !s.bitrate ? undefined : s.bitrate });
  };
  const pickMine = (u: UserPreset) => {
    setRes(u.resolution); setFps(u.fps); setCodec(u.codec === 'prores' && !deep.prores ? 'avc' : u.codec === 'hevc10' && !deep.hevc10 ? 'hevc' : u.codec); setQuality(u.quality); setLoudness(u.loudness);
    setPreset({ id: u.id, name: u.name, framing: u.framing ?? timeline.framing });
  };
  const saveMine = () => {
    const name = naming?.trim();
    if (!name) return;
    const u: UserPreset = { id: `u${Date.now().toString(36)}`, name, resolution: res, fps, codec, quality, loudness, ...(preset && preset.framing !== timeline.framing ? { framing: preset.framing } : {}) };
    const next = [...mine.filter((m) => m.name !== name), u];
    saveUserPresets(next);
    setMine(next);
    setNaming(null);
    setPreset({ id: u.id, name: u.name, framing: u.framing ?? timeline.framing });
  };
  const removeMine = (id: string) => { const next = mine.filter((m) => m.id !== id); saveUserPresets(next); setMine(next); if (preset?.id === id) setPreset(null); };
  const byHand = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPreset((p) => (p ? { ...p, id: '', name: '', note: undefined, maxSeconds: undefined, bitrate: undefined } : null)); };
  const framing = preset?.framing ?? timeline.framing;
  const size = outputSize(framing, res);
  const seconds = timelineDuration(timeline) / 1e6;
  const busy = !!job && (job.status === 'running' || job.status === 'waiting' || job.status === 'paused');

  const options = (path: string): Omit<ExportOptions, 'gate'> => ({ path, resolution: res, fps, codec, quality, loudness, ...(framing !== timeline.framing ? { framing, autoReframe } : {}), ...(preset?.bitrate ? { bitrate: preset.bitrate } : {}) });
  const ask = async () => {
    const mov = codec === 'prores';
    return ace.saveDialog(mov ? 'mov' : 'video', `Edit ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.${mov ? 'mov' : 'mp4'}`);
  };
  const start = async () => {
    const path = await ask();
    if (path) setJobId(enqueue(path.split(/[\\/]/).pop()!, timeline, options(path)));
  };
  const queue = async () => {
    const path = await ask();
    if (!path) return;
    enqueue(path.split(/[\\/]/).pop()!, timeline, options(path));
    onClose();
    onShowQueue?.();
  };
  const ahead = job?.status === 'waiting' ? jobs.filter((j) => j.status === 'running' || (j.status === 'waiting' && jobs.indexOf(j) < jobs.indexOf(job))).length : 0;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Export video</h2>
        <div className="export-presets" role="group" aria-label="Export for">
          {EXPORT_PRESETS.map((p) => (
            <button key={p.id} className={preset?.id === p.id ? 'on' : ''} disabled={busy || (p.codec === 'prores' && !deep.prores)} title={p.note} aria-pressed={preset?.id === p.id} onClick={() => pickPreset(p)}>{p.name}</button>
          ))}
          {mine.map((u) => (
            <span key={u.id} className={`user-preset${preset?.id === u.id ? ' on' : ''}`}>
              <button disabled={busy} aria-pressed={preset?.id === u.id} title="Your saved settings" onClick={() => pickMine(u)}>{u.name}</button>
              <button className="ghost" disabled={busy} aria-label={`Delete ${u.name}`} title="Delete these saved settings" onClick={() => removeMine(u.id)}>×</button>
            </span>
          ))}
        </div>
        {preset?.note && (
          <p className="hint">
            {preset.name}: {preset.note} {preset.bitrate ? `${(preset.bitrate / 1e6).toFixed(0)} Mbit/s, ` : ''}sound brought to {loudness ?? 'its own'} LUFS.
            {preset.framing !== timeline.framing ? ` Your edit is ${timeline.framing}: this export is ${preset.framing}.` : ''}
          </p>
        )}
        {preset?.maxSeconds && seconds > preset.maxSeconds && <p className="error">{preset.name} takes videos up to {fmtTime(preset.maxSeconds * 1e6)}; this edit is {fmtTime(seconds * 1e6)}. Shorten it, or the upload will be refused or cut.</p>}
        <div className="form">
          <label>Resolution
            <select value={res} disabled={busy} onChange={(e) => byHand(setRes)(+e.target.value as Resolution)}>
              <option value={720}>720p</option><option value={1080}>1080p</option><option value={1440}>1440p</option><option value={2160}>4K</option>
            </select>
          </label>
          <label>Frame rate
            <select value={fps} disabled={busy} onChange={(e) => byHand(setFps)(+e.target.value)}>
              {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
          </label>
          <label>Codec
            <select value={codec} disabled={busy} onChange={(e) => byHand(setCodec)(e.target.value as Codec)}>
              <option value="avc">H.264 (plays everywhere)</option><option value="hevc">HEVC / H.265 (smaller files)</option>
              <option value="hevc10" disabled={!deep.hevc10}>HEVC 10-bit (smoothest gradients){deep.hevc10 ? '' : ' — not on this computer'}</option>
              <option value="prores" disabled={!deep.prores}>ProRes 422 HQ (.mov, for further editing){deep.prores ? '' : ' — not on this computer'}</option>
            </select>
          </label>
          <label>Quality
            <select value={quality} disabled={busy || codec === 'prores'} onChange={(e) => byHand(setQuality)(e.target.value as Quality)}>
              <option value="standard">Standard</option><option value="high">High</option><option value="max">Maximum</option>
            </select>
          </label>
          <label>Sound level
            <select value={loudness ?? 'off'} disabled={busy} onChange={(e) => byHand(setLoudness)(e.target.value === 'off' ? null : +e.target.value)} title="How loud the exported sound is. Peaks are always kept under −1 dB (true peak).">
              {LOUDNESS_CHOICES.map(([v, label]) => <option key={String(v)} value={v ?? 'off'}>{label}</option>)}
            </select>
          </label>
        </div>
        {codec === 'hevc10' && <p className="hint">Keeps 10 bits per colour, so skies and graded or log footage show no banding. Plays on recent phones, Macs, PCs and YouTube; older devices may not play it.</p>}
        {codec === 'prores' && <p className="hint">Very large files (about {((size.width * size.height * fps * 3.5 * 60) / 8 / 1e9).toFixed(1)} GB a minute) of the highest quality, for finishing in another editor such as Final Cut Pro or DaVinci Resolve.</p>}
        {framing !== timeline.framing && (
          <label className="check" title="Off: the clips keep their views as they are, only the frame changes shape.">
            <input type="checkbox" checked={autoReframe} disabled={busy} onChange={(e) => setAutoReframe(e.target.checked)} />
            Reframe each clip for {framing}: 360 views keep your direction and zoom, and regular clips follow the action. Check titles and gauges still sit well.
          </label>
        )}
        <p className="muted">{size.width}×{size.height} ({framing}) · {fmtTime(timelineDuration(timeline))} · {timeline.clips.length} clips{timeline.audio.length ? ' + music' : ''}</p>
        {naming !== null ? (
          <div className="field-row">
            <input autoFocus value={naming} placeholder="Name these settings" aria-label="Name for these settings" onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveMine(); if (e.key === 'Escape') setNaming(null); }} />
            <button disabled={!naming.trim()} onClick={saveMine}>Save</button>
            <button className="ghost" onClick={() => setNaming(null)}>Cancel</button>
          </div>
        ) : (
          !busy && <button className="link" onClick={() => setNaming(preset?.name ? `${preset.name} (mine)` : '')}>Save these settings…</button>
        )}
        {job && job.progress && job.status !== 'failed' && job.status !== 'cancelled' && (
          <div className="progress">
            <div className="bar"><div style={{ width: `${job.progress.fraction * 100}%` }} /></div>
            <span>{job.status === 'waiting' ? `Waiting in the queue (${ahead} ahead)` : job.status === 'paused' ? 'Paused' : job.progress.stage}{job.progress.fps && job.status === 'running' ? ` · ${job.progress.fps.toFixed(0)} fps` : ''} · {Math.round(job.progress.fraction * 100)}%</span>
          </div>
        )}
        {job?.status === 'failed' && <p className="error">The export stopped: {job.error}. Check there’s space on the disk and try again.</p>}
        {job?.status === 'cancelled' && <p className="error">Export cancelled.</p>}
        {job?.status === 'done' && (
          <>
            <p className="ok">Saved to {job.opts.path} <button className="link" onClick={() => void ace.reveal(job.opts.path)}>Show</button></p>
            {job.result?.sound && <LoudnessMeter sound={job.result.sound} target={job.opts.loudness ?? null} />}
          </>
        )}
        <div className="modal-actions">
          {busy ? (
            <>
              <button onClick={() => cancelJob(job!.id)}>Cancel export</button>
              <button onClick={() => { onClose(); onShowQueue?.(); }} title="Keep editing while it exports; follow it in the export queue">Keep editing</button>
            </>
          ) : (
            <>
              <button onClick={onClose}>Close</button>
              <button onClick={queue} title="Export in the background after the exports already waiting, and keep editing">Add to queue…</button>
              <button className="primary" onClick={start}>{job?.status === 'done' ? 'Export again…' : 'Export…'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

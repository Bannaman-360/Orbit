import { useRef, useState } from 'react';
import { timelineDuration, type Timeline } from '@ace/project';
import { ace } from './api';
import { exportTimeline, outputSize, type ExportProgress, type Quality, type Resolution } from './exporter';
import { mediaNow } from './media';
import { fmtTime } from './ui';

export function ExportDialog({ timeline, onClose }: { timeline: Timeline; onClose: () => void }) {
  const firstFps = Math.round(mediaNow(timeline.clips[0]?.mediaPath ?? '')?.fps ?? 30);
  const [res, setRes] = useState<Resolution>(1080);
  const [fps, setFps] = useState(firstFps >= 50 ? 30 : firstFps);
  const [codec, setCodec] = useState<'avc' | 'hevc'>('avc');
  const [quality, setQuality] = useState<Quality>('high');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const size = outputSize(timeline.framing, res);
  const busy = progress !== null && progress.fraction < 1 && !error;

  const start = async () => {
    const path = await ace.saveDialog('video', `Edit ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.mp4`);
    if (!path) return;
    setError(null);
    setDonePath(null);
    abort.current = new AbortController();
    try {
      await exportTimeline(timeline, { path, resolution: res, fps, codec, quality }, setProgress, abort.current.signal);
      setDonePath(path);
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'AbortError' ? 'Export cancelled.' : String(e));
      setProgress(null);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Export video</h2>
        <div className="form">
          <label>Resolution
            <select value={res} disabled={busy} onChange={(e) => setRes(+e.target.value as Resolution)}>
              <option value={720}>720p</option><option value={1080}>1080p</option><option value={1440}>1440p</option><option value={2160}>4K</option>
            </select>
          </label>
          <label>Frame rate
            <select value={fps} disabled={busy} onChange={(e) => setFps(+e.target.value)}>
              {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
          </label>
          <label>Codec
            <select value={codec} disabled={busy} onChange={(e) => setCodec(e.target.value as 'avc' | 'hevc')}>
              <option value="avc">H.264 (plays everywhere)</option><option value="hevc">HEVC / H.265 (smaller files)</option>
            </select>
          </label>
          <label>Quality
            <select value={quality} disabled={busy} onChange={(e) => setQuality(e.target.value as Quality)}>
              <option value="standard">Standard</option><option value="high">High</option><option value="max">Maximum</option>
            </select>
          </label>
        </div>
        <p className="muted">{size.width}×{size.height} ({timeline.framing}) · {fmtTime(timelineDuration(timeline))} · {timeline.clips.length} clips{timeline.audio.length ? ' + music' : ''}</p>
        {progress && (
          <div className="progress">
            <div className="bar"><div style={{ width: `${progress.fraction * 100}%` }} /></div>
            <span>{progress.stage}{progress.fps ? ` · ${progress.fps.toFixed(0)} fps` : ''} · {Math.round(progress.fraction * 100)}%</span>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {donePath && <p className="ok">Saved to {donePath}</p>}
        <div className="modal-actions">
          {busy ? <button onClick={() => abort.current?.abort()}>Cancel export</button> : <button onClick={onClose}>Close</button>}
          {!busy && <button className="primary" onClick={start}>{donePath ? 'Export again…' : 'Export…'}</button>}
        </div>
      </div>
    </div>
  );
}

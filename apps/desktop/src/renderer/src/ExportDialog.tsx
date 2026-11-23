import { useEffect, useRef, useState } from 'react';
import { timelineDuration, type Timeline } from '@ace/project';
import { ace } from './api';
import { exportTimeline, outputSize, type ExportProgress, type Quality, type Resolution } from './exporter';
import { mediaNow } from './media';
import { fmtTime } from './ui';

export function ExportDialog({ timeline, onClose }: { timeline: Timeline; onClose: () => void }) {
  const firstFps = Math.round(mediaNow(timeline.clips[0]?.mediaPath ?? '')?.fps ?? 30);
  const [res, setRes] = useState<Resolution>(1080);
  const [fps, setFps] = useState(firstFps >= 50 ? 30 : firstFps);
  type Codec = 'avc' | 'hevc' | 'hevc10' | 'prores';
  const [codec, setCodec] = useState<Codec>('avc');
  // 10-bit and ProRes need the bundled encoder and suitable hardware.
  const [deep, setDeep] = useState<{ hevc10?: string; prores?: string }>({});
  useEffect(() => { void ace.encoderAvailable().then(setDeep, () => {}); }, []);
  const [quality, setQuality] = useState<Quality>('high');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const size = outputSize(timeline.framing, res);
  const busy = progress !== null && progress.fraction < 1 && !error;

  const start = async () => {
    const mov = codec === 'prores';
    const path = await ace.saveDialog(mov ? 'mov' : 'video', `Edit ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.${mov ? 'mov' : 'mp4'}`);
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
            <select value={codec} disabled={busy} onChange={(e) => setCodec(e.target.value as Codec)}>
              <option value="avc">H.264 (plays everywhere)</option><option value="hevc">HEVC / H.265 (smaller files)</option>
              <option value="hevc10" disabled={!deep.hevc10}>HEVC 10-bit (smoothest gradients){deep.hevc10 ? '' : ' — not on this computer'}</option>
              <option value="prores" disabled={!deep.prores}>ProRes 422 HQ (.mov, for further editing){deep.prores ? '' : ' — not on this computer'}</option>
            </select>
          </label>
          <label>Quality
            <select value={quality} disabled={busy || codec === 'prores'} onChange={(e) => setQuality(e.target.value as Quality)}>
              <option value="standard">Standard</option><option value="high">High</option><option value="max">Maximum</option>
            </select>
          </label>
        </div>
        {codec === 'hevc10' && <p className="hint">Keeps 10 bits per colour, so skies and graded or log footage show no banding. Plays on recent phones, Macs, PCs and YouTube; older devices may not play it.</p>}
        {codec === 'prores' && <p className="hint">Very large files (about {((size.width * size.height * fps * 3.5 * 60) / 8 / 1e9).toFixed(1)} GB a minute) of the highest quality, for finishing in another editor such as Final Cut Pro or DaVinci Resolve.</p>}
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

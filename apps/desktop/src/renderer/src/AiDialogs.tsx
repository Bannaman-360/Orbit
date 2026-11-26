// Dialogs for the AI tools: auto subtitles, and the AI models kept on this computer.

import { useRef, useState } from 'react';
import type { Overlay } from '@ace/project';
import { ace } from './api';
import { forgetModelFiles, megabytes, refreshModels, useModels } from './aiModels';
import { LANGUAGES, makeSubtitles, WHISPER, type SubtitleProgress } from './subtitles';
import type { Timeline } from '@ace/project';

const STAGE: Record<SubtitleProgress['stage'], string> = { download: 'Downloading speech to text', sound: 'Gathering the sound', listen: 'Listening' };

/** A one-time download a tool needs, with its size, or its progress. */
export function ModelNeeded({ id }: { id: string }) {
  const m = useModels().find((x) => x.id === id);
  if (!m || m.state === 'ready') return null;
  if (m.state === 'downloading') return (
    <div className="model-needed">
      <p className="hint">Downloading {m.name}… {Math.round(m.fraction * 100)}%</p>
      <div className="flow-progress"><span style={{ width: `${Math.round(m.fraction * 100)}%` }} /></div>
    </div>
  );
  return <p className="hint model-needed">The first time, this downloads {m.name} ({megabytes(m.bytes)}), once. It runs on this computer: nothing you film is uploaded.{m.state === 'failed' ? ` The last try didn’t work: ${m.error}.` : ''}</p>;
}

/** Listens to the edit and writes what's said as captions. */
export function SubtitlesDialog(p: { timeline: Timeline; onCaptions: (captions: Overlay[]) => void; onSaveSrt: () => void; onClose: () => void }) {
  const [language, setLanguage] = useState('auto');
  const [job, setJob] = useState<SubtitleProgress | null>(null);
  const [heard, setHeard] = useState<string>('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const before = p.timeline.overlays.filter((o) => o.caption).length;
  const start = async () => {
    const a = new AbortController();
    abort.current = a;
    setError(null); setDone(null); setHeard('');
    setJob({ stage: 'download', fraction: 0 });
    try {
      const r = await makeSubtitles(p.timeline, language, setJob, a.signal, (s) => setHeard(s.text));
      p.onCaptions(r.captions);
      const lang = LANGUAGES.find(([c]) => c === r.language)?.[1] ?? r.language;
      setDone(r.captions.length ? `Added ${r.captions.length} caption${r.captions.length === 1 ? '' : 's'} (${lang}). Each one is text on the timeline: click it to change the words, timing or look.` : 'No talking was heard in the clips’ sound, so no captions were added.');
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && (e as Error).message !== 'Cancelled') setError((e as Error).message);
    } finally {
      setJob(null);
      abort.current = null;
    }
  };
  const stop = () => { abort.current?.abort(); void ace.modelsCancel(WHISPER); };
  return (
    <div className="modal-backdrop">
      <div className="modal subtitles-dialog" role="dialog" aria-label="Auto subtitles">
        <h2>Auto subtitles</h2>
        <p className="hint">Listens to your clips’ own sound (not the music) and writes what’s said as captions on the timeline. You can also save them as an .srt file for YouTube and other sites.</p>
        <label className="field">Language spoken
          <select value={language} disabled={!!job} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        <ModelNeeded id={WHISPER} />
        {before > 0 && !job && !done && <p className="hint">This replaces the {before} caption{before === 1 ? '' : 's'} made before. Your other text stays.</p>}
        {job && (
          <div>
            <p className="hint">{STAGE[job.stage]}… {job.stage === 'sound' ? '' : `${Math.round(job.fraction * 100)}%`}</p>
            <div className="flow-progress"><span style={{ width: `${Math.round(job.fraction * 100)}%` }} /></div>
            {heard && <p className="heard">“{heard}”</p>}
          </div>
        )}
        {done && <p className="notice-text">{done}</p>}
        {error && <p className="error-text">Subtitles couldn’t be made: {error}</p>}
        <div className="modal-actions">
          {job ? <button onClick={stop}>Stop</button> : <button onClick={p.onClose}>{done ? 'Done' : 'Cancel'}</button>}
          {done && p.timeline.overlays.some((o) => o.caption) && <button onClick={p.onSaveSrt}>Save as .srt…</button>}
          {!done && <button className="primary" disabled={!!job || !p.timeline.clips.length} onClick={() => void start()}>Make subtitles</button>}
        </div>
      </div>
    </div>
  );
}

/** The AI models on this computer: their sizes, and removing them to free space. */
export function ModelsDialog(p: { onClose: () => void }) {
  const models = useModels();
  return (
    <div className="modal-backdrop">
      <div className="modal models-dialog" role="dialog" aria-label="AI models">
        <h2>AI models</h2>
        <p className="hint">Each AI tool downloads its model the first time you use it, once. They run on this computer: nothing you film is uploaded.</p>
        <div className="models-list">
          {models.map((m) => (
            <div key={m.id} className="model-row">
              <div>
                <b>{m.name}</b>
                <span className="muted"> · {m.what} · {megabytes(m.bytes)} · {m.licence}</span>
              </div>
              <span className="grow" />
              {m.state === 'ready' && <button className="link" onClick={() => void ace.modelsRemove(m.id).then(() => { forgetModelFiles(m.id); void refreshModels(); })}>Remove</button>}
              {m.state === 'downloading' && <span className="muted">Downloading {Math.round(m.fraction * 100)}%</span>}
              {(m.state === 'missing' || m.state === 'failed') && <span className="muted">Not downloaded</span>}
            </div>
          ))}
        </div>
        <div className="modal-actions"><button className="primary" onClick={p.onClose}>Done</button></div>
      </div>
    </div>
  );
}

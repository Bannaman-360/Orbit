// Import from a memory card: pick recordings, choose where they go, copy them with every byte checked.

import { useEffect, useMemo, useRef } from 'react';
import { baseName, type ListedRecording } from './api';
import { chooseDest, pauseImport, pick, running, scan, setOption, setOpened, startImport, stopImport, useCards, type RecordingState } from './cardImport';
import { fmtTime } from './ui';
import { Icon } from './ui/Icon';

export const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const fmtLeft = (s: number) => (s < 60 ? 'less than a minute' : s < 3600 ? `about ${Math.round(s / 60)} min` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
// (Recording times are the camera's own clock: shown as they are.)
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Tile({ r, on, state, thumb, locked, onToggle }: { r: ListedRecording; on: boolean; state?: RecordingState; thumb?: string; locked: boolean; onToggle: (e: React.MouseEvent) => void }) {
  const mark = state?.state === 'done' ? 'Imported' : state?.state === 'failed' ? 'Not imported' : state?.state === 'copying' ? `Copying ${Math.round(state.fraction * 100)}%` : state?.state === 'checking' ? 'Checking…' : r.imported ? (r.copies ? 'Imported' : 'Imported before') : '';
  const title = [
    r.files.length > 1 ? `${r.files.length} files of one recording:\n${r.files.map((f) => f.name).join('\n')}` : r.name,
    r.unfinished ? 'The camera didn’t finish this recording, so it may not open. Putting the card back in the camera can repair it.' : '',
    state?.state === 'failed' ? state.error : '',
    r.imported && r.copies ? `Already copied to ${r.copies[0]}. Importing it again only adds it to the project.` : r.imported ? 'It was imported before, but the copy has been moved or deleted since. Importing it copies it again.' : '',
  ].filter(Boolean).join('\n');
  return (
    <button className={`card-tile${on ? ' picked' : ''}${r.imported ? ' imported' : ''}`} role="checkbox" aria-checked={on} aria-label={r.name} title={title} disabled={locked && !state} onClick={locked ? undefined : onToggle} data-state={state?.state ?? ''}>
      <span className="thumb" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined }}>
        {!thumb && <Icon name="media" size={26} />}
        {r.is360 && <b className="badge">360</b>}
        <i className="card-check">{on || state?.state === 'done' ? <Icon name="check" size={12} /> : null}</i>
        {r.seconds > 0 && <span className="dur">{fmtTime(r.seconds * 1e6).replace(/\.\d+$/, '')}</span>}
        {(state?.state === 'copying' || state?.state === 'checking') && <span className="card-bar"><span style={{ width: `${state.state === 'checking' ? 100 : state.fraction * 100}%` }} /></span>}
      </span>
      <span className="name">{r.name}</span>
      <span className="muted small card-info">{fmtClock(r.created)} · {fmtBytes(r.size)}{r.files.length > 1 ? ` · ${r.files.length} parts` : ''}</span>
      {mark ? <span className={`small card-mark ${state?.state === 'failed' ? 'bad' : ''}`}>{mark}</span> : r.unfinished ? <span className="small card-mark bad">Unfinished recording</span> : null}
    </button>
  );
}

export function ImportWindow({ onClose }: { onClose: () => void }) {
  const st = useCards((s) => s);
  const { cards, root, list, picked, run, dest } = st;
  const busy = running(run);
  useEffect(() => { void setOpened(true); return () => { void setOpened(false); }; }, []);

  const shown = useMemo(() => (st.hideImported ? list.filter((r) => !r.imported || run?.states.has(r.id)) : list), [list, st.hideImported, run]);
  // Newest day first; in the order they were recorded within it.
  const days = useMemo(() => {
    const m = new Map<string, ListedRecording[]>();
    for (const r of shown) (m.get(r.day) ?? m.set(r.day, []).get(r.day)!).push(r);
    return [...m.values()].sort((a, b) => b[0]!.created - a[0]!.created);
  }, [shown]);
  const order = days.flat();

  const anchor = useRef<string | null>(null);
  const toggle = (r: ListedRecording, e: React.MouseEvent) => {
    const next = new Set(picked);
    const a = order.findIndex((x) => x.id === anchor.current), b = order.findIndex((x) => x.id === r.id);
    if (e.shiftKey && a >= 0) for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x.id);
    else if (!next.delete(r.id)) next.add(r.id);
    anchor.current = r.id;
    pick(next);
  };
  const setAll = (rs: ListedRecording[], on: boolean) => { const next = new Set(picked); for (const r of rs) on ? next.add(r.id) : next.delete(r.id); pick(next); };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !busy) { e.preventDefault(); setAll(shown, !shown.every((r) => picked.has(r.id))); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const chosen = list.filter((r) => picked.has(r.id) && shown.includes(r));
  const toCopy = chosen.filter((r) => !r.copies);
  const need = toCopy.reduce((n, r) => n + r.size, 0);
  const full = dest?.free != null && need > dest.free - 200e6;
  const doneCount = run ? [...run.states.values()].filter((x) => x.state === 'done').length : 0;
  const failed = run ? [...run.states.values()].filter((x) => x.state === 'failed').length : 0;
  const card = cards.find((c) => c.root === root);
  const summary = !run?.ended ? null
    : run.ended.error ? { bad: true, text: `${run.ended.error} ${doneCount ? `${plural(doneCount, 'recording')} had finished and ${doneCount === 1 ? 'is' : 'are'} safe.` : ''}` }
      : run.ended.stopped ? { bad: false, text: `Stopped. ${doneCount ? `${plural(doneCount, 'recording')} had finished and ${doneCount === 1 ? 'is' : 'are'} kept.` : 'Nothing was imported.'}` }
        : failed ? { bad: true, text: `${plural(doneCount, 'recording')} imported; ${failed} couldn’t be. Hover over ${failed === 1 ? 'it' : 'them'} for the reason.` }
          : { bad: false, text: `${plural(doneCount, 'recording')} imported. Every copy was checked against the card.` };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal import" role="dialog" aria-label="Import from memory card">
        <header className="import-head">
          <h2>Import from memory card</h2>
          {cards.length > 1
            ? <select aria-label="Memory card" value={root ?? ''} disabled={busy} onChange={(e) => void scan(e.target.value)}>{cards.map((c) => <option key={c.root} value={c.root}>{c.name}</option>)}</select>
            : card && <span className="muted">{card.name}</span>}
          <span className="grow" />
          {list.length > 0 && <label className="inline check"><input type="checkbox" checked={st.hideImported} disabled={busy} onChange={(e) => setOption('hideImported', e.target.checked)} /> Hide imported</label>}
        </header>

        <div className="import-list">
          {!cards.length && !list.length && <div className="import-empty"><Icon name="card" size={40} /><b>No memory card found</b><span className="muted">Put the camera’s card in a card reader and it will show up here. A camera connected by cable may not appear as a card.</span></div>}
          {st.scanError && <div className="import-empty"><Icon name="card" size={40} /><b>{st.scanError}</b><button onClick={() => root && void scan(root)}>Try again</button></div>}
          {cards.length > 0 && st.scanning && !list.length && <div className="import-empty"><span className="muted">Looking at the card…</span></div>}
          {cards.length > 0 && !st.scanning && !st.scanError && !list.length && <div className="import-empty"><Icon name="card" size={40} /><b>No recordings on this card</b></div>}
          {list.length > 0 && !shown.length && <div className="import-empty"><b>Everything on this card has been imported</b></div>}
          {days.map((rs) => {
            const all = rs.every((r) => picked.has(r.id));
            return (
              <section key={rs[0]!.day}>
                <h3><span>{fmtDay(rs[0]!.created)}</span><span className="muted small">{plural(rs.length, 'recording')}</span>{!busy && <button className="link" onClick={() => setAll(rs, !all)}>{all ? 'Deselect all' : 'Select all'}</button>}</h3>
                <div className="card-grid">
                  {rs.map((r) => <Tile key={r.id} r={r} on={picked.has(r.id)} state={run?.states.get(r.id)} thumb={st.thumbs.get(r.id)} locked={busy} onToggle={(e) => toggle(r, e)} />)}
                </div>
              </section>
            );
          })}
        </div>

        {busy ? (
          <div className="import-foot progress">
            <div className="bar"><div style={{ width: `${run.fraction * 100}%` }} /></div>
            <div className="import-row">
              <span className="import-status">{run.paused ? 'Paused' : `Importing ${Math.min(run.ids.length, doneCount + failed + 1)} of ${run.ids.length}`} · {Math.round(run.fraction * 100)}%{!run.paused && run.speed ? ` · ${fmtBytes(run.speed)}/s · ${fmtLeft(run.left)} left` : ''}</span>
              <span className="grow" />
              <button onClick={() => stopImport()}>Stop</button>
              <button onClick={() => pauseImport(!run.paused)}>{run.paused ? 'Resume' : 'Pause'}</button>
              <button className="primary" onClick={onClose} title="The import carries on while you edit">Keep editing</button>
            </div>
          </div>
        ) : (
          <div className="import-foot">
            {st.error && <p className="error" role="alert">{st.error}</p>}
            {summary && <p className={summary.bad ? 'error' : 'ok'} role="status">{summary.text}</p>}
            <div className="import-row">
              <span className="muted">Copy to</span>
              <button className="import-dest" title={dest ? `${dest.path}\nEach day gets its own folder in it.` : ''} onClick={() => void chooseDest()}><Icon name="open" size={14} /> {dest ? baseName(dest.path) : '…'} <span className="muted">Change…</span></button>
              <label className="inline check"><input type="checkbox" checked={st.addToProject} onChange={(e) => setOption('addToProject', e.target.checked)} /> Add to this project</label>
              <span className="grow" />
              <span className={`small ${full ? 'error' : 'muted'}`}>{chosen.length ? `${plural(chosen.length, 'recording')}${need ? ` · ${fmtBytes(need)}` : ''}` : list.length ? 'Nothing selected' : ''}{dest?.free != null ? `${list.length ? ' · ' : ''}${fmtBytes(dest.free)} free` : ''}</span>
            </div>
            {full && <p className="error">There isn’t enough free space for these. Select fewer, or choose a folder on another disk.</p>}
            <div className="modal-actions">
              <span className="muted small grow">Nothing on the card is changed or deleted.</span>
              <button onClick={onClose}>{run?.ended ? 'Done' : 'Close'}</button>
              <button className="primary" disabled={!chosen.length || full || (!toCopy.length && !st.addToProject)} onClick={() => void startImport()}>{chosen.length && !toCopy.length ? `Add ${chosen.length} to project` : `Import${chosen.length ? ` ${chosen.length}` : ''}`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

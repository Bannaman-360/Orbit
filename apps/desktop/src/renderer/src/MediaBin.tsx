// Left panel: imported media. Double-click or drag to the timeline to add.

import { useState } from 'react';
import { ace, baseName } from './api';
import { MISSING, type Media } from './media';
import { fmtTime } from './ui';
import { Icon } from './ui/Icon';
import { hasProxy, PREVIEW_LEVELS, proxyErrors, proxyProgress, type PreviewLevel } from './proxy';

export interface BinItem {
  path: string;
  media?: Media;
  error?: string;
  /** 0–5 stars. */
  rating?: number;
  flag?: 'fav' | 'reject';
  /** The folder it's in (none: the top level). */
  bin?: string;
}

export interface MediaFolder { id: string; name: string; parent?: string }
export type BinPatch = Partial<Pick<BinItem, 'rating' | 'flag' | 'bin'>>;
type Show = 'all' | 'fav' | 'rated' | 'notRejected';
const SHOWS: [Show, string][] = [['all', 'All'], ['notRejected', 'Hide rejected'], ['fav', 'Favourites'], ['rated', '3 stars or more']];
const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export function MediaBin({ items, folders = [], onAdd, onConnect, onImport, onRemove, onSource, onItem, onFolders, onRelink, onProxiesCleared, onBatchExport, level }: {
  items: BinItem[];
  folders?: MediaFolder[];
  onAdd: (path: string) => void;
  /** Put it over the main row at the playhead (on the lowest free track above). */
  onConnect?: (path: string) => void;
  onImport: () => void;
  onRemove: (path: string) => void;
  onSource?: (path: string) => void;
  onItem?: (path: string, patch: BinPatch) => void;
  onFolders?: (f: MediaFolder[]) => void;
  /** Look for missing files. */
  onRelink?: () => void;
  onProxiesCleared?: () => void;
  /** Export several videos at once (each on its own). */
  onBatchExport?: () => void;
  level: PreviewLevel;
}) {
  const levelLabel = PREVIEW_LEVELS.find(([l]) => l === level)?.[1] ?? '';
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [usage, setUsage] = useState<{ files: number; bytes: number } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const missing = items.filter((it) => it.error === MISSING).length;
  const q = query.trim().toLowerCase();
  const visible = (it: BinItem) =>
    (!q || baseName(it.path).toLowerCase().includes(q)) &&
    (show === 'all' || (show === 'fav' && it.flag === 'fav') || (show === 'rated' && (it.rating ?? 0) >= 3) || (show === 'notRejected' && it.flag !== 'reject'));
  const filtering = !!q || show !== 'all';
  const isMedia = (e: React.DragEvent) => e.dataTransfer.types.includes('text/x-ace-media');
  const dropInto = (folder: string | undefined) => ({
    onDragOver: (e: React.DragEvent) => { if (isMedia(e)) { e.preventDefault(); e.stopPropagation(); setOver(folder ?? ''); } },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => { const p = e.dataTransfer.getData('text/x-ace-media'); setOver(null); if (p && onItem) { e.preventDefault(); e.stopPropagation(); onItem(p, { bin: folder }); } },
  });
  const newFolder = (parent?: string) => {
    const id = `f${Date.now().toString(36)}`;
    onFolders?.([...folders, { id, name: 'New folder', parent }]);
    setRenaming(id);
  };
  const removeFolder = (f: MediaFolder) => {
    // Its items and folders move up a level; nothing is deleted from disk.
    for (const it of items) if (it.bin === f.id) onItem?.(it.path, { bin: f.parent });
    onFolders?.(folders.filter((x) => x.id !== f.id).map((x) => (x.parent === f.id ? { ...x, parent: f.parent } : x)));
  };

  const itemView = (it: BinItem) => (
          <div
      key={it.path}
      className={`bin-item${it.error ? ' error' : ''}${!it.media && !it.error ? ' loading' : ''}${it.flag === 'reject' ? ' rejected' : ''}`}
      draggable={!!it.media}
      onDragStart={(e) => e.dataTransfer.setData('text/x-ace-media', it.path)}
      onDoubleClick={() => it.media && onAdd(it.path)}
      title={it.error ?? `${it.media && it.media.parts.length > 1 ? `${it.media.parts.length} files joined into one recording:\n${it.media.parts.map((x) => `${baseName(x.path)} (from ${fmtTime(x.startUs).replace(/\.\d+$/, '')})`).join('\n')}` : it.path}${it.media?.partsNote ? `\n${it.media.partsNote}` : ''}\nDouble-click or drag to the timeline`}
    >
      <div className="thumb" style={{ backgroundImage: it.media?.thumbnail ? `url(${it.media.thumbnail})` : undefined }}>
        {it.media?.is360 && <b className="badge">360</b>}
        {it.media && <span className="dur">{fmtTime(it.media.durationUs).replace(/\.\d+$/, '')}</span>}
      </div>
      <div className="bin-meta">
        <span className="name">{it.flag === 'fav' && <span className="bin-fav-mark" aria-label="Favourite">♥ </span>}{baseName(it.path)}</span>
        <span className="muted small">
          {it.error ? <span className="bin-why">{it.error}</span> : it.media ? `${it.media.width}×${it.media.height}${it.media.tracks.length > 1 ? '×2' : ''} · ${Math.round(it.media.fps)} fps${it.media.parts.length > 1 ? ` · ${it.media.parts.length} parts` : ''}` : 'Opening…'}
        </span>
        {it.media?.partsNote && <span className="proxy-state error" title={it.media.partsNote}>Not all parts joined</span>}
        {it.media && level > 1 && (() => {
          const p = proxyProgress.get(it.path);
          const err = proxyErrors.get(it.path);
          if (err) return <span className="proxy-state error" title={err}>{levelLabel} preview failed</span>;
          if (p !== undefined) return (
            <span className="proxy-state building">
              Building {levelLabel} preview {Math.round(p * 100)}%
              <span className="mini-bar"><span style={{ width: `${p * 100}%` }} /></span>
            </span>
          );
          return hasProxy(it.media, level) ? <span className="proxy-state ready">{levelLabel} preview ready</span> : <span className="proxy-state">Waiting to build {levelLabel} preview</span>;
        })()}
        {it.media && onItem && (
          <div className="bin-rate" onPointerDown={(e) => e.stopPropagation()}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={`star${(it.rating ?? 0) >= n ? ' on' : ''}`} aria-label={`${n} star${n === 1 ? '' : 's'}`} title={`${n} star${n === 1 ? '' : 's'} (click again to clear)`} onClick={() => onItem(it.path, { rating: it.rating === n ? 0 : n })}>★</button>
            ))}
            <button className={`flag fav${it.flag === 'fav' ? ' on' : ''}`} aria-label="Favourite" title="Favourite" onClick={() => onItem(it.path, { flag: it.flag === 'fav' ? undefined : 'fav' })}>♥</button>
            <button className={`flag reject${it.flag === 'reject' ? ' on' : ''}`} aria-label="Reject" title="Reject (hide it with Hide rejected)" onClick={() => onItem(it.path, { flag: it.flag === 'reject' ? undefined : 'reject' })}>⊘</button>
          </div>
        )}
      </div>
    <div className="bin-actions">
        {it.media && onSource && <button title="View on its own: mark in and out, then insert at the playhead" onClick={() => onSource(it.path)}>View</button>}
        {it.media && <button title="Add to timeline" onClick={() => onAdd(it.path)}>＋</button>}
        {it.media && onConnect && <button title="Add over the main row at the playhead (picture in picture, split screen)" aria-label="Add over the main row" onClick={() => onConnect(it.path)}><Icon name="layers" size={13} /></button>}
        <button title="Remove from bin" onClick={() => onRemove(it.path)}>✕</button>
      </div>
    </div>
  );

  const folderView = (f: MediaFolder, depth: number): React.ReactNode => {
    const inside = items.filter((it) => it.bin === f.id && visible(it));
    const sub = folders.filter((x) => x.parent === f.id);
    const open = !closed.has(f.id) || filtering;
    return (
      <div key={f.id} className={`bin-folder${over === f.id ? ' drop' : ''}`} style={{ marginLeft: depth * 10 }} {...dropInto(f.id)}>
        <div className="bin-folder-head">
          <button className="bin-folder-toggle" aria-expanded={open} onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}>
            <span className={`chevron${open ? ' open' : ''}`} /><Icon name="folder" size={14} />
          </button>
          {renaming === f.id
            ? <input autoFocus defaultValue={f.name} aria-label="Folder name" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} onBlur={(e) => { const name = e.target.value.trim() || f.name; onFolders?.(folders.map((x) => (x.id === f.id ? { ...x, name } : x))); setRenaming(null); }} />
            : <span className="bin-folder-name" onDoubleClick={() => setRenaming(f.id)} title="Double-click to rename">{f.name}</span>}
          <span className="muted small">{items.filter((it) => it.bin === f.id).length || ''}</span>
          <button className="bin-folder-act" title="New folder inside" aria-label="New folder inside" onClick={() => newFolder(f.id)}><Icon name="plus" size={12} /></button>
          <button className="bin-folder-act" title="Remove folder (its videos stay)" aria-label="Remove folder" onClick={() => removeFolder(f)}><Icon name="close" size={12} /></button>
        </div>
        {open && <>{sub.map((x) => folderView(x, 1))}{inside.map(itemView)}</>}
      </div>
    );
  };

  const top = items.filter((it) => (!it.bin || !folders.some((f) => f.id === it.bin)) && visible(it));
  return (
    <aside className="bin">
      <header>
        <span className="muted">{items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'No media yet'}</span>
        <span className="bin-head-actions">
          <button onClick={onImport}><Icon name="plus" size={14} /> Import</button>
          <button className="bin-more" aria-label="More" title="Folders, missing files, preview copies" onClick={() => { setMenu((m) => !m); void ace.proxyUsage().then(setUsage); }}>•••</button>
        </span>
      </header>
      {menu && (
        <div className="bin-menu" onMouseLeave={() => setMenu(false)}>
          <button onClick={() => { setMenu(false); newFolder(); }}><Icon name="folder" size={14} /> New folder</button>
          <button disabled={!missing} onClick={() => { setMenu(false); onRelink?.(); }}><Icon name="media" size={14} /> {missing ? `Find ${missing} missing video${missing === 1 ? '' : 's'}…` : 'No missing videos'}</button>
          {onBatchExport && <button disabled={!items.some((i) => i.media)} onClick={() => { setMenu(false); onBatchExport(); }}><Icon name="export" size={14} /> Export several videos…</button>}
          <div className="bin-menu-sep" />
          <p className="muted small">Preview copies{usage ? `: ${usage.files} file${usage.files === 1 ? '' : 's'}, ${fmtBytes(usage.bytes)}` : ''}. Smaller copies for smooth previews; the originals are never changed.</p>
          <button onClick={() => { void ace.proxyReveal(); setMenu(false); }}>Show in {navigator.platform.toLowerCase().includes('mac') ? 'Finder' : 'Explorer'}</button>
          <button className="danger" disabled={!usage?.files} onClick={() => { void ace.proxyClear().then(() => { onProxiesCleared?.(); return ace.proxyUsage(); }).then(setUsage); }}>Delete preview copies</button>
        </div>
      )}
      {missing > 0 && (
        <div className="bin-missing">
          <span>{missing} video{missing === 1 ? ' is' : 's are'} missing</span>
          <button onClick={onRelink}>Find…</button>
        </div>
      )}
      {items.length > 0 && (
        <div className="bin-filter">
          <input type="search" placeholder="Search" aria-label="Search media" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as Show)}>{SHOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
      )}
      <div className={`bin-list${over === '' ? ' drop' : ''}`} {...dropInto(undefined)}>
        {items.length === 0 && <p className="empty-panel">Import GoPro .360 or regular videos to get started.</p>}
        {folders.filter((f) => !f.parent || !folders.some((x) => x.id === f.parent)).map((f) => folderView(f, 0))}
        {top.map(itemView)}
        {filtering && items.length > 0 && !items.some(visible) && <p className="empty-panel">Nothing matches. Try another search or show All.</p>}
      </div>
    </aside>
  );
}

// Left panel: imported media. Double-click or drag to the timeline to add.

import { baseName } from './api';
import type { Media } from './media';
import { fmtTime } from './ui';
import { Icon } from './ui/Icon';
import { hasProxy, PREVIEW_LEVELS, proxyErrors, proxyProgress, type PreviewLevel } from './proxy';

export interface BinItem {
  path: string;
  media?: Media;
  error?: string;
}

export function MediaBin({ items, onAdd, onImport, onRemove, level }: { items: BinItem[]; onAdd: (path: string) => void; onImport: () => void; onRemove: (path: string) => void; level: PreviewLevel }) {
  const levelLabel = PREVIEW_LEVELS.find(([l]) => l === level)?.[1] ?? '';
  return (
    <aside className="bin">
      <header>
        <span className="muted">{items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'No media yet'}</span>
        <button onClick={onImport}><Icon name="plus" size={14} /> Import</button>
      </header>
      <div className="bin-list">
        {items.length === 0 && <p className="empty-panel">Import GoPro .360 or regular videos to get started.</p>}
        {items.map((it) => (
          <div
            key={it.path}
            className={`bin-item${it.error ? ' error' : ''}${!it.media && !it.error ? ' loading' : ''}`}
            draggable={!!it.media}
            onDragStart={(e) => e.dataTransfer.setData('text/x-ace-media', it.path)}
            onDoubleClick={() => it.media && onAdd(it.path)}
            title={it.error ?? `${it.path}\nDouble-click or drag to the timeline`}
          >
            <div className="thumb" style={{ backgroundImage: it.media?.thumbnail ? `url(${it.media.thumbnail})` : undefined }}>
              {it.media?.is360 && <b className="badge">360</b>}
              {it.media && <span className="dur">{fmtTime(it.media.durationUs).replace(/\.\d+$/, '')}</span>}
            </div>
            <div className="bin-meta">
              <span className="name">{baseName(it.path)}</span>
              <span className="muted small">
                {it.error ? 'Cannot open' : it.media ? `${it.media.width}×${it.media.height}${it.media.is360 ? '×2' : ''} · ${Math.round(it.media.fps)} fps` : 'Opening…'}
              </span>
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
            </div>
            <div className="bin-actions">
              {it.media && <button title="Add to timeline" onClick={() => onAdd(it.path)}>＋</button>}
              <button title="Remove from bin" onClick={() => onRemove(it.path)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

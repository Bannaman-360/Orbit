// The Projects page: every saved project in one place, to open, rename, copy or put away.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ace, type ProjectEntry } from './api';
import { AppMenu } from './Menu';
import { Icon } from './ui/Icon';

const MAC = navigator.platform.toLowerCase().includes('mac');
const SHOW_IN = MAC ? 'Show in Finder' : 'Show in File Explorer';

/** "Just now", "5 minutes ago", "Yesterday", or a date. */
export function whenEdited(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 45) return 'Just now';
  if (s < 3600) return rel.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rel.format(-Math.round(s / 3600), 'hour');
  if (s < 7 * 86400) return cap(rel.format(-Math.round(s / 86400), 'day'));
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const length = (us: number) => {
  const s = Math.round(us / 1e6), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const details = (p: ProjectEntry) => [p.clips === undefined ? '' : p.clips === 1 ? '1 clip' : `${p.clips} clips`, p.durationUs ? length(p.durationUs) : ''].filter(Boolean).join(' · ');

export function ProjectsPage({ current, onOpen, onNew, onOpenOther, onMoved, onClose }: {
  /** The project open now. */
  current: string | null;
  onOpen: (path: string) => void;
  onNew: () => void;
  /** Open a project file from anywhere. */
  onOpenOther: () => void;
  /** A project was renamed (to `to`) or removed (`to` = null). */
  onMoved: (from: string, to: string | null) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<ProjectEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ p: ProjectEntry; x: number; y: number } | null>(null);
  const [renaming, setRenamingState] = useState<string | null>(null);
  // (Enter, then the field going away, would otherwise rename twice.)
  const renamingRef = useRef<string | null>(null);
  const setRenaming = (p: string | null) => { renamingRef.current = p; setRenamingState(p); };
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ProjectEntry | null>(null);
  const refresh = useCallback(() => ace.projectsList().then(setList, (e) => { setList([]); setProblem(`The projects couldn’t be listed: ${e}`); }), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || menu || renaming || confirm) return;
      e.preventDefault();
      onClose();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose, menu, renaming, confirm]);

  const act = async (what: string, f: () => Promise<unknown>) => {
    try { await f(); } catch (e) { setProblem(`${what} didn’t work: ${String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')}`); }
    await refresh();
  };
  const rename = (p: ProjectEntry, name: string) => {
    if (renamingRef.current !== p.path) return;
    setRenaming(null);
    if (!name.trim() || name.trim() === p.name) return;
    void act('Renaming', async () => { const to = await ace.projectsRename(p.path, name.trim()); onMoved(p.path, to); });
  };
  const remove = (p: ProjectEntry) => {
    setConfirm(null);
    void act(p.inLibrary ? 'Moving to the Trash' : 'Removing from the list', async () => { await ace.projectsRemove(p.path); onMoved(p.path, null); });
  };
  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));

  return (
    <div className="modal-backdrop projects-backdrop">
      <div className="modal projects" role="dialog" aria-label="Projects">
        <header className="projects-head">
          <h2>Projects</h2>
          <label className="projects-search">
            <Icon name="search" size={15} />
            <input placeholder="Search" aria-label="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <span className="projects-grow" />
          <button onClick={onOpenOther}>Open other…</button>
          <button className="primary" onClick={onNew}><Icon name="plus" size={15} /> New project</button>
          <button className="projects-close" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="close" size={15} /></button>
        </header>
        {problem && <div className="projects-problem" role="alert" onClick={() => setProblem(null)}>{problem} ✕</div>}
        <div className="projects-body">
          {list && !list.length && (
            <div className="projects-empty">
              <Icon name="projects" size={40} />
              <b>No saved projects yet</b>
              <span>Press Save ({MAC ? '⌘S' : 'Ctrl+S'}) while editing and your project shows up here. After that, changes are saved as you go.</span>
            </div>
          )}
          {list && !!list.length && !shown.length && <div className="projects-empty"><span>No project names match “{query}”.</span></div>}
          <div className="projects-grid">
            {shown.map((p) => {
              const now = p.path === current;
              return (
                <div key={p.path} className={`project-card${now ? ' current' : ''}`} onContextMenu={(e) => { e.preventDefault(); setMenu({ p, x: e.clientX, y: e.clientY }); }}>
                  <button className="project-thumb" title={now ? 'Open now' : `Open “${p.name}”`} onClick={() => (now ? onClose() : onOpen(p.path))} style={{ backgroundImage: p.thumb ? `url(${p.thumb})` : undefined }}>
                    {!p.thumb && <Icon name="clip" size={30} />}
                    {now && <span className="project-badge">Open now</span>}
                  </button>
                  <div className="project-info">
                    {renaming === p.path ? (
                      <input
                        className="project-rename"
                        aria-label="Project name"
                        autoFocus
                        defaultValue={p.name}
                        onFocus={(e) => e.target.select()}
                        onBlur={(e) => rename(p, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') rename(p, e.currentTarget.value);
                          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                        }}
                      />
                    ) : (
                      <b title={p.inLibrary ? p.name : p.path} onDoubleClick={() => setRenaming(p.path)}>{p.name}</b>
                    )}
                    <span>{[whenEdited(p.modified), details(p)].filter(Boolean).join(' · ')}</span>
                  </div>
                  <button className="project-more" aria-label={`More for “${p.name}”`} title="More" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ p, x: r.left, y: r.bottom + 4 }); }}>
                    <Icon name="more" size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <AppMenu
        open={!!menu}
        at={menu ?? undefined}
        title={menu?.p.name}
        onClose={() => setMenu(null)}
        items={menu ? [
          { label: 'Open', onClick: () => { setMenu(null); if (menu.p.path === current) onClose(); else onOpen(menu.p.path); } },
          'sep',
          { label: 'Rename', onClick: () => { setMenu(null); setRenaming(menu.p.path); } },
          { label: 'Duplicate', icon: 'duplicate', onClick: () => { setMenu(null); void act('Duplicating', () => ace.projectsDuplicate(menu.p.path)); } },
          { label: SHOW_IN, onClick: () => { setMenu(null); void act(SHOW_IN, () => ace.projectsReveal(menu.p.path)); } },
          'sep',
          { label: menu.p.inLibrary ? 'Move to Trash…' : 'Remove from list…', icon: 'trash', onClick: () => { setMenu(null); setConfirm(menu.p); } },
        ] : []}
      />
      {confirm && (
        <ConfirmRemove project={confirm} isOpen={confirm.path === current} onCancel={() => setConfirm(null)} onConfirm={() => remove(confirm)} />
      )}
    </div>
  );
}

function ConfirmRemove({ project, isOpen, onCancel, onConfirm }: { project: ProjectEntry; isOpen: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEscape(onCancel);
  const bin = MAC ? 'Trash' : 'Recycle Bin';
  return (
    <div className="modal-backdrop projects-sheet-backdrop">
      <div className="modal" role="alertdialog" aria-label={project.inLibrary ? 'Move to Trash' : 'Remove from list'}>
        <h2>{project.inLibrary ? `Move “${project.name}” to the ${bin}?` : `Remove “${project.name}” from the list?`}</h2>
        <p className="muted">
          {project.inLibrary
            ? `You can get it back from the ${bin} until it’s emptied. Your videos aren’t touched.`
            : 'The project file stays where it is; it just won’t be listed here. Your videos aren’t touched.'}
          {isOpen && ' It’s open now, so the edit you see becomes an unsaved project.'}
        </p>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" autoFocus onClick={onConfirm}>{project.inLibrary ? `Move to ${bin}` : 'Remove'}</button>
        </div>
      </div>
    </div>
  );
}

/** Asks for a name the first time a project is saved. */
export function NameSheet({ title, action, initial, onCancel, onSave }: { title: string; action: string; initial: string; onCancel: () => void; onSave: (name: string) => void }) {
  useEscape(onCancel);
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <div className="modal-backdrop projects-sheet-backdrop">
      <form className="modal" role="dialog" aria-label={title} onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
        <h2>{title}</h2>
        <label className="name-field">
          <span className="muted">Name</span>
          <input ref={ref} autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted">It goes in Projects, and changes are saved as you go from then on.</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{action}</button>
        </div>
      </form>
    </div>
  );
}

function useEscape(f: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); f(); } };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [f]);
}

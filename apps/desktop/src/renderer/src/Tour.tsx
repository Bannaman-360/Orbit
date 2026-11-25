// First launch: a welcome screen, and a guided tour that points at the real parts of the window.
// Steps find their place by what is on screen (toolbar items, panels), so a rearranged window
// still works: a hidden panel is shown for its step and put back afterwards.

import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPrefs, LEVELS, setLevel, setPrefs, usePrefs } from './ui/prefs';
import { openPanels } from './ui/dockModel';
import { reopenPanel } from './ui/Customize';
import { Icon } from './ui/Icon';
import type { PanelId } from './ui/dockModel';

interface Step {
  /** Where to point, best first. None found: the card sits in the middle. */
  at: string[];
  /** A panel this step needs open. */
  panel?: PanelId;
  title: string;
  body: string;
  /** Where the card goes relative to what it points at. */
  side?: 'below' | 'above' | 'left' | 'right';
}

export const TOUR: Step[] = [
  { at: ['[data-item="import"]', '[data-panel-body="media"]'], panel: 'media', title: 'Bring in your videos', body: 'Click Import, or simply drag videos or whole folders from Finder or Explorer onto this window. GoPro .360 files and regular videos both work, and a recording split into chapters is joined back together.' },
  { at: ['[data-item="card"]'], title: 'Straight from the camera', body: 'Put in your memory card and choose Import from Memory Card. Every file is copied and checked, and recordings you already have are skipped.' },
  { at: ['[data-panel-body="media"]'], panel: 'media', title: 'Your media', body: 'Everything you import waits here. Double-click a clip, or drag it onto the timeline, to start your edit.', side: 'right' },
  { at: ['[data-panel-body="viewer"]'], panel: 'viewer', title: 'Look around', body: 'For 360 videos, drag in the preview to aim the camera and scroll to zoom: you choose the shot after riding. The controls below play, step frame by frame and set the preview quality.' },
  { at: ['[data-panel-body="timeline"]'], panel: 'timeline', title: 'Cut it together', body: 'Drag clip ends to trim, press S to split at the playhead, drag clips to reorder. Right-click a clip for slow motion and speed ramps; yellow arcs mark the jumps found in it.', side: 'above' },
  { at: ['.dock-tab[data-panel="reframe"]', '[data-panel-body="reframe"]'], panel: 'reframe', title: 'Fine-tune each clip', body: 'These tabs hold the view and keyframes, subject tracking, stabilization, colour and effects of the selected clip. Hover any control to learn what it does.', side: 'left' },
  { at: ['[data-item="gauges"]'], title: 'Show the ride’s data', body: 'Add speed, G-force, altitude, distance, airtime or a map from the camera’s own sensors, in a dozen designs, or a matching set in one click. Airtime counts every jump by itself.' },
  { at: ['[data-item="text"]'], title: 'Titles', body: 'Add text in any font and style, animated in and out.' },
  { at: ['[data-item="export"]'], title: 'Share it', body: 'Export as H.264 to play anywhere, HEVC for smaller files, 10-bit HEVC for the smoothest skies, or ProRes for further editing.', side: 'below' },
  { at: ['[data-item="customize"]'], title: 'Make it yours', body: 'Change the colours and layout, move toolbars and panels, and set your own shortcuts. You can take this tour again any time from the Help menu.' },
];

const visible = (el: Element | null): el is HTMLElement => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
};
const find = (s: Step) => {
  for (const q of s.at) {
    const el = document.querySelector(q);
    if (visible(el)) return q.startsWith('.dock-tab') ? (el.closest('.dock-group') as HTMLElement | null) ?? el : el;
  }
  return null;
};

export function Tour({ onClose, onStep }: { onClose: () => void; onStep?: (i: number) => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [startLayout] = useState(() => getPrefs().layout);
  const step = TOUR[i]!;
  const end = () => {
    // Panels opened for the tour go back the way they were.
    if (getPrefs().layout !== startLayout) setPrefs({ layout: startLayout }, 'tour');
    onClose();
  };
  // Open what the step needs, then find it (after the layout has settled).
  useEffect(() => {
    onStep?.(i);
    if (step.panel && !openPanels(getPrefs().layout).includes(step.panel)) setPrefs((p) => ({ layout: reopenPanel(p.layout, step.panel!) }), 'tour');
    let raf = 0, n = 0;
    const look = () => { const el = find(step); setRect(el?.getBoundingClientRect() ?? null); if (!el && n++ < 20) raf = requestAnimationFrame(look); };
    raf = requestAnimationFrame(look);
    const onResize = () => { const el = find(step); setRect(el?.getBoundingClientRect() ?? null); };
    addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', onResize); };
  }, [i]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') i < TOUR.length - 1 ? setI(i + 1) : end();
      else if (e.key === 'ArrowLeft') setI(Math.max(0, i - 1));
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  });
  // Put the card next to what it points at, on whichever side has room.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!card) return;
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14, m = 12;
    if (!rect) { setPos({ left: (innerWidth - cw) / 2, top: (innerHeight - ch) / 2 }); return; }
    const room = { below: innerHeight - rect.bottom, above: rect.top, right: innerWidth - rect.right, left: rect.left };
    const need = { below: ch + gap, above: ch + gap, right: cw + gap, left: cw + gap };
    const order: (keyof typeof room)[] = [step.side ?? 'below', 'below', 'above', 'right', 'left'];
    const side = order.find((s) => room[s] >= need[s] + m) ?? 'inside';
    let left = rect.left + rect.width / 2 - cw / 2, top = rect.top + rect.height / 2 - ch / 2;
    if (side === 'below') top = rect.bottom + gap;
    if (side === 'above') top = rect.top - gap - ch;
    if (side === 'right') left = rect.right + gap;
    if (side === 'left') left = rect.left - gap - cw;
    setPos({ left: Math.max(m, Math.min(innerWidth - cw - m, left)), top: Math.max(m, Math.min(innerHeight - ch - m, top)) });
  }, [rect, card, i]);
  const pad = 6;
  return createPortal(
    <div className="tour" role="dialog" aria-label="Tour of the app">
      {rect ? <div className="tour-spot" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} /> : <div className="tour-dim" />}
      <div className="tour-card" ref={setCard} style={pos}>
        <span className="tour-count">{i + 1} of {TOUR.length}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-dots">{TOUR.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
        <div className="tour-actions">
          <button className="link" onClick={end}>{i < TOUR.length - 1 ? 'Skip tour' : ''}</button>
          <span>
            {i > 0 && <button onClick={() => setI(i - 1)}>Back</button>}
            <button className="primary" autoFocus onClick={() => (i < TOUR.length - 1 ? setI(i + 1) : end())}>{i < TOUR.length - 1 ? 'Next' : 'Done'}</button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The first thing a new user sees. */
export function Welcome({ name, onImport, onCard, onTour, onOpen, onClose }: { name: string; onImport: () => void; onCard: () => void; onTour: () => void; onOpen: () => void; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  const level = usePrefs((p) => p.level);
  const choice = (icon: string, title: string, sub: string, run: () => void, primary = false) => (
    <button className={`welcome-choice${primary ? ' primary' : ''}`} onClick={() => { onClose(); run(); }}>
      <Icon name={icon} size={26} />
      <b>{title}</b>
      <span>{sub}</span>
    </button>
  );
  return (
    <div className="modal-backdrop welcome-backdrop">
      <div className="modal welcome" role="dialog" aria-label={`Welcome to ${name}`}>
        <div className="welcome-mark"><Icon name="gauge" size={34} /></div>
        <h1>Welcome to {name}</h1>
        <p className="welcome-sub">Edit your GoPro and action-camera rides: aim 360 shots after the fact, smooth out the bumps, add speed and airtime, and share.</p>
        <div className="welcome-level" role="group" aria-label="How much editing have you done?">
          <span>How much editing have you done?</span>
          <div className="seg">
            {LEVELS.map((l) => <button key={l.id} className={level === l.id ? 'on' : ''} title={l.note} onClick={() => setLevel(l.id)}>{l.name}</button>)}
          </div>
          <small>{LEVELS.find((l) => l.id === level)?.note ?? 'Pick one to set up the window to match. You can change it any time under Layouts.'}</small>
        </div>
        <div className="welcome-choices">
          {choice('import', 'Import videos', 'Or drag them onto the window', onImport, true)}
          {choice('card', 'From a memory card', 'Copies and checks every file', onCard)}
          {choice('play', 'Take the tour', 'A one-minute look around', onTour)}
        </div>
        <div className="welcome-foot">
          <button className="link" onClick={() => { onClose(); onOpen(); }}>Open a project…</button>
          <button className="link" onClick={onClose}>Start with an empty edit</button>
        </div>
      </div>
    </div>
  );
}

// App menu (☰) and the keyboard shortcuts sheet.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { overlayRoot } from './ui/drag';
import { Icon } from './ui/Icon';
import { COMMANDS, comboLabel, combosOf } from './ui/commands';
import { usePrefs } from './ui/prefs';


export interface MenuItem {
  label: string;
  hint?: string;
  onClick: () => void;
  checked?: boolean;
  disabled?: boolean;
  icon?: string;
}

export function AppMenu({ open, onClose, items, at, title }: {
  open: boolean;
  onClose: () => void;
  items: (MenuItem | 'sep')[];
  /** Open at this screen point (context menu) instead of under its anchor. */
  at?: { x: number; y: number };
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', h, true);
    return () => window.removeEventListener('pointerdown', h, true);
  }, [open, onClose]);
  // Keep it on screen (above the point if there is no room below).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !at || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height - (at.y > window.innerHeight - 60 ? 0 : 0)) : at.y}px`;
  }, [open, at?.x, at?.y, items.length]);
  // Arrow keys, Return and Escape, as in any menu.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') btns[(i + 1) % btns.length]?.focus();
      else if (e.key === 'ArrowUp') btns[(i - 1 + btns.length) % btns.length]?.focus();
      else if (e.key === 'Enter' && i >= 0) btns[i]!.click();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="menu context" ref={ref} role="menu" style={at ? { left: at.x, top: at.y } : undefined} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {title && <div className="menu-title">{title}</div>}
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="menu-check">{it.checked ? '✓' : ''}</span>
            {it.icon && <Icon name={it.icon} size={16} />}
            <span className="grow-left">{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>,
    overlayRoot(),
  );
}

const FIXED: [string, [string, string][]][] = [
  ['Mouse & trackpad', [
    ['Drag the preview', 'Look around (360 clips) or move the selected overlay'],
    ['Scroll on the preview', 'Zoom (field of view)'],
    ['Double-click the preview', 'Full screen on / off'],
    ['Right-click a clip', 'Clip menu: split, delete left/right, detach audio…'],
    ['⌘ scroll on the timeline', 'Zoom the timeline'],
    ['Click a keyframe ◆', 'Go to it; ⌫ deletes it, drag moves it, right-click for more'],
    ['Click a value', 'Type an exact number'],
    ['Double-click a slider', 'Reset to default'],
    ['Drag a tab or section', 'Move it'],
    ['⌘-drag a toolbar item', 'Move it'],
  ]],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const over = usePrefs((p) => p.shortcuts);
  const groups: [string, [string, string][]][] = [...new Set(COMMANDS.map((c) => c.group))].map((g) => [g, COMMANDS.filter((c) => c.group === g && combosOf(c.id, over).length).map((c) => [combosOf(c.id, over).map(comboLabel).join(' or '), c.label])]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts">
        <h2>Keyboard shortcuts</h2>
        <div className="shortcut-groups">
          {[...groups, ...FIXED].map(([group, rows]) => (
            <section key={group}>
              <h3>{group}</h3>
              {rows.map(([k, what]) => (
                <div key={k} className="shortcut-row">
                  <kbd>{k}</kbd>
                  <span>{what}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

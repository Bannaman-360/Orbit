// Dragging things around the interface (panels, toolbar items, sections, rows). The ghost and
// the drop marker are plain elements moved directly, so dragging never re-renders the editor.

/** Where pop-ups and ghosts go: inside the full-screen element if there is one. */
export const overlayRoot = () => document.fullscreenElement ?? document.body;

let marker: HTMLDivElement | null = null;
export function showMarker(r: { x: number; y: number; w: number; h: number } | null, kind: 'line' | 'area' = 'line') {
  if (!r) { marker?.remove(); marker = null; return; }
  if (!marker) {
    marker = document.createElement('div');
    overlayRoot().appendChild(marker);
  }
  marker.className = `drop-marker ${kind}`;
  Object.assign(marker.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

export interface DragOptions {
  /** Shown next to the pointer. */
  label: string;
  onMove: (x: number, y: number, e: PointerEvent) => void;
  onDrop: (x: number, y: number, e: PointerEvent) => void;
  onStart?: () => void;
  /** Always called at the end (drop, Escape or lost pointer). */
  onEnd?: () => void;
}

/** Starts a drag once the pointer has moved a little (so clicks still work). Escape cancels. */
export function startDrag(e: React.PointerEvent, o: DragOptions) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    ghost?.remove();
    showMarker(null);
    if (ghost) delete document.documentElement.dataset.dragging;
    o.onEnd?.();
  };
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = o.label;
      overlayRoot().appendChild(ghost);
      document.documentElement.dataset.dragging = 'on';
      o.onStart?.();
    }
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`;
    o.onMove(ev.clientX, ev.clientY, ev);
  };
  const up = (ev: PointerEvent) => {
    const was = !!ghost;
    end();
    if (!was) return;
    // The click that ends a drag must not also press the thing dragged.
    const stop = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, true), 0);
    o.onDrop(ev.clientX, ev.clientY, ev);
  };
  const cancel = () => end();
  const key = (k: KeyboardEvent) => { if (k.key === 'Escape') { k.stopPropagation(); end(); } };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}

/** The drop position among `els` (laid out along `axis`): the index, and a line to show there. */
export function insertionAt(els: HTMLElement[], x: number, y: number, axis: 'x' | 'y', box: DOMRect): { index: number; line: { x: number; y: number; w: number; h: number } } {
  const rects = els.map((e) => e.getBoundingClientRect());
  let index = rects.findIndex((r) => (axis === 'x' ? x < r.left + r.width / 2 : y < r.top + r.height / 2));
  if (index < 0) index = rects.length;
  const at = rects[index], prev = rects[index - 1];
  if (axis === 'x') {
    const px = at ? at.left - 2 : prev ? prev.right + 1 : box.left + 8;
    return { index, line: { x: px, y: box.top + 5, w: 3, h: box.height - 10 } };
  }
  const py = at ? at.top - 2 : prev ? prev.bottom : box.top + 6;
  return { index, line: { x: box.left + 6, y: Math.max(box.top, Math.min(box.bottom - 3, py)), w: box.width - 12, h: 3 } };
}
export const closestAt = (x: number, y: number, sel: string) => document.elementFromPoint(x, y)?.closest(sel) as HTMLElement | null;

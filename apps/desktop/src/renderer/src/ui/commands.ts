// Everything that can have a keyboard shortcut. The app supplies what each one does; the user
// can change the keys in Customize.

export interface Command { id: string; label: string; group: string; keys: string; locked?: boolean }
const c = (id: string, label: string, group: string, keys = '', locked = false): Command => ({ id, label, group, keys, locked });

export const COMMANDS: Command[] = [
  c('play', 'Play / pause', 'Playback', 'Space', true),
  c('shuttleBack', 'Play backward (again: faster)', 'Playback', 'J'), c('shuttleStop', 'Stop', 'Playback'), c('shuttleFwd', 'Play forward (again: faster)', 'Playback', 'L'),
  c('prevFrame', 'Previous frame', 'Playback', 'ArrowLeft'), c('nextFrame', 'Next frame', 'Playback', 'ArrowRight'),
  c('back10', 'Back 10 frames', 'Playback', 'Shift+ArrowLeft'), c('fwd10', 'Forward 10 frames', 'Playback', 'Shift+ArrowRight'),
  c('start', 'Go to start', 'Playback', 'Home'), c('end', 'Go to end', 'Playback', 'End'), c('fullscreen', 'Full-screen preview', 'Playback', 'F'), c('compare', 'Before / after (hold)', 'Playback', 'B'),
  c('split', 'Split at the playhead', 'Editing', 'S'), c('delLeft', 'Split and delete left', 'Editing', 'Q'), c('delRight', 'Split and delete right', 'Editing', 'W'),
  c('keyframe', 'Stop (while playing) / add or update keyframe', 'Editing', 'K'), c('delKey', 'Delete keyframe', 'Editing', 'Shift+K'), c('prevKey', 'Previous keyframe', 'Editing'), c('nextKey', 'Next keyframe', 'Editing'),
  c('multicam', 'New multicam clip…', 'Editing'), c('subtitles', 'Auto subtitles…', 'Editing'), c('saveSrt', 'Save subtitles as .srt…', 'Files'), c('aiModels', 'AI models on this computer…', 'Interface'), c('angle1', 'Multicam: cut to angle 1', 'Editing', '1'), c('angle2', 'Multicam: cut to angle 2', 'Editing', '2'), c('angle3', 'Multicam: cut to angle 3', 'Editing', '3'), c('angle4', 'Multicam: cut to angle 4', 'Editing', '4'),
  c('marker', 'Add marker', 'Editing', 'M'), c('delMarker', 'Delete marker at the playhead', 'Editing', 'Shift+M'), c('prevMarker', 'Previous marker', 'Playback', 'Alt+ArrowLeft'), c('nextMarker', 'Next marker', 'Playback', 'Alt+ArrowRight'), c('markersPanel', 'Show / hide Markers', 'Interface'), c('scopesPanel', 'Show / hide Scopes', 'Interface'),
  c('text', 'Add text', 'Editing', 'T'), c('titles', 'Add a motion title', 'Editing'), c('track', 'Track subject', 'Editing'), c('detach', 'Detach / reattach audio', 'Editing'), c('duplicate', 'Duplicate clip', 'Editing', 'Mod+D'), c('connect', 'Add over the main row at the playhead (track above)', 'Editing', 'E'),
  c('speedline', 'Show speed lines on the timeline', 'Editing', 'R'), c('jumps', 'Show jumps on the timeline', 'Editing'), c('snap', 'Snapping (hold ⌘ to drag freely)', 'Editing', 'N'), c('source', 'View a Media clip on its own (Source)', 'Editing'), c('markIn', 'Mark in (Source)', 'Editing', 'I'), c('markOut', 'Mark out (Source)', 'Editing', 'O'), c('insertEdit', 'Insert at the playhead', 'Editing', ','), c('overwriteEdit', 'Overwrite at the playhead', 'Editing', '.'), c('toolSelect', 'Select tool', 'Editing', 'A'), c('toolRoll', 'Roll tool', 'Editing', 'Shift+N'), c('toolSlip', 'Slip tool', 'Editing', 'Y'), c('toolSlide', 'Slide tool', 'Editing', 'U'), c('delete', 'Delete selected item', 'Editing', 'Backspace'), c('undo', 'Undo', 'Editing', 'Mod+Z'), c('redo', 'Redo', 'Editing', 'Mod+Shift+Z'),
  c('import', 'Import media', 'Files', 'Mod+I'), c('card', 'Import from memory card', 'Files', 'Mod+Shift+I'), c('music', 'Add music', 'Files'), c('projects', 'Projects', 'Files', 'Mod+Shift+P'), c('newProject', 'New project', 'Files', 'Mod+N'), c('open', 'Open project', 'Files', 'Mod+O'), c('save', 'Save project', 'Files', 'Mod+S'), c('saveAs', 'Save project as', 'Files', 'Mod+Shift+S'), c('export', 'Export video', 'Files', 'Mod+E'), c('grab', 'Frame grab', 'Files'),
  c('customize', 'Customize…', 'Interface', 'Mod+,'), c('arrange', 'Arrange interface', 'Interface', 'Mod+Shift+L'), c('undoUi', 'Undo interface change', 'Interface', 'Mod+Alt+Z'), c('toggleMedia', 'Show / hide Media', 'Interface', 'Mod+1'),
  c('toggleInspector', 'Show / hide Inspector', 'Interface', 'Mod+2'), c('toggleTimeline', 'Show / hide Timeline', 'Interface', 'Mod+3'), c('sections', 'Open / close all sections', 'Interface'), c('shortcuts', 'Keyboard shortcuts', 'Interface', '?'), c('tour', 'Show the tour', 'Interface'), c('welcome', 'Welcome screen', 'Interface'), c('report', 'Report a problem', 'Interface'), c('checkUpdates', 'Check for updates', 'Interface'),
];
const byId = new Map(COMMANDS.map((x) => [x.id, x]));

/**
 * Shortcuts are written "Mod+Shift+K": modifiers, then one or more keys held together ("K+D").
 * A command can have several, separated by a space.
 */
export const combosOf = (id: string, over: Record<string, string>): string[] => {
  const cmd = byId.get(id);
  return (cmd?.locked ? cmd.keys : over[id] ?? cmd?.keys ?? '').split(' ').filter(Boolean);
};
/** The first shortcut for a command ('' = none). */
export const comboOf = (id: string, over: Record<string, string>) => combosOf(id, over)[0] ?? '';

const mac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
const MODS = ['Mod', 'Ctrl', 'Alt', 'Shift'];
interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** A key press as its modifiers and its own key ('' for a modifier by itself). */
export function keyOf(e: KeyLike): { mods: string[]; key: string } {
  const lone = ['Shift', 'Meta', 'Control', 'Alt', 'CapsLock', 'Dead', 'Fn'].includes(e.key);
  // ⌥ changes the character typed on a Mac, so use the physical letter then.
  const phys = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1];
  let key = lone ? '' : e.altKey && phys ? phys : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (e.code === 'Space') key = 'Space';
  if (key === 'Delete') key = 'Backspace';
  if (key === '+') key = 'Plus';
  if (key === ' ') key = 'Space';
  const letter = /^[A-Z]$/.test(key), printable = key.length === 1 || key === 'Plus';
  const mods = [(mac ? e.metaKey : e.ctrlKey) && 'Mod', mac && e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && (!key || letter || !printable) && 'Shift'].filter((x): x is string => !!x);
  return { mods, key };
}
/** "Mod+Shift+Z" from a key press ('' for a lone modifier). Mod is ⌘ on Mac, Ctrl elsewhere. */
export function comboFromEvent(e: KeyLike): string {
  const { mods, key } = keyOf(e);
  return key ? [...mods, key].join('+') : '';
}
export const joinCombo = (mods: string[], keys: string[]) => [...MODS.filter((m) => mods.includes(m)), ...new Set(keys)].join('+');
const parse = (combo: string) => {
  const parts = combo.split('+').filter(Boolean);
  return { mods: parts.filter((p) => MODS.includes(p)).sort().join(), keys: parts.filter((p) => !MODS.includes(p)) };
};
const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));
/** The same keys, whatever order they were pressed in. */
export const sameCombo = (a: string, b: string) => { const x = parse(a), y = parse(b); return x.mods === y.mods && sameKeys(x.keys, y.keys); };
export function commandFor(combo: string, over: Record<string, string>): string | null {
  return combo ? COMMANDS.find((x) => combosOf(x.id, over).some((c2) => sameCombo(c2, combo)))?.id ?? null : null;
}

/** Adds a shortcut to a command, taking it from whichever command had it. */
export function addCombo(over: Record<string, string>, id: string, combo: string, replace?: string): { over: Record<string, string>; takenFrom: string | null } {
  const next = { ...over };
  const taken = commandFor(combo, over);
  if (taken && byId.get(taken)?.locked) return { over, takenFrom: taken };
  if (taken) next[taken] = combosOf(taken, over).filter((c2) => !sameCombo(c2, combo)).join(' ');
  const mine = combosOf(id, next);
  const list = replace ? mine.map((c2) => (sameCombo(c2, replace) ? combo : c2)) : [...mine, combo];
  next[id] = [...new Set(list)].join(' ');
  return { over: next, takenFrom: taken && taken !== id ? taken : null };
}
export const removeCombo = (over: Record<string, string>, id: string, combo: string) => ({ ...over, [id]: combosOf(id, over).filter((c2) => !sameCombo(c2, combo)).join(' ') });

/** How long a key that could start a combination waits for the rest of it (ms). */
export const CHORD_WAIT_MS = 260;

/**
 * Turns key presses into commands, including several keys held together. A key that is also
 * part of a combination waits a moment (or until it's released) before acting on its own; every
 * other key acts at once.
 */
export class KeyMatcher {
  private held: { key: string; t: number }[] = [];
  private pending: { cmd: string; until: number } | null = null;

  /** Keys down, then what to run now. `wait` = call flush() at that time. */
  press(e: KeyLike & { repeat?: boolean }, over: Record<string, string>, now: number): { run: string[]; known: boolean; wait?: number } {
    const { mods, key } = keyOf(e);
    if (!key) return { run: [], known: false };
    const all = COMMANDS.flatMap((c2) => combosOf(c2.id, over).map((combo) => ({ id: c2.id, ...parse(combo) })));
    const m = [...mods].sort().join();
    const find = (keys: string[]) => all.find((b) => b.mods === m && sameKeys(b.keys, keys))?.id ?? null;
    const startsMore = (keys: string[]) => all.some((b) => b.mods === m && b.keys.length > keys.length && keys.every((k) => b.keys.includes(k)));
    if (e.repeat) {
      // Holding a key repeats it (stepping frames), unless it is waiting for a combination.
      const alone = this.held.length <= 1 && !startsMore([key]) ? find([key]) : null;
      return { run: alone ? [alone] : [], known: !!find([key]) || startsMore([key]) };
    }
    // macOS doesn't report letting go of a key while ⌘ is down, so old ones are forgotten.
    const stale = mods.includes('Mod') ? 500 : 4000;
    this.held = this.held.filter((h) => h.key !== key && now - h.t < stale);
    this.held.push({ key, t: now });
    const keys = this.held.map((h) => h.key);
    let cmd = keys.length > 1 ? find(keys) : null;
    let used = keys;
    if (cmd) this.pending = null; // the combination, not its first key
    const run: string[] = [];
    if (!cmd) {
      if (keys.length > 1 && startsMore(keys)) used = keys; // still building a longer one
      else {
        if (this.pending) { run.push(this.pending.cmd); this.pending = null; }
        used = [key];
        cmd = find(used);
      }
    }
    if (startsMore(used)) {
      if (cmd) this.pending = { cmd, until: now + CHORD_WAIT_MS };
      return { run, known: true, wait: this.pending ? now + CHORD_WAIT_MS : undefined };
    }
    if (cmd) run.push(cmd);
    return { run, known: run.length > 0 };
  }
  /** A key was let go: one that was only waiting acts now. */
  release(e: KeyLike): string[] {
    const { key } = keyOf(e);
    this.held = e.key === 'Meta' || e.key === 'Control' ? [] : this.held.filter((h) => h.key !== key && h.key !== e.key.toUpperCase());
    return this.take();
  }
  flush(now: number): string[] {
    return this.pending && now >= this.pending.until - 1 ? this.take() : [];
  }
  /** Forgets everything (the window lost the keyboard). */
  reset() {
    this.held = [];
    this.pending = null;
  }
  private take(): string[] {
    const p = this.pending;
    this.pending = null;
    return p ? [p.cmd] : [];
  }
}

const SYM: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backspace: '⌫', Enter: '↩', Escape: 'esc', Tab: '⇥', Plus: '+', ...(mac ? { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' } : { Mod: 'Ctrl' }) };
/** "⌘⇧Z", "K + D", "⌘K + D". */
export function comboLabel(combo: string): string {
  if (!combo) return '';
  const parts = combo.split('+').filter(Boolean);
  const mods = parts.filter((p) => MODS.includes(p)).map((k) => SYM[k] ?? k);
  const keys = parts.filter((p) => !MODS.includes(p)).map((k) => SYM[k] ?? k);
  return (mac ? mods.join('') : mods.map((x) => `${x}+`).join('')) + keys.join(' + ');
}

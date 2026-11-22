import { describe, expect, it } from 'vitest';
import { addCombo, CHORD_WAIT_MS, comboFromEvent, comboLabel, combosOf, COMMANDS, commandFor, KeyMatcher, removeCombo, sameCombo } from './commands';

const ev = (key: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) =>
  ({ key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });

describe('shortcuts', () => {
  it('defaults are unique', () => {
    const all = COMMANDS.flatMap((c) => combosOf(c.id, {}));
    for (const a of all) expect(all.filter((b) => sameCombo(a, b)), a).toHaveLength(1);
  });
  it('acts at once on ordinary keys', () => {
    const m = new KeyMatcher();
    expect(m.press(ev('s'), {}, 0)).toMatchObject({ run: ['split'] });
    expect(m.release(ev('s'))).toEqual([]);
    expect(m.press(ev('ArrowRight', { shiftKey: true }), {}, 10)).toMatchObject({ run: ['fwd10'] });
    expect(m.press(ev('ArrowRight', { shiftKey: true, repeat: true }), {}, 50)).toMatchObject({ run: ['fwd10'] });
  });
  it('two or three keys together, in any order', () => {
    const over = { export: 'E+X', grab: 'G+H+J' };
    for (const [a, b] of [['e', 'x'], ['x', 'e']]) {
      const m = new KeyMatcher();
      expect(m.press(ev(a!), over, 0).run).toEqual([]);
      expect(m.press(ev(b!), over, 80).run).toEqual(['export']);
      m.release(ev(a!));
      expect(m.release(ev(b!))).toEqual([]);
    }
    const m = new KeyMatcher();
    m.press(ev('j'), over, 0);
    expect(m.press(ev('g'), over, 40).run).toEqual([]);
    expect(m.press(ev('h'), over, 80).run).toEqual(['grab']);
  });
  it('a key that also starts a combination still works by itself', () => {
    const over = { export: 'S+D' }; // S alone = split
    const m = new KeyMatcher();
    expect(m.press(ev('s'), over, 0)).toMatchObject({ run: [], wait: CHORD_WAIT_MS });
    expect(m.release(ev('s'))).toEqual(['split']); // tapped
    m.press(ev('s'), over, 1000);
    expect(m.flush(1000 + CHORD_WAIT_MS)).toEqual(['split']); // held
    expect(m.release(ev('s'))).toEqual([]);
    m.press(ev('s'), over, 3000);
    expect(m.press(ev('d'), over, 3100).run).toEqual(['export']); // combination, no split
    expect(m.flush(9000)).toEqual([]);
    m.release(ev('s'));
    m.release(ev('d'));
    m.press(ev('s'), over, 5000);
    expect(m.press(ev('t'), over, 5050).run).toEqual(['split', 'text']); // typed quickly one after another
  });
  it('combinations with modifiers, and ⌘ never sticking', () => {
    const mac = comboFromEvent(ev('k', { metaKey: true })) === 'Mod+K';
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const over = { export: 'Mod+K+D' };
    const m = new KeyMatcher();
    expect(m.press(ev('k', mod), over, 0).run).toEqual([]);
    expect(m.press(ev('d', mod), over, 100).run).toEqual(['export']);
    m.release(ev(mac ? 'Meta' : 'Control'));
    // Let go of K unnoticed while the modifier was down, then D much later: just D.
    m.press(ev('k', mod), over, 2000);
    expect(m.press(ev('d', mod), over, 4000).run).toEqual([]); // (waits: it could start the combination)
    expect(m.flush(4000 + CHORD_WAIT_MS)).toEqual(['duplicate']);
    m.reset();
    expect(m.press(ev('d'), over, 4100).run).toEqual([]);
  });
  it('several shortcuts for one action; taking one from another action', () => {
    let { over } = addCombo({}, 'split', 'X');
    expect(combosOf('split', over)).toEqual(['S', 'X']);
    expect(commandFor('X', over)).toBe('split');
    const r = addCombo(over, 'text', 'S');
    expect(r.takenFrom).toBe('split');
    over = r.over;
    expect(combosOf('split', over)).toEqual(['X']);
    expect(combosOf('text', over)).toEqual(['T', 'S']);
    expect(combosOf('text', addCombo(over, 'text', 'T+Y', 'T').over)).toEqual(['T+Y', 'S']);
    expect(combosOf('split', removeCombo(over, 'split', 'X'))).toEqual([]);
    expect(addCombo({}, 'split', 'Space').over).toEqual({}); // Space stays play / pause
  });
  it('reads and names keys', () => {
    expect(comboFromEvent(ev('+'))).toBe('Plus');
    expect(comboFromEvent(ev('?', { shiftKey: true }))).toBe('?');
    expect(comboFromEvent({ ...ev('ƒ', { altKey: true }), code: 'KeyF' })).toBe('Alt+F');
    expect(comboFromEvent(ev('Shift', { shiftKey: true }))).toBe('');
    expect(comboLabel('K+D')).toBe('K + D');
    expect(sameCombo('Mod+K+D', 'Mod+D+K')).toBe(true);
    expect(sameCombo('K+D', 'K')).toBe(false);
  });
});

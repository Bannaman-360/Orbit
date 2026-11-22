import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BASE, contrast, DEFAULT_THEME, sanitizeTheme, textOn, themeColors, THEMES, themeVars } from './theme';

// The store touches the page when loaded; give it a minimal stand-in.
beforeAll(() => {
  const style = { setProperty: () => {} };
  vi.stubGlobal('window', { addEventListener: () => {}, matchMedia: () => ({ matches: true, addEventListener: () => {} }) });
  vi.stubGlobal('document', { documentElement: { style, dataset: {} } });
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
});

describe('themes', () => {
  it('every built-in theme is valid and readable in light and dark', () => {
    for (const [name, t] of THEMES) {
      expect(sanitizeTheme(JSON.parse(JSON.stringify(t))), name).toEqual(t);
      for (const m of t.mode === 'auto' ? (['light', 'dark'] as const) : [t.mode]) {
        const c = themeColors(t, m);
        for (const bg of ['panel', 'group', 'field', 'toolbar', 'timeline'] as const) expect(contrast(c.text, c[bg]), `${name} ${m} text on ${bg}`).toBeGreaterThan(7);
        expect(contrast(c.muted, c.group), `${name} ${m} muted`).toBeGreaterThan(3.6);
        expect(contrast(textOn(t.accent), t.accent), `${name} accent`).toBeGreaterThan(2.6);
        expect(contrast(c.text, c.control), `${name} ${m} button`).toBeGreaterThan(4.5);
      }
    }
  });
  it('repairs broken themes', () => {
    const t = sanitizeTheme({ gap: 9999, radius: 'x', accent: 'javascript:1', buttons: 'nope', translucent: 'yes', colors: { dark: { text: '#fff', panel: '#123456', bogus: '#000000' } } });
    expect(t.gap).toBe(24);
    expect(t.radius).toBe(DEFAULT_THEME.radius);
    expect(t.accent).toBe(DEFAULT_THEME.accent);
    expect(t.buttons).toBe('mac');
    expect(t.colors.dark).toEqual({ panel: '#123456' });
    expect(sanitizeTheme(null)).toEqual(DEFAULT_THEME);
  });
  it('covers every colour in both modes', () => {
    expect(Object.keys(BASE.light)).toEqual(Object.keys(BASE.dark));
    const { vars } = themeVars(DEFAULT_THEME, 'dark', true);
    expect(vars['--clip-360']).toBe(BASE.dark.clip360);
    expect(vars['--panel-bg']).toContain('/ 0.86');
    expect(themeVars(DEFAULT_THEME, 'dark', false).vars['--panel-bg']).toBe(BASE.dark.panel);
  });
});

describe('preferences', () => {
  it('moves sections between panels without losing or doubling any', async () => {
    const P = await import('./prefs');
    const count = () => ['reframe', 'stabilize', 'color', 'effects', 'clip'].flatMap((l) => P.sectionList(P.getPrefs(), l));
    const before = [...count()].sort();
    P.moveSection('Lens', 'reframe', 'color', 1);
    expect(P.sectionList(P.getPrefs(), 'color')[1]).toBe('Lens');
    expect(P.sectionList(P.getPrefs(), 'reframe')).not.toContain('Lens');
    P.moveSection('Light', 'color', 'color', 0);
    P.moveSection('Speed', 'clip', 'effects', 99);
    expect([...count()].sort()).toEqual(before);
    P.moveSection('Lens', 'color', 'reframe', 0);
    expect(P.sectionList(P.getPrefs(), 'reframe')[0]).toBe('Lens');
    expect([...count()].sort()).toEqual(before);
    P.undoPrefs();
    expect(P.sectionList(P.getPrefs(), 'color')).toContain('Lens');
  });
  it('moves toolbar items between bars, keeping each once', async () => {
    const P = await import('./prefs');
    const items = () => Object.values(P.getPrefs().bars).flatMap((b) => b.items).filter((i) => !P.isSpacer(i)).sort();
    const before = items();
    P.placeItem('export', { bar: 'main', index: P.getPrefs().bars.main.items.indexOf('export') }, { bar: 'timeline', index: 0 });
    expect(P.getPrefs().bars.timeline.items[0]).toBe('export');
    expect(items()).toEqual(before);
    P.placeItem('export', null, { bar: 'main', index: 2 }); // from the palette: moves, not doubles
    expect(items()).toEqual(before);
    P.placeItem('export', { bar: 'main', index: 2 }, null);
    expect(items()).not.toContain('export');
  });
  it('offers new toolbar items once to toolbars saved before they existed', async () => {
    const P = await import('./prefs');
    const old = { ...P.defaultPrefs().bars, transport: { items: ['play', 'quality'], position: 'bottom', hidden: false } };
    const first = P.sanitizePrefs({ bars: old });
    expect(first.bars.transport.items).toEqual(['play', 'compare', 'quality']);
    // Removed by the user afterwards: stays removed.
    const removed = { ...first, bars: { ...first.bars, transport: { ...first.bars.transport, items: ['play', 'quality'] } } };
    expect(P.sanitizePrefs(JSON.parse(JSON.stringify(removed))).bars.transport.items).toEqual(['play', 'quality']);
  });
  it('survives nonsense in storage', async () => {
    const P = await import('./prefs');
    for (const junk of [null, 5, [], { layout: { root: 3 }, bars: { main: { items: [1, 'export', 'export', 'flex', 'flex'] } }, sections: 'x', customPanels: [{ id: 'evil' }, { id: 'custom:1', title: 'Mine' }] }]) {
      const s = P.sanitizePrefs(junk);
      expect(s.layout.root).toBeTruthy();
      expect(s.bars.main.items.filter((i) => i === 'export').length).toBe(1);
    }
    expect(P.sanitizePrefs({ customPanels: [{ id: 'custom:1', title: 'Mine' }] }).customPanels).toEqual([{ id: 'custom:1', title: 'Mine' }]);
  });
});

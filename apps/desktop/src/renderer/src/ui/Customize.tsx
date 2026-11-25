// The Customize window: how the app looks, how it's laid out, what's in its toolbars, and its
// keyboard shortcuts. Floats over the editor so every change shows straight away.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ace } from '../api';
import { Lock, Range, Seg, Slider } from '../ui';
import { addCombo, comboLabel, combosOf, COMMANDS, joinCombo, keyOf, removeCombo } from './commands';
import { activate, closePanel, dockAtEdge, dockPanel, floatPanel, groupsOf, groupWith, isFloating, openPanels, type DockLayout } from './dockModel';
import { Icon } from './Icon';
import {
  BAR_NAMES, BUILTIN_THEMES, canUndoPrefs, currentMode, DEFAULT_BARS, defaultPrefs, getPrefs, isInspectorPanel, isSpacer, LAYOUTS, LEVELS, moveSection, setLevel, PANELS, placeItem, sanitizePrefs,
  sectionList, setArranging, setBar, setPrefs, setTheme, toggleSectionHidden, undoPrefs, usePrefs, type BarId,
} from './prefs';
import { ACCENTS, COLOR_GROUPS, contrast, DEFAULT_THEME, FONTS, RANGES, sanitizeTheme, themeColors, type ColorKey, type Mode, type Theme } from './theme';
import type { ToolItem } from './Bars';

const PAGES = [
  ['themes', 'Themes', 'themes'], ['colors', 'Colors', 'palette'], ['controls', 'Sliders & buttons', 'slider'], ['shape', 'Panels & shapes', 'workspaces'], ['text', 'Text & icons', 'text'], ['timeline', 'Timeline', 'timeline'],
  ['layout', 'Layout', 'viewer'], ['toolbars', 'Toolbars', 'toolbar'], ['sections', 'Sections', 'sections'], ['shortcuts', 'Shortcuts', 'keyboard'],
] as const;
export type CustomizePage = (typeof PAGES)[number][0];

function Group({ title, children, note }: { title?: string; children: ReactNode; note?: string }) {
  return (
    <div className="cz-group">
      {title && <h4>{title}</h4>}
      <div className="cz-card">{children}</div>
      {note && <p className="cz-note">{note}</p>}
    </div>
  );
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="cz-row"><span>{label}</span>{children}</div>;
const Check = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
  <label className="cz-row"><span>{label}</span><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /></label>
);

type NumKey = keyof typeof RANGES;
function Num({ k, label, step = 1, unit = '', scale = 1, locked }: { k: NumKey; label: string; step?: number; unit?: string; scale?: number; locked?: string | false }) {
  const v = usePrefs((p) => p.theme[k]);
  const [min, max] = RANGES[k];
  return (
    <Slider label={label} locked={locked} value={v} min={min} max={max} step={step} reset={DEFAULT_THEME[k]} units={{ to: (x) => x * scale, from: (x) => x / scale, digits: scale > 1 ? 0 : step < 1 ? 2 : 0 }}
      format={(x) => `${scale > 1 ? Math.round(x * scale) : +x.toFixed(2)}${unit}`} onChange={(x) => setTheme({ [k]: x })} />
  );
}
function Pick<K extends keyof Theme>({ k, options }: { k: K; options: [Theme[K] & string, string][] }) {
  const v = usePrefs((p) => p.theme[k]) as Theme[K] & string;
  return <Seg value={v} options={options} onChange={(x) => setTheme({ [k]: x } as Partial<Theme>)} />;
}
/** Choices shown as small live samples. */
function Samples<K extends 'sliders' | 'buttons'>({ k, options }: { k: K; options: [Theme[K], string][] }) {
  const v = usePrefs((p) => p.theme[k]);
  return (
    <div className="cz-samples">
      {options.map(([o, label]) => (
        <button key={o} className={`cz-sample${v === o ? ' on' : ''}`} onClick={() => setTheme({ [k]: o } as Partial<Theme>)}>
          <span className="cz-sample-demo" {...{ [`data-${k}`]: o }} data-sample inert>
            {k === 'sliders' ? <Range value={0.6} min={0} max={1} step={0.01} onChange={() => {}} /> : <><span className="btn">Button</span><span className="btn on">On</span></>}
          </span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function ColorWell({ value, changed, onChange, onReset, label }: { value: string; changed?: boolean; onChange: (v: string) => void; onReset?: () => void; label: string }) {
  return (
    <div className="cz-color">
      <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      <span>{label}</span>
      <input className="cz-hex" aria-label={`${label} hex`} key={value} defaultValue={value} spellCheck={false} onBlur={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) ? onChange(e.target.value.toLowerCase()) : (e.target.value = value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }} />
      <button className="ghost" disabled={!changed} title="Back to the default colour" onClick={onReset}><Icon name="undo" size={13} /></button>
    </div>
  );
}

const exportJson = async (name: string, data: unknown) => {
  const path = await ace.saveDialog('theme', name);
  if (path) await ace.writeFile(path, JSON.stringify(data, null, 2));
};

function ThemesPage() {
  const theme = usePrefs((p) => p.theme);
  const mine = usePrefs((p) => p.themes);
  const [name, setName] = useState('');
  const same = (t: Theme) => JSON.stringify(t) === JSON.stringify(theme);
  const Card = ({ n, t, own }: { n: string; t: Theme; own?: boolean }) => {
    const m: Mode = t.mode === 'auto' ? currentMode() : t.mode;
    const c = themeColors(t, m);
    return (
      <div className={`cz-theme${same(t) ? ' on' : ''}`}>
        <button onClick={() => setPrefs({ theme: t })} title={`Use ${n}`}>
          <span className="cz-mini" style={{ background: c.window, borderRadius: Math.min(10, t.radius + 2), padding: Math.min(5, t.gap), gap: Math.min(4, t.gap || 1) }}>
            <i style={{ background: c.panel, borderRadius: t.radius / 3 }} />
            <i style={{ background: c.viewer, borderRadius: t.radius / 3, gridRow: '1', gridColumn: '2' }}><b style={{ background: t.accent, borderRadius: t.controlRadius / 2 }} /></i>
            <i style={{ background: c.panel, borderRadius: t.radius / 3 }}><em style={{ background: c.track }} /><em style={{ background: t.accent, width: '45%' }} /></i>
            <i className="wide" style={{ background: c.timeline, borderRadius: t.radius / 3 }}><u style={{ background: c.clip360, borderRadius: t.clipRadius / 4 }} /><u style={{ background: c.audio, borderRadius: t.clipRadius / 4, width: '45%' }} /></i>
          </span>
          <span>{n}</span>
        </button>
        {own && <button className="ghost cz-x" title="Delete this theme" onClick={() => setPrefs((p) => { const { [n]: _gone, ...rest } = p.themes; return { themes: rest }; })}><Icon name="close" size={12} /></button>}
      </div>
    );
  };
  return (
    <>
      <Group title="Appearance"><Pick k="mode" options={[['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']]} /></Group>
      <Group title="Accent color">
        <div className="cz-accents">
          {ACCENTS.map(([n, c]) => <button key={n} title={n} className={theme.accent === c ? 'on' : ''} style={{ background: c }} onClick={() => setTheme({ accent: c })} />)}
          <input type="color" title="Any color" value={theme.accent} onChange={(e) => setTheme({ accent: e.target.value })} />
        </div>
      </Group>
      <Group title="Themes"><div className="cz-themes">{BUILTIN_THEMES.map(([n, t]) => <Card key={n} n={n} t={t} />)}</div></Group>
      <Group title="Your themes" note="Saves every colour, shape, control style and font. Share a theme by exporting it as a file.">
        {Object.keys(mine).length > 0 && <div className="cz-themes">{Object.entries(mine).map(([n, t]) => <Card key={n} n={n} t={t} own />)}</div>}
        <div className="cz-row">
          <input placeholder="Name this theme" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button disabled={!name.trim()} onClick={() => { setPrefs((p) => ({ themes: { ...p.themes, [name.trim().slice(0, 40)]: p.theme } })); setName(''); }}>Save current look</button>
        </div>
        <div className="cz-row">
          <button onClick={() => void exportJson('My theme.acetheme', { theme: getPrefs().theme })}>Export theme…</button>
          <button onClick={async () => { const t = await ace.openThemeDialog(); if (!t) return; try { const o = JSON.parse(t) as { theme?: unknown }; if (o.theme) setPrefs({ theme: sanitizeTheme(o.theme) }); } catch { /* not a theme file */ } }}>Import theme…</button>
        </div>
      </Group>
    </>
  );
}

function ColorsPage() {
  const theme = usePrefs((p) => p.theme);
  const [mode, setMode] = useState<Mode>(currentMode());
  const c = themeColors(theme, mode), own = theme.colors[mode];
  const set = (k: ColorKey, v: string | undefined) => {
    const next = { ...own };
    if (v === undefined) delete next[k]; else next[k] = v;
    setTheme({ colors: { ...theme.colors, [mode]: next } }, `color:${mode}:${k}`);
  };
  const low = contrast(c.text, c.group) < 4.5 || contrast(c.text, c.panel) < 4.5;
  return (
    <>
      <Group><Row label="Colors for"><Seg value={mode} options={[['light', 'Light mode'], ['dark', 'Dark mode']]} onChange={(m) => { setMode(m); if (theme.mode !== 'auto') setTheme({ mode: m }); }} /></Row></Group>
      {low && <p className="cz-warn">Text is hard to read on these panel colors.</p>}
      <Group title="Accent"><ColorWell label="Accent" value={theme.accent} changed={theme.accent !== DEFAULT_THEME.accent} onChange={(v) => setTheme({ accent: v })} onReset={() => setTheme({ accent: DEFAULT_THEME.accent })} /></Group>
      {COLOR_GROUPS.map(([g, list]) => (
        <Group key={g} title={g}>{list.map(([k, label]) => <ColorWell key={k} label={label} value={c[k]} changed={k in own} onChange={(v) => set(k, v)} onReset={() => set(k, undefined)} />)}</Group>
      ))}
      <Group title="See-through window" note="Lets your desktop's colors glow through, like Finder's sidebar (Mac).">
        <Check label="Translucent window" value={theme.translucent} onChange={(v) => setTheme({ translucent: v })} />
        <Num k="panelOpacity" label="Panel solidity" step={0.01} unit="%" scale={100} locked={!theme.translucent && 'Panels are always solid unless the window is translucent. Turn on “Translucent window” first.'} />
      </Group>
      <div className="cz-row end"><button onClick={() => setTheme({ colors: { ...theme.colors, [mode]: {} } })}>Reset all {mode} colors</button></div>
    </>
  );
}

const ControlsPage = () => (
  <>
    <Group title="Slider style"><Samples k="sliders" options={[['mac', 'Mac'], ['glass', 'Glass'], ['ios', 'Chunky'], ['thin', 'Thin'], ['bar', 'Filled bar'], ['classic', 'Classic']]} /><Num k="sliderHeight" label="Track height" unit=" px" /><Num k="knobSize" label="Knob size" unit=" px" /></Group>
    <Group title="Button style"><Samples k="buttons" options={[['mac', 'Mac'], ['glass', 'Glass'], ['soft', 'Soft'], ['flat', 'Flat'], ['outline', 'Outline'], ['raised', 'Raised']]} /><Num k="controlRadius" label="Roundness" unit=" px" /></Group>
    <Group title="Choices & switches">
      <Row label="Choice buttons"><Pick k="segments" options={[['mac', 'Segmented'], ['buttons', 'Buttons'], ['underline', 'Underline']]} /></Row>
      <Row label="On/off controls"><Pick k="toggles" options={[['switch', 'Switches'], ['checkbox', 'Checkboxes']]} /></Row>
    </Group>
    <Group title="Feel"><Num k="animations" label="Animation" step={0.1} unit="×" /><Row label="Scroll bars"><Pick k="scrollbars" options={[['thin', 'Thin'], ['normal', 'Normal'], ['hidden', 'Hidden']]} /></Row></Group>
  </>
);
const ShapePage = () => (
  <>
    <Group title="Panels">
      <Row label="Style"><Pick k="panelStyle" options={[['cards', 'Floating cards'], ['flush', 'Edge to edge']]} /></Row>
      <Num k="gap" label="Gap" unit=" px" /><Num k="radius" label="Corner radius" unit=" px" /><Num k="border" label="Border" step={0.5} unit=" px" /><Num k="shadow" label="Shadow" step={0.01} unit="%" scale={100} /><Num k="density" label="Spacing" step={0.01} unit="%" scale={100} />
    </Group>
    <Group title="Tabs & title bars">
      <Row label="Tabs"><Pick k="tabs" options={[['segmented', 'Segmented'], ['pills', 'Pills'], ['underline', 'Underline'], ['browser', 'Browser']]} /></Row>
      <Row label="Title bars"><Pick k="panelBars" options={[['auto', 'When needed'], ['always', 'Always']]} /></Row>
    </Group>
    <Group title="Sections"><Row label="Style"><Pick k="sections" options={[['cards', 'Cards'], ['lines', 'Lines'], ['plain', 'Plain']]} /></Row></Group>
  </>
);
function TextPage() {
  const font = usePrefs((p) => p.theme.font), bold = usePrefs((p) => p.theme.bold), hints = usePrefs((p) => p.theme.hints);
  return (
    <>
      <Group title="Text">
        <Row label="Font"><select value={font} onChange={(e) => setTheme({ font: e.target.value as Theme['font'] })}>{Object.entries(FONTS).map(([k, [n, f]]) => <option key={k} value={k} style={{ fontFamily: f }}>{n}</option>)}</select></Row>
        <Num k="fontSize" label="Text size" step={0.5} unit=" px" />
        <Check label="Bold titles" value={bold} onChange={(v) => setTheme({ bold: v })} />
        <Row label="Section titles"><Pick k="headings" options={[['title', 'Normal'], ['caps', 'CAPITALS']]} /></Row>
        <Check label="Show help notes under controls" value={hints} onChange={(v) => setTheme({ hints: v })} />
      </Group>
      <Group title="Icons">
        <Num k="iconSize" label="Size" unit=" px" /><Num k="iconWeight" label="Line weight" step={0.1} />
        <Row label="Color"><Pick k="iconColor" options={[['text', 'Plain'], ['accent', 'Accent'], ['colorful', 'Colorful']]} /></Row>
      </Group>
    </>
  );
}
function TimelinePage() {
  const thumbs = usePrefs((p) => p.theme.clipThumbs), names = usePrefs((p) => p.theme.clipNames);
  return (
    <>
      <Group title="Clips">
        <Num k="trackHeight" label="Clip height" unit=" px" /><Num k="clipRadius" label="Corner radius" unit=" px" />
        <Check label="Pictures on clips" value={thumbs} onChange={(v) => setTheme({ clipThumbs: v })} /><Check label="Names on clips" value={names} onChange={(v) => setTheme({ clipNames: v })} />
      </Group>
      <Group title="Playhead" note="Clip, playhead and ruler colors are under Colors."><Num k="playheadWidth" label="Width" step={0.5} unit=" px" /></Group>
    </>
  );
}

const panelTitles = (p: { customPanels: { id: string; title: string }[] }): [string, string][] => [...Object.entries(PANELS), ...p.customPanels.map((c): [string, string] => [c.id, c.title])];

/** Opens a panel near its relatives (other editing panels, or else the right side). */
export function reopenPanel(l: DockLayout, id: string): DockLayout {
  if (openPanels(l).includes(id)) return activate(l, id);
  if (id === 'timeline') return dockAtEdge(l, id, 'bottom', 0.34);
  if (id === 'media') return dockAtEdge(l, id, 'left', 0.18);
  if (id === 'viewer') return dockAtEdge(l, id, 'top', 0.6);
  const mate = groupsOf(l).find((g) => g.panels.some((x) => isInspectorPanel(x) || x === 'selection'));
  return mate ? dockPanel(l, id, mate.id, 'center') : dockAtEdge(l, id, 'right', 0.26);
}

function LayoutPage() {
  const layout = usePrefs((p) => p.layout), custom = usePrefs((p) => p.customPanels), spaces = usePrefs((p) => p.workspaces);
  const level = usePrefs((p) => p.level);
  const [name, setName] = useState('');
  const set = (f: (l: DockLayout) => DockLayout) => setPrefs((p) => ({ layout: f(p.layout) }));
  return (
    <>
      <Group title="Experience level" note="Sets the panels, toolbars and sections to match. Anything hidden can be shown again below or in Sections.">
        <div className="cz-chips">{LEVELS.map((l) => <button key={l.id} className={level === l.id ? 'on' : ''} title={l.note} onClick={() => setLevel(l.id)}>{l.name}</button>)}</div>
        {level && <p className="hint">{LEVELS.find((l) => l.id === level)!.note}</p>}
      </Group>
      <Group title="Ready-made layouts" note="Drag any panel's tab (or the small handle at the top of the preview and timeline) to move it. Hold ⌥ while dropping to float it.">
        <div className="cz-chips">{LAYOUTS.map(([n, f]) => <button key={n} onClick={() => setPrefs({ layout: f() })}>{n}</button>)}</div>
      </Group>
      <Group title="Your workspaces" note="A workspace remembers the panel layout and toolbars.">
        {Object.entries(spaces).map(([n, w]) => (
          <Row key={n} label={n}><span className="cz-btns"><button onClick={() => setPrefs({ layout: w.layout, bars: w.bars })}>Use</button><button className="ghost" title="Delete" onClick={() => setPrefs((p) => { const { [n]: _gone, ...rest } = p.workspaces; return { workspaces: rest }; })}><Icon name="trash" size={15} /></button></span></Row>
        ))}
        <div className="cz-row"><input placeholder="Name this workspace" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /><button disabled={!name.trim()} onClick={() => { setPrefs((p) => ({ workspaces: { ...p.workspaces, [name.trim().slice(0, 40)]: { layout: p.layout, bars: p.bars } } })); setName(''); }}>Save</button></div>
      </Group>
      <Group title="Panels">
        {panelTitles({ customPanels: custom }).map(([id, title]) => {
          const g = groupWith(layout, id), open = !!g, floating = isFloating(layout, id);
          return (
            <div className="cz-row" key={id}>
              {id.startsWith('custom:') ? <input aria-label="Panel name" defaultValue={title} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => setPrefs((p) => ({ customPanels: p.customPanels.map((c) => (c.id === id ? { ...c, title: e.target.value.trim().slice(0, 40) || c.title } : c)) }))} /> : <span>{title}</span>}
              <span className="cz-btns">
                {open && <button onClick={() => set((l) => (floating ? reopenPanel(closePanel(l, id), id) : floatPanel(l, id, { x: 80, y: 60, w: 360, h: 460 })))}>{floating ? 'Dock' : 'Float'}</button>}
                {id.startsWith('custom:') && <button className="ghost" title="Delete this panel (its sections go back where they came from)" onClick={() => setPrefs((p) => { const { [id]: _s, ...sections } = p.sections; return { layout: closePanel(p.layout, id), customPanels: p.customPanels.filter((c) => c.id !== id), sections }; })}><Icon name="trash" size={15} /></button>}
                <input type="checkbox" aria-label={`Show ${title}`} checked={open} onChange={(e) => set((l) => (e.target.checked ? reopenPanel(l, id) : closePanel(l, id)))} />
              </span>
            </div>
          );
        })}
        <div className="cz-row"><span className="muted">Make your own panel, then drag sections into it.</span><button onClick={() => setPrefs((p) => { const id = `custom:${Date.now().toString(36)}`; return { customPanels: [...p.customPanels, { id, title: `My panel ${p.customPanels.length + 1}` }], sections: { ...p.sections, [id]: [] }, layout: reopenPanel(p.layout, id) }; })}><Icon name="plus" size={14} /> New panel</button></div>
      </Group>
    </>
  );
}

function ToolbarsPage({ items }: { items: Record<string, ToolItem> }) {
  const bars = usePrefs((p) => p.bars), labels = usePrefs((p) => p.theme.toolbarLabels);
  const where = (k: string) => (Object.keys(bars) as BarId[]).find((b) => bars[b].items.includes(k)) ?? 'none';
  return (
    <>
      <Group title="Show"><Seg value={labels} options={[['both', 'Icon and text'], ['beside', 'Text beside'], ['icon', 'Icon only'], ['text', 'Text only']]} onChange={(v) => setTheme({ toolbarLabels: v })} /></Group>
      <Group note="Opens arrange mode: drag items between toolbars, in from the palette, or out to remove them. You can also ⌘-drag any item at any time."><div className="cz-row"><span>Drag items around</span><button className="primary" onClick={() => setArranging(true)}>Arrange…</button></div></Group>
      {(Object.keys(bars) as BarId[]).map((b) => (
        <Group key={b} title={BAR_NAMES[b]}>
          <Row label="Position"><Seg value={bars[b].position} options={[['top', 'Top'], ['bottom', 'Bottom']]} onChange={(v) => setBar(b, { position: v })} /></Row>
          <Check label="Show" value={!bars[b].hidden} onChange={(v) => setBar(b, { hidden: !v })} />
          <div className="cz-row end"><button onClick={() => setPrefs((p) => {
            const mine = DEFAULT_BARS[b].items.filter((i) => !isSpacer(i));
            const next = structuredClone(p.bars);
            for (const o of Object.keys(next) as BarId[]) if (o !== b) next[o].items = next[o].items.filter((i) => isSpacer(i) || !mine.includes(i));
            next[b] = structuredClone(DEFAULT_BARS[b]);
            return { bars: next };
          })}>Default set</button></div>
        </Group>
      ))}
      <Group title="Items">
        {Object.entries(items).map(([k, it]) => (
          <Row key={k} label={it.label}>
            <select value={where(k)} onChange={(e) => { const to = e.target.value as BarId | 'none'; if (to === 'none') { const b = where(k) as BarId; placeItem(k, { bar: b, index: bars[b].items.indexOf(k) }, null); } else placeItem(k, null, { bar: to, index: bars[to].items.length }); }}>
              <option value="none">Not shown</option>
              {(Object.keys(bars) as BarId[]).map((b) => <option key={b} value={b}>{BAR_NAMES[b]}</option>)}
            </select>
          </Row>
        ))}
      </Group>
    </>
  );
}

function SectionsPage() {
  const all = usePrefs((p) => p);
  const targets = panelTitles(all).filter(([id]) => isInspectorPanel(id));
  return (
    <>
      <Group note="Choose which panel each section lives in, or hide it. You can also just drag sections by their titles. In arrange mode you can reorder and hide single controls."><div className="cz-row"><span>Reorder and hide single controls</span><button className="primary" onClick={() => setArranging(true)}>Arrange…</button></div></Group>
      {targets.map(([id, title]) => {
        const ids = sectionList(all, id);
        return (
          <Group key={id} title={title}>
            {!ids.length && <p className="cz-note">Empty. Move sections here with the menus below.</p>}
            {ids.map((s, i) => (
              <div className="cz-row" key={s}>
                <span>{s}</span>
                <span className="cz-btns">
                  <button className="ghost" disabled={!i} title="Move up" onClick={() => moveSection(s, id, id, i - 1)}><Icon name="chevron" size={14} className="flip" /></button>
                  <button className="ghost" disabled={i === ids.length - 1} title="Move down" onClick={() => moveSection(s, id, id, i + 1)}><Icon name="chevron" size={14} /></button>
                  <select value={id} aria-label={`Panel for ${s}`} onChange={(e) => moveSection(s, id, e.target.value, 999)}>{targets.map(([t, n]) => <option key={t} value={t}>{n}</option>)}</select>
                  <input type="checkbox" aria-label={`Show ${s}`} checked={!all.hiddenSections.includes(s)} onChange={() => toggleSectionHidden(s)} />
                </span>
              </div>
            ))}
          </Group>
        );
      })}
      <div className="cz-row end"><button onClick={() => setPrefs((p) => ({ sections: Object.fromEntries(p.customPanels.map((c) => [c.id, []])), hiddenSections: [], rows: {}, hiddenRows: {} }))}>Put every section and control back</button></div>
    </>
  );
}

function ShortcutsPage() {
  const over = usePrefs((p) => p.shortcuts);
  /** The command being recorded, and which of its shortcuts is being replaced (none = adding one). */
  const [rec, setRec] = useState<{ id: string; replace?: string } | null>(null);
  const [held, setHeld] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!rec) return;
    let mods: string[] = [], down: string[] = [], timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      setRec(null);
      setHeld('');
      const combo = joinCombo(mods, down);
      if (!down.length) return;
      if (down.includes('Space') || combo === 'Tab') { setMsg(`${comboLabel(combo)} can’t be used (Space always plays and pauses).`); return; }
      const r = addCombo(getPrefs().shortcuts, rec.id, combo, rec.replace);
      setPrefs({ shortcuts: r.over });
      setMsg(r.takenFrom ? `${comboLabel(combo)} was taken from “${COMMANDS.find((c) => c.id === r.takenFrom)!.label}”.` : null);
    };
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape' && !down.length) { clearTimeout(timer); setRec(null); setHeld(''); return; }
      if (e.repeat) return;
      const k = keyOf(e);
      // Collect everything held together; ⇧ only counts where it isn't part of the character.
      mods = down.length && k.key ? [...new Set([...mods, ...k.mods])] : k.mods;
      if (k.key && !down.includes(k.key) && down.length < 4) down.push(k.key);
      setHeld(joinCombo(mods, down) || mods.join('+'));
      // (macOS hides key releases while ⌘ is down.)
      clearTimeout(timer);
      if (down.length) timer = setTimeout(finish, 1400);
    };
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (down.length) finish();
      else { mods = keyOf(e).mods; setHeld(mods.join('+')); }
    };
    const cancel = () => { clearTimeout(timer); setRec(null); setHeld(''); };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', cancel);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', cancel);
    };
  }, [rec]);
  const start = (id: string, replace?: string) => { setMsg(null); setHeld(''); setRec({ id, replace }); };
  const live = held ? `${comboLabel(held) || '…'}` : 'Press keys…';
  return (
    <>
      <p className="cz-note">Click a shortcut to change it, or + to add another for the same action. Hold several keys at once to record a combination (K + D, ⌘K + D, ⇧⌥X…), then let go. Esc cancels.</p>
      {msg && <p className="cz-warn">{msg}</p>}
      {[...new Set(COMMANDS.map((c) => c.group))].map((g) => (
        <Group key={g} title={g}>
          {COMMANDS.filter((c) => c.group === g).map((c) => {
            const combos = combosOf(c.id, over);
            const recording = rec?.id === c.id;
            return (
              <Row key={c.id} label={c.label}>
                <span className="cz-btns cz-combos">
                  {c.id in over && <button className="ghost" title="Back to default" onClick={() => setPrefs((p) => { const { [c.id]: _gone, ...rest } = p.shortcuts; return { shortcuts: rest }; })}><Icon name="undo" size={14} /></button>}
                  {combos.map((k) => {
                    const on = recording && rec?.replace === k;
                    return (
                      <span key={k} className={`cz-combo${on ? ' on' : ''}`}>
                        {c.locked && <Lock reason="Space always plays and pauses, whatever is selected, so it can’t be changed." />}
                        <button className="cz-key" disabled={c.locked} title={c.locked ? 'Space always plays and pauses' : 'Click, then hold the new keys'} onClick={() => start(c.id, k)}>{on ? live : comboLabel(k)}</button>
                        {!c.locked && !on && <button className="cz-combo-x" title={`Remove ${comboLabel(k)}`} aria-label={`Remove ${comboLabel(k)}`} onClick={() => setPrefs((p) => ({ shortcuts: removeCombo(p.shortcuts, c.id, k) }))}><Icon name="close" size={10} /></button>}
                      </span>
                    );
                  })}
                  {recording && !rec?.replace && <span className="cz-combo on"><button className="cz-key">{live}</button></span>}
                  {!c.locked && !(recording && !rec?.replace) && <button className="ghost cz-add" title="Add a shortcut" aria-label={`Add a shortcut for ${c.label}`} onClick={() => start(c.id)}><Icon name="plus" size={14} /></button>}
                </span>
              </Row>
            );
          })}
        </Group>
      ))}
      <div className="cz-row end"><button onClick={() => setPrefs({ shortcuts: {} })}>Reset all shortcuts</button></div>
    </>
  );
}

export function Customize({ page, onPage, onClose, items }: { page: CustomizePage; onPage: (p: CustomizePage) => void; onClose: () => void; items: Record<string, ToolItem> }) {
  usePrefs((p) => p); // the Undo button follows every change
  const [pos, setPos] = useState(() => ({ x: Math.max(20, (window.innerWidth - 760) / 2), y: Math.max(20, (window.innerHeight - 620) / 2) }));
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo(0, 0); }, [page]);
  const move = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select')) return;
    const x0 = e.clientX - pos.x, y0 = e.clientY - pos.y, el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => setPos({ x: Math.max(-560, Math.min(window.innerWidth - 120, ev.clientX - x0)), y: Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - y0)) });
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className="cz" style={{ left: pos.x, top: pos.y }} role="dialog" aria-label="Customize">
      <nav className="cz-side" onPointerDown={move}>
        <button className="cz-close" title="Close" aria-label="Close" onClick={onClose} />
        {PAGES.map(([id, label, icon]) => <button key={id} className={`cz-nav${page === id ? ' on' : ''}`} onClick={() => onPage(id)}><Icon name={icon} size={16} /><span>{label}</span></button>)}
        <span className="dock-grow" />
        <button className="cz-nav" disabled={!canUndoPrefs()} onClick={undoPrefs}><Icon name="undo" size={16} /><span>Undo change</span></button>
      </nav>
      <div className="cz-main">
        <header onPointerDown={move}><h2>{PAGES.find(([id]) => id === page)![1]}</h2></header>
        <div className="cz-body" ref={body}>
          {page === 'themes' ? <ThemesPage /> : page === 'colors' ? <ColorsPage /> : page === 'controls' ? <ControlsPage /> : page === 'shape' ? <ShapePage /> : page === 'text' ? <TextPage /> : page === 'timeline' ? <TimelinePage />
            : page === 'layout' ? <LayoutPage /> : page === 'toolbars' ? <ToolbarsPage items={items} /> : page === 'sections' ? <SectionsPage /> : <ShortcutsPage />}
          {page === 'themes' && (
            <Group title="Everything" note="Includes the theme, layout, toolbars, sections and shortcuts.">
              <div className="cz-row">
                <button onClick={() => void exportJson('My interface.acetheme', getPrefs())}>Export everything…</button>
                <button onClick={async () => { const t = await ace.openThemeDialog(); if (!t) return; try { setPrefs(sanitizePrefs(JSON.parse(t))); } catch { /* not a settings file */ } }}>Import everything…</button>
                <button className="danger" onClick={() => setPrefs((p) => ({ ...defaultPrefs(), themes: p.themes, workspaces: p.workspaces }))}>Reset everything</button>
              </div>
            </Group>
          )}
        </div>
      </div>
    </div>
  );
}

/** The palette shown while arranging: everything that can be dragged in. */
export function ArrangeBar({ items, onDone, onCustomize, drag }: { items: Record<string, ToolItem>; onDone: () => void; onCustomize: () => void; drag: (e: React.PointerEvent, id: string, label: string) => void }) {
  const bars = usePrefs((p) => p.bars), layout = usePrefs((p) => p.layout), custom = usePrefs((p) => p.customPanels);
  const used = new Set(Object.values(bars).flatMap((b) => b.items));
  const spare = Object.entries(items).filter(([k]) => !used.has(k));
  const closed = panelTitles({ customPanels: custom }).filter(([id]) => !openPanels(layout).includes(id));
  const hiddenBars = (Object.keys(bars) as BarId[]).filter((b) => bars[b].hidden);
  return (
    <div className="arrange" role="dialog" aria-label="Arrange interface">
      <div className="arrange-head">
        <b>Arrange</b>
        <span className="muted">Drag toolbar items, panels, sections and controls anywhere. Drop a toolbar item off the bar to remove it.</span>
        <button disabled={!canUndoPrefs()} onClick={undoPrefs}>Undo</button>
        <button onClick={onCustomize}>Customize…</button>
        <button onClick={() => setPrefs({ bars: structuredClone(DEFAULT_BARS), layout: LAYOUTS[0]![1](), sections: {}, hiddenSections: [], rows: {}, hiddenRows: {} })}>Reset arrangement</button>
        <button className="primary" onClick={onDone}>Done</button>
      </div>
      <div className="arrange-palette">
        {spare.map(([k, it]) => <span key={k} className="pal-item" onPointerDown={(e) => drag(e, k, it.label)}><Icon name={it.icon ?? 'custom'} size={17} />{it.label}</span>)}
        {(['space', 'flex', 'sep'] as const).map((k) => <span key={k} className="pal-item" onPointerDown={(e) => drag(e, k, k)}>{k === 'space' ? 'Space' : k === 'flex' ? 'Flexible space' : 'Divider'}</span>)}
        {closed.map(([id, t]) => <button key={id} className="pal-item" onClick={() => setPrefs((p) => ({ layout: reopenPanel(p.layout, id) }))}><Icon name="plus" size={14} />{t} panel</button>)}
        {hiddenBars.map((b) => <button key={b} className="pal-item" onClick={() => setBar(b, { hidden: false })}><Icon name="plus" size={14} />{BAR_NAMES[b]}</button>)}
      </div>
    </div>
  );
}

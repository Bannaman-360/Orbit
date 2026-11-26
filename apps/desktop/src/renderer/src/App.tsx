import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MIN_FISHEYE, parseCube, ReframeRenderer } from '@ace/media360';
import {
  addClip, designFor, GAUGE_DESIGNS, gaugeSet, clipDuration, clipStarts, localAt, deleteSideAt, detachAudio, duplicateClip, emptyTimeline, FRAMINGS, framingAspect, GAUGES, keyframeNear, loadTimeline, locate,
  mediaToTimeline, moveClip, newAudioClip, newClip, newGaugeOverlay, newTextOverlay, nextKeyTime, prevKeyTime, reattachAudio, removeAudio,
  removeClip, removeClipRipple, withOff, removeKeyframe, removeOverlay, setEasing, CURVES, TITLE_CATEGORIES, TITLE_TEMPLATES, newTitleOverlay, setKeyframe, splitAt, timelineDuration, transitionLook, trimClip, updateAudio, type Transform,
  updateClip, updateOverlay, addMarker, updateMarker, removeMarker, markerNear, splitOverlay, trimOverlayAt, overlayState, rollCut, slipClip, slideClip, insertClipAt, overwriteClipAt,
  hasRamp, mediaAt, moveSpeedKey, rippleItems, DEFAULT_LENS_LOOK, fisheyeForLook, lookAt, removeSpeedKey, setClipSpeed, setSpeedEase, setSpeedKey, speedAt, speedKeyNear,
  COMFORT_FOV, fitSubjectFrac, fracForFov, moveKeyframe, trackWeight, DEFAULT_TRACK_MAX_FOV, MAX_ZOOM_FOV, setTrackRange, trackActive, trackExtent, trackHeld, trackRange,
  type ClipTrack, type Easing, type GaugeDesign, type GaugeKind, type Grade, type Look, type Overlay, type Timeline, type TimelineClip, type Transition,
  TIMELINE_VERSION, toSrt, withCaptions, findClip, MAX_MASKS, frameToLayer, insidePolygon, layerToFrame, maskOutline, maskPoseAt, newMask, setMaskPose, type Mask, addTrack, applyLayout, cellTransform, LAYOUT_TEMPLATES, cleanXf, hitsLayer, stackAt, xfOf, layerLocated, moveConnected, newId, placeConnected, playLength, removeConnected, splitConnected, deleteSideConnected, trackFree, trackName, trimEmptyTracks, updateTrack, type Located, type ConnectedClip, type AudioClip, addMulticam, groupOf, switchAngle, flattenTimeline, storeSequence, sequenceTimeline, findSequence, sequenceIdOf, isCompound, makeCompound, breakApart, sourceDuration,
} from '@ace/project';
import { ace, baseName, type FoundMedia, type ProjectMeta, type UpdateState } from './api';
import { NameSheet, ProjectsPage } from './Projects';
import { AudioPlayer } from './audioEngine';
import { hasTwoLenses, lensUi, matchClipLenses, setLensUi } from './lensMatching';
import { cardOf, running, startCards, useCards } from './cardImport';
import { ExportDialog } from './ExportDialog';
import { BatchDialog, QueuePanel } from './QueuePanel';
import { onQueue, pendingCount } from './exportQueue';
import { pauseFilmstrip } from './filmstrip';
import { ImportWindow } from './ImportWindow';
import { grabFrame, loadLut, MAX_LAYERS } from './exporter';
import { gradeView, SCOPE_EVERY_MS } from './gradeView';
import { ScopesPanel } from './Scopes';
import { forgetPictureMotion, stabiliseFromPicture } from './flowStab';
import { reframeNote as noteOf, smartReframe } from './smartReframe';
import { ModelsDialog, SubtitlesDialog } from './AiDialogs';
import { ensureCopies, onCopyChange, retryCopy } from './aiCopy';
import { adoptReframe, canReframe, lensLookOf, clipLens, clipLookAt, flatDirection, flatShot, FOLLOW_ROOM, ownLookAt, roomFov, shareOf, shownFov, withoutEffects, presentLook, pushClipFrame, reframeSignature, shownXf } from './frameRender';
import { angleBetween, directionAt, trackSubject } from './tracker';
import { InspectorPanel, SelectionPanel, type InspectorProps } from './Inspector';
import { MediaBin, type BinItem } from './MediaBin';
import { AppMenu, ShortcutsDialog } from './Menu';
import { forgetMedia, getMedia, loadMusic, mediaNow, MISSING, whyCannotOpen, wholeRecordings } from './media';
import { ensureProxies, forgetProxies, onProxyChange, PREVIEW_LEVELS, setPreviewLevel, type PreviewLevel } from './proxy';
import { drawOverlays, hitOverlay, layerCss, overlayBox, placedCss } from './overlayRender';
import { alignBox, type Guides } from './alignGuides';
import { onSoundLevels } from './soundLevels';
import { onSpectrum } from './soundSpectrum';
import { runSelftest, type EditorApi } from './selftest';
import { applyMasks, maskPlaces, subjectInFrame } from './masksRender';
import { TimelinePlayer, type TickResult } from './timelinePlayer';
import { MAX_PPS, MIN_PPS, TimelineView } from './TimelineView';
import { AngleViewer, MulticamDialog } from './Multicam';
import { syncAngles } from './multicamSync';
import { fmtTime, openSection, Range, toggleAllSections } from './ui';
import { Bar, dragItem, type ToolItem } from './ui/Bars';
import { comboFromEvent, comboLabel, comboOf, combosOf, commandFor, COMMANDS, keyOf, KeyMatcher } from './ui/commands';
import { ArrangeBar, Customize, reopenPanel, type CustomizePage } from './ui/Customize';
import { Tour, Welcome } from './Tour';
import { ReportProblem } from './ReportProblem';
import { MarkersPanel } from './Markers';
import type { EditTool } from './TimelineView';

/** Edit tools: what dragging a clip on the main row does. */
const TOOLS: [EditTool, string, string][] = [
  ['select', 'Select', 'Trim (the rest moves up) or reorder'],
  ['roll', 'Roll', 'Move a cut: one clip longer, the next shorter'],
  ['slip', 'Slip', 'Show another part of a clip, same place and length'],
  ['slide', 'Slide', 'Move a clip between its neighbours'],
];
import { Dock, type PanelDef } from './ui/Dock';
import { closePanel, openPanels } from './ui/dockModel';
import { Icon } from './ui/Icon';
import { getPrefs, isArranging, LAYOUTS, LEVELS, onNativeTheme, PANELS, platformMac, setArranging, setLevel as setExpLevel, setPrefs, undoPrefs, useArranging, usePrefs } from './ui/prefs';

/** A media item as saved in the project, with what the user said about it. */
export interface LibraryEntry { path: string; rating?: number; flag?: 'fav' | 'reject'; bin?: string; /** Bytes: finds the file again if it's renamed. */ size?: number }
/** A folder in the media pool (nested through `parent`). */
export interface MediaBinFolder { id: string; name: string; parent?: string }
interface SaveFile { version: 2; timeline: Timeline; library: LibraryEntry[]; bins: MediaBinFolder[] }
/** Older projects listed media as plain paths. */
/** Every video file an edit uses, including those inside compound clips. */
const filesOf = (tl: Timeline): string[] => [...new Set([...tl.clips, ...tl.connected, ...(tl.sequences ?? []).flatMap((q) => [...q.clips, ...q.connected])].filter((c) => !isCompound(c)).map((c) => c.mediaPath))];
const libraryOf = (raw: unknown): LibraryEntry[] => (Array.isArray(raw) ? raw : []).flatMap((x): LibraryEntry[] => (typeof x === 'string' ? [{ path: x }] : x && typeof x.path === 'string' ? [{ path: x.path, ...(x.rating ? { rating: Math.max(0, Math.min(5, Math.round(+x.rating))) } : {}), ...(x.flag === 'fav' || x.flag === 'reject' ? { flag: x.flag } : {}), ...(typeof x.bin === 'string' ? { bin: x.bin } : {}), ...(Number.isFinite(x.size) ? { size: +x.size } : {}) }] : []));

/** What is selected besides the clip under the playhead. */
/** What is selected besides the clip at the playhead: a sound, text or gauge, transition, or a clip on a track above the main row. */
export type Selection = { kind: 'audio' | 'overlay' | 'transition' | 'layer'; id: string } | null;

/** True when the element takes typed text (so shortcuts must not fire). */
function isTextEntry(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const t = (el as HTMLInputElement).type;
  return !['range', 'checkbox', 'radio', 'button', 'color', 'submit'].includes(t);
}

const speedId = (c: { speed?: number; speedKeys?: { t: number; speed: number; ease?: string }[] }) => c.speedKeys?.map((k) => `${k.t}@${k.speed}${k.ease ?? ''}`).join() ?? c.speed;
/** Clips' media paths, in/out, order, speed and transitions: changes that need the player to re-seek. */
const structureKey = (tl: Timeline) =>
  tl.clips.map((c) => `${c.id}:${c.mediaPath}:${c.inUs}:${c.outUs}:${speedId(c)}:${c.transitionIn?.durationUs ?? 0}`).join('|')
  + `#${tl.connected.map((c) => `${c.id}:${c.mediaPath}:${c.inUs}:${c.outUs}:${speedId(c)}:${c.startUs}:${c.trackId}`).join('|')}#${tl.tracks.map((t) => `${t.id}${t.hidden ? 'h' : ''}`).join(',')}`;
const audioKey = (tl: Timeline) =>
  `${structureKey(tl)}#${tl.connected.map((c) => `${c.volume}${c.muteBelow ?? ''}${c.keepPitch === false ? 'p' : ''}`).join(',')}#${tl.tracks.map((t) => (t.muted ? 'm' : '-')).join('')}#${tl.clips.map((c) => `${c.volume}${c.audioDetached ? 'd' : ''}${c.muteBelow ?? ''}${c.keepPitch === false ? 'p' : ''}`).join(',')}#${tl.audio
    .map((a) => `${a.path}:${a.startUs}:${a.inUs}:${a.outUs}:${a.volume}:${a.fadeInUs}:${a.fadeOutUs}:${speedId(a)}:${a.muteBelow ?? ''}:${a.keepPitch === false ? 'p' : ''}`)
    .join('|')}`;

/**
 * A new project takes the shape of its first regular video, as in other editors: a phone clip
 * held upright makes a 9:16 project. Only while the frame shape is still the one it started with.
 */
function firstClipShape(prev: Timeline, next: Timeline): Timeline {
  if (prev.clips.length || prev.connected.length || !next.clips.length || next.framing !== prev.framing || prev.framing !== emptyTimeline().framing) return next;
  const m = mediaNow(next.clips[0]!.mediaPath);
  if (!m || m.is360 || !(m.width > 0 && m.height > 0)) return next;
  const a = m.width / m.height, off = (f: { aspect: number }) => Math.abs(Math.log(f.aspect / a));
  const best = FRAMINGS.reduce((x, f) => (off(f) < off(x) ? f : x));
  return best.label === next.framing ? next : { ...next, framing: best.label };
}

export function App() {
  // --- Timeline state with undo -------------------------------------------------------------
  const [tl, setTl] = useState<Timeline>(emptyTimeline());
  const tlRef = useRef(tl);
  tlRef.current = tl;
  const hist = useRef({ past: [] as Timeline[], future: [] as Timeline[], lastKey: '', lastAt: 0 });

  /** Applies an edit. Edits with the same `key` within a second merge into one undo step. */
  const commit = useCallback((given: Timeline, key = '') => {
    const next = firstClipShape(tlRef.current, given);
    if (next !== given) setNotice(`The frame shape is now ${next.framing} to match ${baseName(next.clips[0]!.mediaPath)}. Change it with Frame shape in the toolbar.`);
    const h = hist.current;
    const now = performance.now();
    if (!key || key !== h.lastKey || now - h.lastAt > 1000) {
      h.past.push(tlRef.current);
      if (h.past.length > 200) h.past.shift();
      h.future = [];
    }
    h.lastKey = key;
    h.lastAt = now;
    tlRef.current = next;
    setTl(next);
  }, []);
  const endGesture = useCallback(() => (hist.current.lastKey = ''), []);
  /** Compound clips opened for editing, outermost first: the timeline each was opened from. */
  const nestRef = useRef<{ id: string; name: string; outer: Timeline; hist: typeof hist.current; time: number }[]>([]);
  const [nest, setNest] = useState<{ id: string; name: string }[]>([]);
  /** The whole project's timeline (with any compound clip being edited put back in). */
  const rootTimeline = (): Timeline => {
    let cur = tlRef.current;
    for (let i = nestRef.current.length - 1; i >= 0; i--) { const n = nestRef.current[i]!; cur = storeSequence(n.outer, n.id, cur); }
    return cur;
  };
  const undo = useCallback(() => {
    const h = hist.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(tlRef.current);
    h.lastKey = '';
    tlRef.current = prev;
    setTl(prev);
  }, []);
  const redo = useCallback(() => {
    const h = hist.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(tlRef.current);
    h.lastKey = '';
    tlRef.current = next;
    setTl(next);
  }, []);

  // --- Preview quality (proxies) -----------------------------------------------------------
  const [level, setLevel] = useState<PreviewLevel>(() => {
    try {
      const v = Number(localStorage.getItem('ace.previewLevel'));
      return ([1, 2, 4, 8] as const).includes(v as PreviewLevel) ? (v as PreviewLevel) : 1;
    } catch {
      return 1;
    }
  });
  const [, proxyTick] = useState(0);
  useEffect(() => { const off = onProxyChange(() => proxyTick((n) => n + 1)); return () => { off(); }; }, []);
  const binMedia = () => binRef.current.flatMap((b) => (b.media ? [b.media] : []));
  useEffect(() => {
    setPreviewLevel(level, binMedia());
    try { localStorage.setItem('ace.previewLevel', String(level)); } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  // --- Media bin ------------------------------------------------------------------------------
  const [bin, setBin] = useState<BinItem[]>([]);
  const binRef = useRef(bin);
  binRef.current = bin;
  const [bins, setBins] = useState<MediaBinFolder[]>([]);
  /** File sizes from the project, for finding missing files again. */
  const savedSizes = useRef(new Map<string, number>());
  const binsRef = useRef(bins);
  binsRef.current = bins;
  const [, bump] = useState(0);

  const importPaths = useCallback(async (picked: string[]) => {
    const paths = await wholeRecordings(picked);
    const fresh = paths.filter((p) => !binRef.current.some((b) => b.path === p));
    if (!fresh.length) return paths;
    setBin((b) => [...b, ...fresh.map((path) => ({ path }))]);
    await Promise.all(
      fresh.map(async (path) => {
        try {
          const media = await getMedia(path);
          setBin((b) => b.map((x) => (x.path === path ? { path, media } : x)));
          ensureProxies([media]);
        } catch (e) {
          ace.logError('import', `${baseName(path)}: ${String(e)}`);
          const why = await whyCannotOpen(path, e);
          setBin((b) => b.map((x) => (x.path === path ? { path, error: why } : x)));
        }
      }),
    );
    return paths;
  }, []);

  const addToTimeline = useCallback((path: string, index?: number) => {
    const c = clipFor(path);
    if (c) commit(addClip(tlRef.current, c, index ?? tlRef.current.clips.length));
  }, [commit]);

  // --- Source view (three-point editing) ---------------------------------------------------------
  // The preview can show one Media clip on its own: mark in (I) and out (O), then Insert (,) or
  // Overwrite (.) at the timeline's playhead. The player simply plays a one-clip timeline meanwhile.
  const [source, setSource] = useState<{ path: string; inUs: number | null; outUs: number | null } | null>(null);
  const sourceRef = useRef<{ tl: Timeline; savedTime: number } | null>(null);
  const openSource = (path: string) => {
    const c = clipFor(path);
    if (!c) return;
    const savedTime = sourceRef.current?.savedTime ?? player.time;
    player.pause();
    sourceRef.current = { tl: { ...addClip(emptyTimeline(), c), framing: tlRef.current.framing }, savedTime };
    setSource({ path, inUs: null, outUs: null });
    player.invalidate();
    player.seek(0);
  };
  const closeSource = () => {
    const sv = sourceRef.current;
    if (!sv) return;
    player.pause();
    sourceRef.current = null;
    setSource(null);
    player.invalidate();
    player.seek(sv.savedTime);
  };
  const placeSource = (how: 'insert' | 'overwrite') => {
    const sv = sourceRef.current;
    if (!sv || !source) return;
    const base = clipFor(source.path);
    if (!base) return;
    const inUs = source.inUs ?? 0, outUs = source.outUs ?? base.outUs;
    if (outUs - inUs < 100_000) { setNotice('Mark an out point after the in point first.'); return; }
    const clip = { ...base, inUs, outUs };
    commit(how === 'insert' ? insertClipAt(tlRef.current, clip, sv.savedTime) : overwriteClipAt(tlRef.current, clip, sv.savedTime));
    // The next piece goes after this one.
    sv.savedTime += outUs - inUs;
    setNotice(`${how === 'insert' ? 'Inserted' : 'Placed'} ${baseName(source.path)} (${fmtTime(outUs - inUs)}) at the timeline playhead.`);
  };
  const markSource = (which: 'inUs' | 'outUs') => { if (sourceRef.current) setSource((sv) => sv && { ...sv, [which]: Math.round(player.time) }); };

  /** A clip for a Media item, set up as it should start (lens, stabilization). */
  function clipFor(path: string) {
    const m = mediaNow(path);
    if (!m) return null;
    // Regular videos start whole (Fit), as in other editors: nothing is cut off until asked.
    const made0 = { ...newClip(path, m.durationUs, m.is360), ...(m.is360 ? {} : { fit: 'fit' as const }) };
    // 360 clips keep their lens look while zooming.
    const made = m.is360 ? { ...made0, lensLook: DEFAULT_LENS_LOOK } : made0;
    // Without motion data there is nothing to stabilize with (stitched videos have it built in).
    const c = m.layout?.equirect && !m.stabilizer.hasOrientation ? { ...made, stabilize: { ...made.stabilize, smoothing: 'off' as const, horizon: false } } : made;
    // Regular clips start as recorded, ready to be reframed; steadied when the camera's motion data
    // allows it and the camera didn't steady them itself.
    const steady = m.lens && m.stabilizer.hasOrientation && !m.camera.stabilizedInCamera;
    return m.lens ? { ...c, lensMode: 'source' as const, look: { ...c.look, fov: m.lens.hfov }, ...(steady ? { stabilize: { ...c.stabilize, smoothing: 'medium' as const, crop: 'auto' as const } } : {}) } : c;
  }

  // --- Playback & rendering --------------------------------------------------------------------
  // One slot per picture on screen (main row, two in a transition, then the tracks above): the
  // slot moves with a transition, the box inside it places the clip, the canvas is its picture.
  const slotEls = useRef<(HTMLDivElement | null)[]>([]);
  const boxEls = useRef<(HTMLDivElement | null)[]>([]);
  const canvasEls = useRef<(HTMLCanvasElement | null)[]>([]);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const dipRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Renderer per slot (made when first needed), and the clip each one draws. */
  const renderersRef = useRef<(ReframeRenderer | null)[]>([]);
  const slotClip = useRef<(string | null)[]>(Array.from({ length: MAX_LAYERS }, () => null));
  // (Playback sees compound clips as the clips they hold.)
  const player = useMemo(() => new TimelinePlayer(() => sourceRef.current?.tl ?? flattenTimeline(tlRef.current)), []);
  // AI copies (smooth slow motion, sharper pictures): show each as soon as it's ready.
  useEffect(() => { const off = onCopyChange(() => { proxyTick((n) => n + 1); player.invalidate(); }); return () => { off(); }; }, [player]);
  useEffect(() => { const f = flattenTimeline(tl); ensureCopies([...f.clips, ...f.connected]); }, [tl]);
  const audio = useMemo(() => new AudioPlayer(), []);
  const lastResult = useRef<TickResult | null>(null);
  const renderWaiters = useRef<(() => void)[]>([]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const showRawRef = useRef(showRaw);
  showRawRef.current = showRaw;
  /** Held down: show the picture without any effects (before / after). */
  const [compare, setCompare] = useState(false);
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const [error, showError] = useState<string | null>(null);
  // Every problem the user is told about also goes in the log (Help → Report a Problem).
  const setError = useCallback((e: string | null) => { if (e) ace.logError('shown', e); showError(e); }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [exportOpen, setExportOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const queuePending = useSyncExternalStore(onQueue, pendingCount);
  /** New pictures shown per second while playing, and how often the screen is redrawn. */
  const [rate, setRate] = useState({ video: 0, screen: 0 });

  useEffect(() => {
    player.onTransport = (isPlaying, t) => {
      // (Shuttling faster than normal is silent, like a tape deck with the sound off.)
      if (isPlaying && player.rate === 1) audio.play(flattenTimeline(tlRef.current), t);
      else audio.stop();
    };
  }, [player, audio]);

  // Re-seek when clips change shape; restart audio when anything audible changes.
  const sKey = structureKey(flattenTimeline(tl));
  useEffect(() => player.invalidate(), [sKey, player]);
  const aKey = audioKey(flattenTimeline(tl));
  useEffect(() => {
    let cancelled = false;
    void audio.prepare(flattenTimeline(tlRef.current)).then(() => {
      if (!cancelled && player.playing) audio.play(flattenTimeline(tlRef.current), player.time);
    });
    return () => { cancelled = true; };
  }, [aKey, audio, player]);

  // LUT.
  useEffect(() => {
    for (const r of renderersRef.current) if (r) loadLut(r, tl.lutPath).catch((e) => setError(`LUT: ${e}`));
  }, [tl.lutPath]);

  // Size the preview to the output framing, as large as fits.
  const aspect = framingAspect(tl.framing);
  useEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      // (Hidden behind another tab: keep the last size.)
      if (!stage.clientWidth || !stage.clientHeight) return;
      const pad = parseFloat(getComputedStyle(stage).paddingLeft) * 2;
      const W = stage.clientWidth - pad, H = stage.clientHeight - pad;
      const w = Math.max(2, Math.min(W, H * aspect)), h = w / aspect;
      frameRef.current!.style.width = `${Math.floor(w)}px`;
      frameRef.current!.style.height = `${Math.floor(h)}px`;
      // Lower preview quality also draws fewer pixels (big saving on slow graphics).
      const full = window.devicePixelRatio || 1;
      const dpr = level === 1 ? full : level === 2 ? Math.min(full, 1) : level === 4 ? 0.75 : 0.5;
      // More pixels than the footage has only costs speed (a full-screen Retina preview would be
      // drawn at twice the detail of the 360 source).
      const cap = Math.min(dpr, 2048 / Math.max(w, h));
      for (const c of canvasEls.current) {
        if (!c) continue;
        c.width = Math.max(2, Math.round(w * cap));
        c.height = Math.max(2, Math.round(h * cap));
      }
      // Gauges and titles stay sharp at every preview quality: drawn at the screen's own pixels
      // (a lower-resolution layer stretched by the browser makes thin lines shimmer as they move).
      const ov = overlayRef.current!;
      ov.width = Math.max(2, Math.round(w * full));
      ov.height = Math.max(2, Math.round(h * full));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [aspect, level]);

  /**
   * Positions the video layers: the main row (moved by its transition), the colour dip, then
   * the tracks above, each placed by its clip's transform. `xfs`: each layer's transform now.
   */
  const styleLayers = (res: TickResult, slots: number[], xfs: (Transform | undefined)[]) => {
    const layers = res.layers!;
    const inTransition = layers.some((l) => l.role === 'in');
    const look = inTransition && res.transition ? transitionLook(res.transition.kind, res.progress) : null;
    const main = layers.filter((l) => l.track === 0).length;
    const frame = frameRef.current!;
    const W = frame.clientWidth, H = frame.clientHeight;
    for (let ri = 0; ri < MAX_LAYERS; ri++) {
      const slot = slotEls.current[ri], box = boxEls.current[ri], c = canvasEls.current[ri];
      if (!slot || !box || !c) continue;
      const li = slots.indexOf(ri);
      if (li < 0) {
        slot.style.visibility = 'hidden';
        continue;
      }
      const l = layers[li]!;
      slot.style.visibility = 'visible';
      // (The dip sits between the main row and the tracks above.)
      // (Some transitions move the outgoing clip away over the incoming one.)
      slot.style.zIndex = String(look?.aOnTop && l.role ? (l.role === 'out' ? main : main - 1) : li < main ? li + 1 : li + 2);
      const css = look && l.role
        ? layerCss(l.role === 'out' ? look.a : look.b, W, l.role === 'out' ? null : look.reveal)
        : { opacity: '1', transform: '', filter: '', clipPath: '' };
      Object.assign(slot.style, css);
      const placed = placedCss(xfs[li], W, H);
      Object.assign(box.style, placed.box);
      // The selected clip over the main row is outlined (only here, never in the export).
      const s = selRef.current;
      box.style.outline = l.track > 0 && s?.kind === 'layer' && s.id === l.clip.id ? '2px solid var(--accent)' : '';
      Object.assign(c.style, placed.canvas);
    }
    const dip = dipRef.current!;
    dip.style.zIndex = String(main + 1);
    dip.style.opacity = look?.dip ? String(look.dipAlpha) : '0';
    if (look?.dip) dip.style.background = look.dip;
  };

  const drawOverlayLayer = () => {
    const c = overlayRef.current;
    if (!c) return;
    // Nothing on it and nothing to draw: leave the (large) layer alone.
    const overlays = sourceRef.current ? [] : flattenTimeline(tlRef.current).overlays;
    // The masks being edited are outlined (only here, never in the export).
    const outlines = sourceRef.current ? [] : maskOutlinesRef.current();
    const drawing = drawPts.current;
    if (!overlays.length && !outlines.length && !drawing && !c.dataset.drawn) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (overlays.length || outlines.length || drawing) c.dataset.drawn = '1'; else delete c.dataset.drawn;
    const s = selRef.current;
    if (overlays.length) drawOverlays(ctx, c.width, c.height, flattenTimeline(tlRef.current), player.time, s?.kind === 'overlay' ? s.id : null);
    const accent = getComputedStyle(c).getPropertyValue('--accent').trim() || '#3d8bfd';
    const path = (pts: [number, number][], close: boolean) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * c.width, y * c.height) : ctx.moveTo(x * c.width, y * c.height))); if (close) ctx.closePath(); };
    ctx.save();
    ctx.lineWidth = Math.max(1.5, c.width / 900);
    for (const o of outlines) {
      ctx.strokeStyle = o.selected ? accent : 'rgba(255,255,255,0.55)';
      ctx.setLineDash(o.selected ? [] : [6, 5]);
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 3;
      path(o.pts, true);
      ctx.stroke();
    }
    if (drawing && drawing.length > 1) { ctx.strokeStyle = accent; ctx.setLineDash([]); path(drawing, false); ctx.stroke(); }
    ctx.restore();
  };
  const styleLayersRef = useRef(styleLayers);
  styleLayersRef.current = styleLayers;
  // --- Masks on the preview -----------------------------------------------------------------
  const [maskSel, setMaskSel] = useState<string | null>(null);
  const [drawingMask, setDrawingMask] = useState(false);
  const maskSelRef = useRef(maskSel);
  maskSelRef.current = maskSel;
  /** Freehand outline being drawn (frame fractions). */
  const drawPts = useRef<[number, number][] | null>(null);
  /** The clip being edited and where its masks are now (in its own picture, and in the frame). */
  const maskScene = () => {
    const cur = editingAt();
    if (!cur) return null;
    const m = mediaNow(cur.clip.mediaPath) ?? null;
    const lk = clipLookAt(cur.clip, cur.mediaUs);
    return { cur, media: m, look: lk, places: maskPlaces(cur.clip, m, lk, cur.mediaUs, aspect) };
  };
  const maskOutlines = () => {
    if (!maskSelRef.current && !drawingMask) return [];
    const sc = maskScene();
    if (!sc) return [];
    return sc.places.map(({ mask, pose, centre }) => ({
      selected: mask.id === maskSelRef.current,
      pts: maskOutline(mask, pose, aspect, centre).map(([u, v]) => layerToFrame(sc.look.xf, aspect, u, v)),
    }));
  };
  const maskOutlinesRef = useRef(maskOutlines);
  maskOutlinesRef.current = maskOutlines;
  /** The freehand outline just drawn becomes a mask on the clip being edited. */
  const finishDrawnMask = () => {
    const pts = drawPts.current;
    drawPts.current = null;
    setDrawingMask(false);
    setNotice(null);
    const cur = editingAt();
    if (!cur || !pts || pts.length < 3) return;
    if ((cur.clip.masks?.length ?? 0) >= MAX_MASKS) { setNotice(`A clip can have ${MAX_MASKS} masks. Delete one to draw another.`); return; }
    const lk = clipLookAt(cur.clip, cur.mediaUs);
    const uv = pts.map(([x, y]) => frameToLayer(lk.xf, aspect, x, y));
    const xs = uv.map((q) => q[0]), ys = uv.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x1 - x0 < 0.01 && y1 - y0 < 0.01) return;
    const w = Math.max(0.01, x1 - x0), h = Math.max(0.01, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const made = newMask('path', 'blur', { x: cx, y: cy, w, h, points: uv.map(([u, v]) => [(u - cx) / w, (v - cy) / h] as [number, number]) });
    setClipMasks(cur.clip.id, [...(cur.clip.masks ?? []), made], 'mask-draw');
    setMaskSel(made.id);
  };
  const setClipMasks = (clipId: string, masks: Mask[], key: string) => commit(updateClip(tlRef.current, clipId, { masks: masks.length ? masks : undefined }), `${key}:${clipId}`);
  const drawOverlayRef = useRef(drawOverlayLayer);
  drawOverlayRef.current = drawOverlayLayer;
  // A Sound level gauge reads the clip's sound in the background: redraw as more of it is known.
  useEffect(() => onSoundLevels(() => { if (!player.playing) drawOverlayRef.current(); }), []);
  useEffect(() => onSpectrum(() => { if (!player.playing) drawOverlayRef.current(); }), []);

  // Render loop.
  useEffect(() => {
    let raf = 0, stop = false;
    let frames = 0, pictures = 0, lastPicture = -1, fpsT = performance.now(), uiT = 0;
    // Per renderer: which clip it shows and what it last drew.
    const state = Array.from({ length: MAX_LAYERS }, () => ({ clipKey: '', lastTs: -1, lastSig: '' }));
    const making = new Set<number>();
    /** Renderer `ri`, or null while it is being made (the first two are made up front). */
    const rendererAt = (ri: number): ReframeRenderer | null => {
      const r = renderersRef.current[ri];
      if (r) return r;
      if (!making.has(ri)) {
        making.add(ri);
        void ReframeRenderer.create(canvasEls.current[ri]!).then(async (made) => {
          await loadLut(made, tlRef.current.lutPath).catch(() => {});
          renderersRef.current[ri] = made;
        }).catch((e) => setError(`GPU: ${e}`));
      }
      return null;
    };
    (async () => {
      try {
        const first = await Promise.all([0, 1].map((ri) => ReframeRenderer.create(canvasEls.current[ri]!)));
        for (const r of first) await loadLut(r, tlRef.current.lutPath).catch(() => {});
        renderersRef.current = [...first, ...Array.from({ length: MAX_LAYERS - 2 }, () => null)];
      } catch (e) {
        setError(`GPU: ${e}`);
        return;
      }
      const loop = (now: number) => {
        if (stop) return;
        const res = player.tick(now);
        if (!res) {
          // Nothing on the timeline: don't leave the last picture up.
          for (const c of slotEls.current) if (c) c.style.visibility = 'hidden';
          for (const st of state) st.clipKey = '';
          slotClip.current.fill(null);
        }
        if (res?.layers) {
          lastResult.current = res;
          // A clip keeps its renderer (and motion-blur history) for its whole time on screen,
          // transitions included; renderers of clips that left draw the newcomers.
          const ids = new Set(res.layers.map((l) => l.clip.id));
          slotClip.current = slotClip.current.map((id) => (id && ids.has(id) ? id : null));
          const slots = res.layers.map((l) => {
            let ri = slotClip.current.indexOf(l.clip.id);
            if (ri < 0) { ri = slotClip.current.indexOf(null); if (ri >= 0) slotClip.current[ri] = l.clip.id; }
            return ri;
          });
          const xfs: (Transform | undefined)[] = [];
          res.layers.forEach((l, li) => {
            const ri = slots[li]!;
            const r = ri < 0 ? null : rendererAt(ri);
            if (!r) { slots[li] = -1; return; }
            const st = state[ri]!;
            const clipKey = `${l.clip.id}|${l.media.path}|${l.level}`;
            if (clipKey !== st.clipKey) {
              r.setLayout(l.layout);
              st.clipKey = clipKey;
              st.lastTs = -1;
            }
            // Stabilisation and keyframes use the shown frame's own timestamp, not the playhead
            // (which runs on the display clock and can be up to a frame later → visible shake).
            const ts = l.frames[0]!.timestamp;
            const raw = showRawRef.current && li === 0;
            const look = clipLookAt(l.clip, ts);
            xfs[li] = shownXf(l.clip, l.media, look, framingAspect(tlRef.current.framing));
            // (Before / after also leaves out what is done to each lens.)
            const shownClip = compareRef.current && l.clip.lenses ? { ...l.clip, lenses: undefined } : l.clip;
            const sig = reframeSignature(shownClip, look, `${raw}|${r.canvas.width}x${r.canvas.height}`);
            let push = false;
            if (ts !== st.lastTs) {
              if (!player.playing || ts < st.lastTs || sig !== st.lastSig) r.resetHistory();
              push = true;
            } else if (sig !== st.lastSig) {
              r.resetHistory();
              push = true;
            }
            if (push) {
              pushClipFrame(r, shownClip, l.media, ts, l.frames, { raw, showTiles: true });
              st.lastTs = ts;
              st.lastSig = sig;
            }
            const mark = lensUi();
            r.highlight = mark.highlight && !raw && hasTwoLenses(l.media) ? mark.lens : null;
            applyMasks(r, l.clip, l.media, look, ts);
            r.showMatte = gradeView.matteClip === l.clip.id && !compareRef.current;
            const sc = gradeView.scopes;
            const scoped = !!sc && performance.now() - gradeView.last > SCOPE_EVERY_MS && (gradeView.clipId === l.clip.id || (li === 0 && !res.layers!.some((x) => x.clip.id === gradeView.clipId)));
            if (scoped) r.tap = sc.analyse;
            presentLook(r, compareRef.current ? withoutEffects(look) : withOff(look, l.clip.off), { raw: raw && l.media.is360, time: ts, clip: compareRef.current ? null : l.clip });
            if (scoped) { gradeView.last = performance.now(); sc.drawn(); }
          });
          styleLayersRef.current(res, slots, xfs);
          frames++;
          const shown = res.layers[0]!.frames[0]!.timestamp;
          if (shown !== lastPicture) { pictures++; lastPicture = shown; }
          renderWaiters.current.splice(0).forEach((f) => f());
        }
        drawOverlayRef.current();
        if (now - uiT > 33) {
          uiT = now;
          setTime(player.time);
          setPlaying(player.playing);
          pauseFilmstrip(player.playing);
        }
        if (now - fpsT > 1000) {
          setRate({ video: (pictures * 1000) / (now - fpsT), screen: (frames * 1000) / (now - fpsT) });
          frames = 0;
          pictures = 0;
          fpsT = now;
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [player]);

  // Have the sound at the playhead ready before play is pressed.
  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => audio.prime(flattenTimeline(tlRef.current), time), 120);
    return () => clearTimeout(id);
  }, [time, playing, tl, audio]);

  // --- Current clip & edits --------------------------------------------------------------------
  // (In the Source view nothing on the timeline is being edited.)
  // A selected clip on a track above the main row is the one being edited; otherwise the main-row
  // clip under the playhead.
  const layerSel = !source && sel?.kind === 'layer' ? tl.connected.find((c) => c.id === sel.id) ?? null : null;
  const at: Located | null = source ? null : layerSel ? layerLocated(tl, layerSel, time) : locate(tl, time);
  const clip = at?.clip ?? null;
  const media = clip ? mediaNow(clip.mediaPath) ?? null : null;
  const look = clip && at ? clipLookAt(clip, at.mediaUs) : null;
  const snapUs = media ? 1e6 / media.fps : 20_000;
  const duration = timelineDuration(tl);

  const seek = useCallback((T: number) => player.seek(T), [player]);
  // JKL shuttle: L plays forward (again: 2×, 4×, 8×), J backward the same way, K stops.
  const shuttle = useRef<{ dir: -1 | 0 | 1; rate: number; raf: number }>({ dir: 0, rate: 1, raf: 0 });
  const stopShuttle = useCallback(() => {
    const sh = shuttle.current;
    cancelAnimationFrame(sh.raf);
    sh.dir = 0; sh.rate = 1;
    player.rate = 1;
  }, [player]);
  const shuttleTo = useCallback((dir: -1 | 1) => {
    const sh = shuttle.current;
    sh.rate = sh.dir === dir ? Math.min(8, sh.rate * 2) : 1;
    sh.dir = dir;
    cancelAnimationFrame(sh.raf);
    if (dir === 1) {
      player.rate = sh.rate;
      if (player.playing) player.pause();
      player.play();
      return;
    }
    // Backward: step the playhead back each frame; pictures come from the backward-scrub cache.
    player.pause();
    player.rate = 1;
    let last = performance.now();
    const back = (now: number) => {
      if (sh.dir !== -1) return;
      const t = Math.max(0, player.time - (now - last) * 1000 * sh.rate);
      last = now;
      player.seek(t);
      if (t <= 0) { sh.dir = 0; return; }
      sh.raf = requestAnimationFrame(back);
    };
    sh.raf = requestAnimationFrame(back);
  }, [player]);
  const togglePlay = useCallback(() => { stopShuttle(); if (player.playing) player.pause(); else player.play(); }, [player, stopShuttle]);

  /** A clip on the main row or a track above it, and its timeline start. */
  const clipSpot = (t: Timeline, id: string): { clip: TimelineClip; startUs: number; layer: boolean } | null => {
    const i = t.clips.findIndex((x) => x.id === id);
    if (i >= 0) return { clip: t.clips[i]!, startUs: clipStarts(t)[i]!, layer: false };
    const c = t.connected.find((x) => x.id === id);
    return c ? { clip: c, startUs: c.startUs, layer: true } : null;
  };
  /** Keeps a track clip selected while one of its keyframes, speed points or ranges is picked. */
  const keepLayer = (clipId: string) => setSel(tlRef.current.connected.some((c) => c.id === clipId) ? { kind: 'layer', id: clipId } : null);
  const editClip = (patch: Partial<TimelineClip>, key: string) => clip && commit(updateClip(tlRef.current, clip.id, patch), `${key}:${clip.id}`);

  // Stabilising from the picture (clips without motion data): one file at a time.
  const [motionJob, setMotionJob] = useState<{ clipId: string; progress: number; abort: AbortController } | null>(null);
  const [motionNote, setMotionNote] = useState<{ clipId: string; text: string } | null>(null);
  const pictureMotion = async () => {
    const c0 = clip, m = c0 && mediaNow(c0.mediaPath);
    if (!c0 || !m || motionJob) return;
    const abort = new AbortController();
    setMotionNote(null);
    setMotionJob({ clipId: c0.id, progress: 0, abort });
    try {
      const r = await stabiliseFromPicture(m, c0.inUs, c0.outUs, (f) => setMotionJob((j) => (j ? { ...j, progress: f } : j)), abort.signal);
      // The clip as it is now (it may have changed meanwhile): reframed through its lens, smoothed.
      const t = tlRef.current, fresh = t.clips.find((x) => x.id === c0.id) ?? t.connected.find((x) => x.id === c0.id);
      if (fresh) {
        const c = adoptReframe(fresh);
        commit(updateClip(t, fresh.id, { lensMode: c.lensMode, look: c.look, keyframes: c.keyframes, stabilize: { ...fresh.stabilize, smoothing: fresh.stabilize.smoothing === 'off' ? 'medium' : fresh.stabilize.smoothing } }), `picture-motion:${fresh.id}`);
      }
      const share = r.frames ? r.lost / r.frames : 0;
      setMotionNote({ clipId: c0.id, text: share > 0.15 ? `Done, but ${Math.round(share * 100)}% of the frames had too little detail to follow (dark, blurred or blank), so it is steadied less there.` : 'Done: the shake was worked out from the picture.' });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMotionNote({ clipId: c0.id, text: `It couldn’t be worked out: ${(e as Error).message}` });
    } finally {
      setMotionJob(null);
    }
  };

  // Smart reframe: fits clips into the frame shape and keeps the action in view (one job at a time).
  const [reframeJob, setReframeJob] = useState<{ clipId: string | null; progress: number; abort: AbortController; label: string } | null>(null);
  const [reframeNote, setReframeNote] = useState<{ clipId: string; text: string } | null>(null);
  /** Reframes clips (by id) for `shape` (a frame shape label; missing = the project's). One undo step. */
  const runSmartReframe = async (ids: string[], shape?: string) => {
    if (reframeJob || !ids.length) return;
    const abort = new AbortController();
    const single = ids.length === 1 ? ids[0]! : null;
    setReframeNote(null);
    setReframeJob({ clipId: single, progress: 0, abort, label: shape ? `Reframing for ${shape}` : 'Smart reframe' });
    const framing = shape ?? tlRef.current.framing;
    const aspect = framingAspect(framing);
    const patches = new Map<string, Partial<TimelineClip>>();
    const notes: string[] = [];
    let done = 0;
    try {
      for (const id of ids) {
        const c = findClip(tlRef.current, id), m = c && mediaNow(c.mediaPath);
        if (!c || !m || c.mediaPath.startsWith('seq:')) { done++; continue; }
        const r = await smartReframe(c, m, aspect, (f) => setReframeJob((j) => (j ? { ...j, progress: (done + f) / ids.length } : j)), abort.signal);
        patches.set(id, r.patch);
        notes.push(noteOf(r));
        if (single) setReframeNote({ clipId: id, text: noteOf(r) });
        done++;
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(`Smart reframe stopped: ${(e as Error).message}`);
      else if (!patches.size) return;
    } finally {
      setReframeJob(null);
    }
    let t = tlRef.current;
    if (shape && t.framing !== shape) t = { ...t, framing: shape };
    for (const [id, patch] of patches) if (findClip(t, id)) t = updateClip(t, id, patch);
    commit(t, 'smart-reframe');
    if (!single) setNotice(`Reframed ${patches.size} clip${patches.size === 1 ? '' : 's'} for ${framing}. Each one’s keyframes can be changed in Reframe.`);
  };
  /** Saves the captions as an .srt file. */
  const saveSrt = async () => {
    const t = tlRef.current;
    if (!t.overlays.some((o) => o.caption)) { setNotice('There are no captions yet. Make them with AI tools → Auto subtitles.'); return; }
    const path = await ace.saveDialog('srt', `${projectName ?? 'Subtitles'}.srt`);
    if (!path) return;
    await ace.writeFile(path, toSrt(t));
    setNotice(`Saved the subtitles to ${baseName(path)}.`);
  };
  /** Every clip of the edit (main row and tracks), for reframing the whole project. */
  const allClipIds = () => [...tlRef.current.clips, ...tlRef.current.connected].filter((c) => !c.mediaPath.startsWith('seq:')).map((c) => c.id);

  /** The clip being edited at the playhead: a selected track clip, or else the main-row clip there. */
  const editingAt = (t: Timeline = tlRef.current, T = player.time): Located | null => {
    const s = selRef.current;
    const layer = s?.kind === 'layer' ? t.connected.find((c) => c.id === s.id) : undefined;
    return layer ? layerLocated(t, layer, T) : locate(t, T);
  };
  const editLook = (patchIn: Partial<Look>, key: string) => {
    let patch = patchIn;
    const cur = editingAt();
    if (!cur) return;
    // A regular clip from before reframing existed starts from its picture as recorded.
    const c = adoptReframe(cur.clip);
    const adopted: Partial<TimelineClip> = c === cur.clip ? {} : { lensMode: c.lensMode, look: c.look, keyframes: c.keyframes };
    // With a lens look kept while zooming, setting the fisheye sets the look (at this field of view).
    const look = lensLookOf(c);
    if (look && patch.fisheye !== undefined) {
      const { fisheye, ...restPatch } = patch;
      commit(updateClip(tlRef.current, c.id, { ...adopted, lensLook: { fov: patch.fov ?? ownLookAt(c, cur.mediaUs).fov, fisheye } }), `${key}:${c.id}`);
      if (!Object.keys(restPatch).length) return;
      patch = restPatch;
    }
    const own = ownLookAt(c, cur.mediaUs), now = clipLookAt(c, cur.mediaUs);
    /** Stores settings on the clip itself (or its keyframe here): never what tracking shows. */
    const store = (p: Partial<Look>): Partial<TimelineClip> => {
      const next = { ...own, ...p };
      // (A fisheye that follows the field of view isn't stored: the clip keeps its own.)
      if (look) next.fisheye = lookAt(c.keyframes, c.look, cur.mediaUs).fisheye;
      return c.keyframes.length ? { keyframes: setKeyframe(c.keyframes, cur.mediaUs, next, snapUs) } : { look: next };
    };
    const put = (p: Partial<TimelineClip>) => commit(updateClip(tlRef.current, c.id, { ...adopted, ...p }), `${key}:${c.id}`);
    const { yaw, pitch, fov, ...rest } = patch;
    const aimed = yaw !== undefined || pitch !== undefined || fov !== undefined;
    const w = c.track ? trackWeight(c.track, cur.mediaUs) : 0;
    // The lens may be bent by tracking: change our own by as much as was asked.
    if (rest.fisheye !== undefined && w > 0) rest.fisheye = Math.max(MIN_FISHEYE, Math.min(1, own.fisheye + (rest.fisheye - now.fisheye)));
    if (!c.track || w <= 0) { put(store(patch)); return; }
    const others = Object.keys(rest).length ? store(rest) : {};
    if (!aimed) { put(others); return; }
    const dy = yaw !== undefined ? ((yaw - now.yaw + 540) % 360) - 180 : 0;
    const dp = pitch !== undefined ? pitch - now.pitch : 0;
    const dz = fov !== undefined ? Math.log(fov / now.fov) : 0;
    // After a track that holds its last view, pan / tilt / zoom set the view it settles on.
    if (trackHeld(c.track, cur.mediaUs)) {
      const { end: _e, ...noEnd } = c.track;
      const base = c.track.end ?? clipLookAt({ ...c, track: noEnd }, cur.mediaUs + 60e6);
      const end = { yaw: ((base.yaw + dy + 540) % 360) - 180, pitch: Math.max(-90, Math.min(90, base.pitch + dp)), fov: Math.max(1, Math.min(360, base.fov * Math.exp(dz))) };
      put({ ...others, track: { ...c.track, end } });
      return;
    }
    // Mostly the clip's own view still (easing in or out): move that, by enough to show.
    if (w < 0.5) {
      put(store({ ...rest, yaw: ((own.yaw + dy / (1 - w) + 540) % 360) - 180, pitch: Math.max(-90, Math.min(90, own.pitch + dp / (1 - w))), fov: Math.max(1, Math.min(360, own.fov * Math.exp(dz / (1 - w)))) }));
      return;
    }
    // Following: pan / tilt move the framing around the subject, zoom sets how big it is kept.
    const track: ClipTrack = { ...c.track, offsetYaw: c.track.offsetYaw + dy / w, offsetPitch: Math.max(-90, Math.min(90, c.track.offsetPitch + dp / w)) };
    if (fov !== undefined) {
      if ((track.autoZoom ?? 0) > 0 && track.subjectFrac) {
        const target = Math.exp((Math.log(fov) - (1 - w) * Math.log(own.fov)) / w);
        track.subjectFrac = fracForFov(c.track, cur.mediaUs, target, look ? (f: number) => fisheyeForLook(look, f) : own.fisheye, shareOf(mediaNow(c.mediaPath), c)) ?? track.subjectFrac;
        // Zooming out past the limit moves the limit.
        if (target > (track.maxFov ?? DEFAULT_TRACK_MAX_FOV)) track.maxFov = Math.min(MAX_ZOOM_FOV, target);
      } else Object.assign(others, store({ ...rest, fov }));
    }
    put({ ...others, track });
  };
  const editGrade = (patch: Partial<Grade>, key: string) => {
    const cur = editingAt();
    if (!cur) return;
    editLook({ grade: { ...ownLookAt(cur.clip, cur.mediaUs).grade, ...patch } }, key);
  };

  const addKeyframe = () => {
    if (!clip || !at) return;
    // (The clip's own view, not where tracking has taken it.)
    editClip({ keyframes: setKeyframe(clip.keyframes, at.mediaUs, ownLookAt(clip, at.mediaUs), snapUs) }, 'addkey');
  };
  /** Deletes a keyframe. Removing the last one leaves the clip looking like it did there. */
  const deleteKeyframeById = (clipId: string, id: string) => {
    const c = findClip(tlRef.current, clipId);
    const k = c?.keyframes.find((x) => x.id === id);
    if (!c || !k) return;
    const rest = removeKeyframe(c.keyframes, id);
    commit(updateClip(tlRef.current, c.id, rest.length ? { keyframes: rest } : { keyframes: [], look: k.look }));
    setKfSel(null);
  };
  const deleteKeyframe = () => {
    const k = clip && at ? keyframeNear(clip.keyframes, at.mediaUs, snapUs) : undefined;
    if (clip && k) deleteKeyframeById(clip.id, k.id);
  };
  /** The keyframe picked on the timeline (for ⌫), as long as the playhead is still on it. */
  const [kfSel, setKfSel] = useState<{ clipId: string; id: string } | null>(null);
  const kfTime = (clipId: string, id: string) => {
    const spot = clipSpot(tlRef.current, clipId), c = spot?.clip;
    const k = c?.keyframes.find((x) => x.id === id);
    return spot && c && k ? mediaToTimeline(spot.startUs, c, Math.max(c.inUs, Math.min(c.outUs - 1, k.t))) : null;
  };
  const pickKeyframe = (clipId: string, id: string) => {
    keepLayer(clipId);
    setSpeedSel(null);
    setKfSel({ clipId, id });
    player.pause();
    const T = kfTime(clipId, id);
    if (T !== null) seek(T);
  };
  const pickedKf = () => {
    const T = kfSel && kfTime(kfSel.clipId, kfSel.id);
    return kfSel && T !== null && Math.abs(T - player.time) < 60_000 ? kfSel : null;
  };
  const dragKeyframe = (clipId: string, id: string, t: number) => {
    const c = findClip(tlRef.current, clipId);
    if (!c) return;
    const m = mediaNow(c.mediaPath), frame = m ? 1e6 / m.fps : 20_000;
    let to = Math.max(c.inUs, Math.min(c.outUs - frame, t));
    // Two keyframes can't share a frame: stop just short of the neighbour.
    const other = c.keyframes.find((k) => k.id !== id && Math.abs(k.t - to) < frame * 1.5);
    if (other) to = other.t + (to < other.t ? -1 : 1) * frame * 1.5;
    if (to < c.inUs || to > c.outUs || c.keyframes.some((k) => k.id !== id && Math.abs(k.t - to) < frame)) return;
    commit(updateClip(tlRef.current, clipId, { keyframes: moveKeyframe(c.keyframes, id, to) }), `kfmove:${id}`);
    const T = kfTime(clipId, id);
    if (T !== null && !player.playing) player.seek(T);
  };
  const jumpKey = (dir: -1 | 1) => {
    if (!clip || !at) return;
    const t = dir < 0 ? prevKeyTime(clip.keyframes, at.mediaUs) : nextKeyTime(clip.keyframes, at.mediaUs);
    if (t !== undefined) seek(mediaToTimeline(at.startUs, clip, Math.max(clip.inUs, Math.min(clip.outUs - 1, t))));
  };

  // --- Speed ---------------------------------------------------------------------------------------
  /** Changes a clip's speed, staying on the picture that is showing. */
  const changeSpeed = (clipId: string, patch: Parameters<typeof setClipSpeed>[2], key: string) => {
    // A clip on a track: it keeps its start, and can't run into the next clip on its track.
    const layer = tlRef.current.connected.find((c) => c.id === clipId);
    if (layer) {
      const next = setClipSpeed(tlRef.current, clipId, patch);
      const now = next.connected.find((c) => c.id === clipId)!;
      if (!trackFree(next, now.trackId, now.startUs, now.startUs + playLength(now), now.id)) {
        setNotice(`At that speed the clip would run into the next one on ${trackName(next, now.trackId)}. Move that one first.`);
        return;
      }
      const localBefore = player.time - layer.startUs;
      const m = localBefore >= 0 && localBefore < playLength(layer) ? mediaAt(layer, localBefore) : null;
      commit(next, `${key}:${clipId}`);
      if (m !== null && !player.playing) player.seek(now.startUs + localAt(now, m));
      return;
    }
    const before = locate(tlRef.current, player.time);
    const next = rippleItems(tlRef.current, setClipSpeed(tlRef.current, clipId, patch), clipId);
    commit(next, `${key}:${clipId}`);
    if (!before || player.playing) return;
    const i = next.clips.findIndex((c) => c.id === before.clip.id), c = next.clips[i];
    // (The length of this clip or one before it changed.)
    if (c) player.seek(mediaToTimeline(clipStarts(next)[i]!, c, before.mediaUs));
  };
  const [speedLines, setSpeedLines] = useState(() => { try { return localStorage.getItem('ace.speedLines') === 'true'; } catch { return false; } });
  const [jumpMarks, setJumpMarks] = useState(() => { try { return localStorage.getItem('ace.jumpMarks') !== 'false'; } catch { return true; } });
  const toggleJumpMarks = () => setJumpMarks((v) => { try { localStorage.setItem('ace.jumpMarks', String(!v)); } catch { /* private mode */ } return !v; });
  const [tool, setTool] = useState<EditTool>('select');
  const proBase = useRef<Timeline | null>(null);
  /** Roll, slip and slide always start from the timeline as it was when the drag began. */
  const proEdit = (kind: 'roll' | 'slip' | 'slide', id: string, d: number, phase: 'start' | 'move') => {
    if (phase === 'start' || !proBase.current) { proBase.current = tlRef.current; return; }
    const durOf = (path: string) => sourceDuration(tlRef.current, { mediaPath: path }, (p) => mediaNow(p)?.durationUs) ?? Infinity;
    const base = proBase.current;
    const next = kind === 'roll' ? rollCut(base, id, d, durOf).tl : kind === 'slip' ? slipClip(base, id, d, durOf) : slideClip(base, id, d, durOf);
    commit(next, `${kind}:${id}`);
    // While slipping, show the frame that's now at the playhead.
    player.invalidate();
  };
  const [snapping, setSnapping] = useState(() => { try { return localStorage.getItem('ace.snap') !== 'false'; } catch { return true; } });
  const toggleSnapping = () => setSnapping((v) => { try { localStorage.setItem('ace.snap', String(!v)); } catch { /* private mode */ } return !v; });
  const toggleSpeedLines = () => setSpeedLines((v) => { try { localStorage.setItem('ace.speedLines', String(!v)); } catch { /* private mode */ } return !v; });
  const [speedSel, setSpeedSel] = useState<{ clipId: string; id: string } | null>(null);
  const [speedMenu, setSpeedMenu] = useState<{ clipId: string; id: string; x: number; y: number } | null>(null);
  const clipById = (id: string) => findClip(tlRef.current, id);
  const pickSpeedPoint = (clipId: string, id: string) => { keepLayer(clipId); setKfSel(null); setSpeedSel({ clipId, id }); };
  const moveSpeedPoint = (clipId: string, id: string, t: number, speed: number) => {
    const c = clipById(clipId);
    if (c?.speedKeys) changeSpeed(clipId, { speedKeys: moveSpeedKey(c.speedKeys, id, t, speed, c.inUs, c.outUs) }, `speedpt-${id}`);
  };
  const addSpeedPoint = (clipId: string, t: number) => {
    const c = clipById(clipId);
    if (!c) return;
    const keys = setSpeedKey(c, t);
    // A point added to a clip at normal speed: slow sound is only kept down to half speed.
    changeSpeed(clipId, { speedKeys: keys, ...(hasRamp(c) || c.muteBelow !== undefined ? {} : { muteBelow: 0.5 }) }, 'speedadd');
    const k = speedKeyNear({ ...c, speedKeys: keys }, t);
    if (k) pickSpeedPoint(clipId, k.id);
  };
  const deleteSpeedPoint = (clipId: string, id: string) => {
    const c = clipById(clipId);
    if (c?.speedKeys) changeSpeed(clipId, removeSpeedKey(c, id), 'speeddel');
    setSpeedSel(null);
  };
  const pickedSpeed = speedSel && findClip(tl, speedSel.clipId)?.speedKeys?.some((k) => k.id === speedSel.id) ? speedSel : null;

  // --- Lens match ----------------------------------------------------------------------------------
  const [lensBusy, setLensBusy] = useState(false);
  const matchLensesNow = async (which?: 'front' | 'back') => {
    const cur = editingAt(), m = cur && mediaNow(cur.clip.mediaPath);
    if (!cur || !m || !hasTwoLenses(m) || lensBusy) return;
    setLensBusy(true);
    try {
      const r = await matchClipLenses(m, cur.clip, cur.mediaUs, which);
      if (!r) { setNotice('The lenses couldn’t be compared here: too little of the strip both of them see is lit and in view.'); return; }
      const now = findClip(tlRef.current, cur.clip.id);
      if (!now) return;
      if (!Object.keys(r.adjust).length || r.before - r.after < 0.5) { setNotice(`The lenses already match about as well as they can (they differ by ${r.before.toFixed(1)} of 255), so nothing was changed.`); return; }
      commit(updateClip(tlRef.current, now.id, { lenses: { [r.lens]: r.adjust as Record<string, number> } }));
      setLensUi({ lens: r.lens });
      setNotice(`Corrected the ${r.lens} lens: where both lenses see the same thing, the difference went from ${r.before.toFixed(1)} to ${r.after.toFixed(1)} of 255.`);
    } catch (e) {
      setError(`Lens match: ${e}`);
    } finally {
      setLensBusy(false);
    }
  };

  // --- Compound clips ---------------------------------------------------------------------------
  /** Opens a compound clip's timeline for editing (a breadcrumb leads back up). */
  const openCompound = (clipId: string) => {
    const t = tlRef.current;
    const c = findClip(t, clipId), q = c && findSequence(t, sequenceIdOf(c));
    if (!c || !q) return;
    player.pause();
    nestRef.current = [...nestRef.current, { id: q.id, name: q.name, outer: t, hist: hist.current, time: player.time }];
    setNest(nestRef.current.map((n) => ({ id: n.id, name: n.name })));
    hist.current = { past: [], future: [], lastKey: '', lastAt: 0 };
    const inner = sequenceTimeline(t, q);
    tlRef.current = inner;
    setTl(inner);
    setSel(null);
    seek(c.inUs);
  };
  /** Goes back up to `level` (0 = the main edit); changes made inside are one undo step there. */
  const leaveCompound = (level: number) => {
    while (nestRef.current.length > level) {
      const n = nestRef.current.pop()!;
      const back = storeSequence(n.outer, n.id, tlRef.current);
      hist.current = n.hist;
      if (JSON.stringify(back) !== JSON.stringify(n.outer)) { hist.current.past.push(n.outer); hist.current.future = []; }
      hist.current.lastKey = '';
      tlRef.current = back;
      setTl(back);
      if (nestRef.current.length === level) seek(n.time);
    }
    setNest(nestRef.current.map((n) => ({ id: n.id, name: n.name })));
    setSel(null);
  };
  /** Nests main-row clips `from`…`to` into a compound clip. */
  const compoundOf = (from: number, to: number) => {
    const r = makeCompound(tlRef.current, from, to);
    if (!r) return;
    commit(r.tl);
    setNotice('Made a compound clip. Double-click it to open it; right-click to break it apart.');
  };
  const renameSequence = (id: string, name: string) => {
    const t = tlRef.current;
    commit({ ...t, sequences: t.sequences?.map((q) => (q.id === id ? { ...q, name } : q)) }, `seqname:${id}`);
  };

  // --- Multicam ----------------------------------------------------------------------------------
  const [multicamOpen, setMulticamOpen] = useState(false);
  const [subtitlesOpen, setSubtitlesOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [multicamBusy, setMulticamBusy] = useState<string | null>(null);
  const makeMulticam = async (paths: string[], method: 'sound' | 'clock') => {
    try {
      setMulticamBusy(method === 'sound' ? 'Listening to each camera to line them up…' : 'Lining up by the cameras’ clocks…');
      const r = await syncAngles(paths, method, (f) => setMulticamBusy(`Lining up… ${Math.round(f * 100)}%`));
      const first = mediaNow(paths[0]!);
      const name = `Multicam ${(tlRef.current.multicams?.length ?? 0) + 1}`;
      const added = addMulticam(tlRef.current, r.angles, name, !!first?.is360);
      commit(added.tl);
      setMulticamOpen(false);
      const off = r.how.filter((h) => h === 'start').length, clock = r.how.filter((h) => h === 'clock').length;
      setNotice(`Made “${name}” at the end of the main row. Play it and press 1–${r.angles.length} (or click an angle above the timeline) to cut between cameras.${clock ? ` ${clock} camera${clock === 1 ? ' was' : 's were'} lined up by ${method === 'sound' ? 'clock (their sound didn’t match clearly)' : 'clock'}.` : ''}${off ? ` ${off} couldn’t be lined up and start${off === 1 ? 's' : ''} with the first; slip ${off === 1 ? 'its cuts' : 'their cuts'} (Y) to fix.` : ''}`);
    } catch (e) {
      setError(`Multicam: ${e}`);
    } finally {
      setMulticamBusy(null);
    }
  };
  /** Cuts to an angle at the playhead (the whole clip when the playhead is at its start). */
  const cutToAngle = (angle: number) => {
    const t = tlRef.current, T = player.time;
    const at = locate(t, T);
    if (!at || !at.clip.multicam || angle >= (groupOf(t, at.clip)?.angles.length ?? 0)) return false;
    if (at.clip.multicam.angle === angle) return true;
    const frame = 1e6 / (mediaNow(at.clip.mediaPath)?.fps ?? 30);
    const cut = T - at.startUs < frame * 1.5 ? t : splitAt(t, T);
    const i = cut === t ? at.index : at.index + 1;
    const target = cut.clips[i];
    const next = target ? switchAngle(cut, target.id, angle) : cut;
    if (next === cut) { setNotice(`Angle ${angle + 1} isn’t recording for the rest of this clip. Split where it stops first, or pick another angle.`); return true; }
    commit(next);
    return true;
  };

  /** The selected clip on V2–V6, if there is one (cuts act on it instead of the main row). */
  const selectedLayer = () => {
    const s = selRef.current;
    return s?.kind === 'layer' ? tlRef.current.connected.find((c) => c.id === s.id) ?? null : null;
  };
  /** Tells why a cut on a track clip did nothing. */
  const layerCutRefused = (c: ConnectedClip, T: number) => {
    const t = tlRef.current;
    if (t.tracks.find((x) => x.id === c.trackId)?.locked) setNotice(`${trackName(t, c.trackId)} is locked. Unlock it to change its clips.`);
    else if (T <= c.startUs || T >= c.startUs + playLength(c)) setNotice(`The playhead isn’t over the selected clip on ${trackName(t, c.trackId)}. Move it onto the clip first.`);
  };
  /** A selected text or gauge, cut at T instead of the video ('split', or trimmed to one side). */
  const cutOverlay = (T: number, how: 'split' | 'left' | 'right'): boolean => {
    const s = selRef.current;
    if (s?.kind !== 'overlay') return false;
    const t = tlRef.current;
    const o = t.overlays.find((x) => x.id === s.id);
    if (!o) return false;
    const next = how === 'split' ? splitOverlay(t, o.id, T) : trimOverlayAt(t, o.id, T, how);
    if (next === t) { setNotice(`Move the playhead inside the ${o.kind === 'text' ? 'text' : 'gauge'} to cut it there.`); return true; }
    commit(next);
    // After a split the right-hand piece stays selected, ready for the next cut.
    if (how === 'split') { const right = next.overlays.find((x) => x.startUs === T && !t.overlays.some((y) => y.id === x.id)); if (right) setSel({ kind: 'overlay', id: right.id }); }
    return true;
  };
  const split = (T = player.time) => {
    if (cutOverlay(T, 'split')) return;
    // A selected clip on a track above splits there; otherwise the main row does.
    const c = selectedLayer();
    if (c) {
      const next = splitConnected(tlRef.current, c.id, T);
      if (next === tlRef.current) layerCutRefused(c, T); else commit(next);
      return;
    }
    splitHere(T);
  };
  const deleteCurrent = () => {
    const t = tlRef.current;
    const s = selRef.current;
    const kf = pickedKf();
    if (!s && pickedSpeed) { deleteSpeedPoint(pickedSpeed.clipId, pickedSpeed.id); return; }
    if (!s && kf) { deleteKeyframeById(kf.clipId, kf.id); return; }
    if (s?.kind === 'audio') commit(removeAudio(t, s.id));
    else if (s?.kind === 'overlay') commit(removeOverlay(t, s.id));
    else if (s?.kind === 'transition') commit(updateClip(t, s.id, { transitionIn: undefined }));
    else if (s?.kind === 'layer') commit(trimEmptyTracks(removeConnected(t, s.id)));
    else if (clip) commit(removeClipRipple(t, clip.id));
    setSel(null);
  };

  /** Duplicates the clip being edited: a track clip goes on the lowest free track at the same time. */
  const duplicateCurrent = () => {
    if (!clip) return;
    const t = tlRef.current;
    if (layerSel) {
      const placed = placeConnected(t, { ...layerSel, id: newId('v') }, layerSel.startUs, layerSel.trackId);
      if (placed) { commit(placed.tl); setSel({ kind: 'layer', id: placed.id }); } else setNotice('Every video track is taken there. Remove a clip from V2–V6 first.');
      return;
    }
    commit(duplicateClip(t, clip.id));
  };
  /**
   * Puts the Media clip that is selected (or open in Source) on the lowest free track above the
   * main row at the playhead, like a connected clip. With nothing picked in Media, the main-row
   * clip under the playhead is copied there.
   */
  const connectToTrack = (path?: string) => {
    const t = tlRef.current;
    const from = path ?? source?.path;
    const base = from ? clipFor(from) : null;
    const piece = base && source && from === source.path ? { ...base, inUs: source.inUs ?? 0, outUs: source.outUs ?? base.outUs } : base;
    const T = sourceRef.current?.savedTime ?? player.time;
    const copy = piece ?? (locate(t, T)?.clip ? { ...locate(t, T)!.clip, transitionIn: undefined, audioDetached: false } : null);
    if (!copy || !t.clips.length) { setNotice('Put a clip on the main row first: clips above it are drawn over it.'); return; }
    const placed = placeConnected(t, { ...copy, id: newId('v') }, T);
    if (!placed) { setNotice('Every video track is taken at the playhead. Move or remove a clip on V2–V6 first.'); return; }
    commit(placed.tl);
    setSel({ kind: 'layer', id: placed.id });
    setNotice(`Added ${baseName(copy.mediaPath)} to ${trackName(placed.tl, placed.tl.connected.find((c) => c.id === placed.id)!.trackId)} at the playhead.`);
  };

  const selectClip = (id: string) => {
    setSel(null);
    setKfSel(null);
    setSpeedSel(null);
    const t = tlRef.current;
    const i = t.clips.findIndex((c) => c.id === id);
    const cur = locate(t, player.time);
    if (cur?.clip.id !== id && i >= 0) seek(clipStarts(t)[i]! + 1);
  };

  const step = (frames: number) => {
    player.pause();
    seek(player.time + (frames * 1e6) / (media?.fps ?? 30));
  };

  // --- Overlays, transitions, audio ------------------------------------------------------------
  const addText = () => {
    const t = tlRef.current;
    const total = timelineDuration(t);
    if (!t.clips.length) return;
    const T = Math.min(player.time, Math.max(0, total - 500_000));
    const o = newTextOverlay(T, Math.min(total, T + 4_000_000));
    commit({ ...t, overlays: [...t.overlays, o] });
    setSel({ kind: 'overlay', id: o.id });
  };
  const addTitle = (templateId: string) => {
    const t = tlRef.current;
    const total = timelineDuration(t);
    if (!t.clips.length) return;
    const tpl = TITLE_TEMPLATES.find((x) => x.id === templateId);
    // End cards go at the end; the rest at the playhead.
    const len = tpl?.id === 'end-credits' ? Math.min(12_000_000, total) : 4_000_000;
    const T = tpl?.category === 'end' ? Math.max(0, total - len) : Math.min(player.time, Math.max(0, total - 500_000));
    const o = newTitleOverlay(templateId, T, Math.min(total, T + len));
    commit({ ...t, overlays: [...t.overlays, o] });
    setSel({ kind: 'overlay', id: o.id });
  };
  const addGauge = (kind: GaugeKind) => {
    const t = tlRef.current;
    if (!t.clips.length) return;
    // With a clip on V2–V6 selected, the gauge shows that clip's ride data, while it plays.
    const l = selectedLayer();
    const total = timelineDuration(t);
    const o = l && l.startUs < total - 200_000
      ? { ...newGaugeOverlay(kind, l.startUs, Math.min(total, l.startUs + playLength(l))), sourceClipId: l.id }
      : newGaugeOverlay(kind, 0, total);
    commit({ ...t, overlays: [...t.overlays, o] });
    setSel({ kind: 'overlay', id: o.id });
  };
  /** A matching set of gauges in one design, over the whole edit. */
  const addGaugeSet = (design: GaugeDesign) => {
    const t = tlRef.current;
    if (!t.clips.length) return;
    const l = selectedLayer();
    const total = timelineDuration(t);
    const set = l && l.startUs < total - 200_000
      ? gaugeSet(design, l.startUs, Math.min(total, l.startUs + playLength(l))).map((o) => ({ ...o, sourceClipId: l.id }))
      : gaugeSet(design, 0, total);
    commit({ ...t, overlays: [...t.overlays, ...set] });
  };
  const gaugeDesignAll = (design: GaugeDesign) => {
    const t = tlRef.current;
    commit({ ...t, overlays: t.overlays.map((o) => (o.kind === 'text' ? o : { ...o, ...designFor(o.kind, design, o.style) })) });
  };
  const selectedOverlay = sel?.kind === 'overlay' ? tl.overlays.find((o) => o.id === sel.id) ?? null : null;
  const editOverlay = (patch: Partial<Overlay>, key: string) =>
    selectedOverlay && commit(updateOverlay(tlRef.current, selectedOverlay.id, patch), `${key}:${selectedOverlay.id}`);

  const openTransition = (clipId: string) => {
    const t = tlRef.current;
    const c = t.clips.find((x) => x.id === clipId);
    if (!c) return;
    if (!c.transitionIn) commit(updateClip(t, clipId, { transitionIn: { kind: 'crossfade', durationUs: 1_000_000 } }));
    setSel({ kind: 'transition', id: clipId });
  };
  const transitionClip = sel?.kind === 'transition' ? tl.clips.find((c) => c.id === sel.id) ?? null : null;
  const editTransition = (patch: Partial<Transition>, key: string) => {
    if (!transitionClip?.transitionIn) return;
    commit(updateClip(tlRef.current, transitionClip.id, { transitionIn: { ...transitionClip.transitionIn, ...patch } }), `${key}:${transitionClip.id}`);
  };

  const selectedAudio = sel?.kind === 'audio' ? tl.audio.find((a) => a.id === sel.id) ?? null : null;
  const detach = (clipId = clip?.id) => {
    const c = tlRef.current.clips.find((x) => x.id === clipId);
    if (!c) return;
    const next = detachAudio(tlRef.current, c.id);
    const a = next.audio.find((x) => x.linkedClipId === c.id);
    setBusy('Loading audio…');
    // Load the sound for the audio track before switching, so it keeps playing.
    void loadMusic(c.mediaPath)
      .then(() => {
        commit(next);
        if (a) setSel({ kind: 'audio', id: a.id });
      })
      .catch((e) => setError(`Audio: ${e}`))
      .finally(() => setBusy(null));
  };

  // --- Cutting at a point (toolbar, keyboard, right-click menu) ------------------------------------
  const splitHere = (T = player.time) => commit(splitAt(tlRef.current, T));
  const deleteSide = (side: 'left' | 'right', T = player.time) => {
    if (cutOverlay(T, side)) return;
    const t = tlRef.current;
    const c = selectedLayer();
    if (c) {
      const next = trimEmptyTracks(deleteSideConnected(t, c.id, T, side));
      if (next === t) { layerCutRefused(c, T); return; }
      commit(next);
      const now = next.connected.find((x) => x.id === c.id);
      if (now) seek(side === 'left' ? now.startUs + 1 : Math.max(now.startUs, T - 1));
      return;
    }
    const at = locate(t, T);
    if (!at) return;
    const cut = deleteSideAt(t, T, side);
    if (cut === t) return;
    // Text, gauges and clips above move with their pictures; those over the cut-away part go.
    const next = rippleItems(t, cut, at.clip.id);
    commit(next);
    setSel(null);
    // Land on the cut: the clip's new start (left) or its new end (right).
    const start = clipStarts(next)[at.index] ?? 0;
    seek(side === 'left' ? start + 1 : Math.max(start, T - 1));
  };
  const [kfMenu, setKfMenu] = useState<{ clipId: string; id: string; x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ clipId: string; T: number; x: number; y: number } | null>(null);
  const ctxClip = ctxMenu ? tl.clips.find((c) => c.id === ctxMenu.clipId) ?? null : null;
  const ctxLayer = ctxMenu ? tl.connected.find((c) => c.id === ctxMenu.clipId) ?? null : null;
  const ctxIndex = ctxClip ? tl.clips.indexOf(ctxClip) : -1;
  const ctxHasSound = !!(ctxClip && mediaNow(ctxClip.mediaPath)?.info.audioTracks.length);

  // --- Subject tracking ------------------------------------------------------------------------------
  const [trackPick, setTrackPick] = useState(false);
  /** The track clip being tracked (null = the main row). */
  const trackTarget = useRef<string | null>(null);
  const [trackBox, setTrackBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [trackJob, setTrackJob] = useState<{ progress: number; abort: AbortController } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Self-test only: make drawing fail, to check the app shows what to do instead of a blank window.
  const [crashTest, setCrashTest] = useState(false);
  if (crashTest) throw new Error('Self-test: drawing failed on purpose');
  const startTrackPick = () => {
    if (!clip || !media || !canReframe(media)) return setError('This clip can’t be reframed, so a subject can’t be followed.');
    player.pause();
    // A selected clip on V2–V6 is the one tracked; it stays selected.
    trackTarget.current = layerSel?.id ?? null;
    if (!layerSel) setSel(null);
    setTrackPick(true);
    setNotice('Drag a box around the subject on the preview (Esc to cancel).');
  };
  /** Box in preview pixels → start tracking from the frame on screen. */
  const runTracking = async (box: { x0: number; y0: number; x1: number; y1: number }) => {
    setTrackPick(false);
    setNotice(null);
    const res = lastResult.current;
    const frame = frameRef.current!;
    const W = frame.clientWidth, H = frame.clientHeight;
    if (!res?.layers) return;
    const target = trackTarget.current;
    const l = target ? res.layers.find((x) => x.clip.id === target) : res.layers[0];
    if (!l || !canReframe(l.media)) { if (target) setError('That clip isn’t on screen at the playhead, so its subject can’t be picked here.'); return; }
    const found = findClip(tlRef.current, l.clip.id);
    if (!found) return;
    if (target) {
      // The box was drawn on the frame: find it in the clip's own picture (it may be moved, scaled or turned).
      const xf = xfOf(clipLookAt(found, l.mediaUs));
      const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]].map(([x, y]) => frameToLayer(xf, W / H, x! / W, y! / H));
      const xs = corners.map((c) => c[0] * W), ys = corners.map((c) => c[1] * H);
      box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }
    const c = adoptReframe(found);
    const flat = clipLens(l.media, c);
    const startUs = l.frames[0]!.timestamp;
    const look = clipLookAt(c, startUs);
    const nx = (x: number) => (x / W) * 2 - 1, ny = (y: number) => 1 - (y / H) * 2;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const spot = (x: number, y: number) => flatDirection(c, l.media, look, startUs, W / H, nx(x), ny(y));
    const apart = (x0: number, y0: number, x1: number, y1: number) => {
      if (!flat) return angleBetween(look, W / H, [nx(x0), ny(y0)], [nx(x1), ny(y1)]);
      const a = spot(x0, y0)?.camera, b = spot(x1, y1)?.camera;
      return a && b ? (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI : 20;
    };
    const dir = flat ? spot(cx, cy)?.world : directionAt(look, W / H, nx(cx), ny(cy));
    if (!dir) return;
    const size = Math.max(apart(box.x0, cy, box.x1, cy), apart(cx, box.y0, cx, box.y1));
    const abort = new AbortController();
    setTrackJob({ progress: 0, abort });
    try {
      const out = await trackSubject({ clip: c, media: l.media, startUs, yaw: dir.yaw, pitch: dir.pitch, sizeDeg: Math.max(3, size), world: !!flat }, (f) => setTrackJob({ progress: f, abort }), abort.signal);
      if (out.points.length < 3) {
        setError('Couldn’t lock on to that subject — try a box that fits it more tightly.');
        return;
      }
      const t = tlRef.current;
      const now = findClip(t, c.id);
      if (!now) return;
      const cur = adoptReframe(now);
      // Keep any earlier tracking before this point (re-track from where it was lost).
      const kept = cur.track?.space === 'world' ? cur.track.points.filter((p) => p.t < startUs) : [];
      const track: ClipTrack = {
        space: 'world',
        points: [...kept, ...out.points],
        smoothing: cur.track?.smoothing ?? 0.25,
        offsetYaw: 0,
        offsetPitch: 0,
        ease: cur.track?.ease,
        after: cur.track?.after,
        from: kept.length ? cur.track?.from : undefined,
        // Auto zoom keeps the subject the size it was framed at when tracking started (or
        // bigger, if its closest moment wouldn't fit a normal lens at that size).
        autoZoom: cur.track?.autoZoom ?? 1,
        lens: cur.track?.lens,
        maxFov: cur.track?.maxFov,
      };
      // How big it was framed: the box, as a share of the picture.
      const share = shareOf(l.media, cur), bend = ownLookAt(cur, startUs).fisheye;
      let framed = flat ? share(Math.max(3, size), flatShot(c, l.media, look, startUs, W / H)!.fov, bend) : Math.max(box.x1 - box.x0, box.y1 - box.y0) / W;
      // A regular clip showing its whole picture has nowhere to move: zoom in enough to follow.
      if (flat && !cur.track?.subjectFrac) framed = Math.max(framed, share(Math.max(3, size), FOLLOW_ROOM * roomFov(cur, l.media), bend));
      track.subjectFrac = fitSubjectFrac(track, cur.track?.subjectFrac ?? framed, bend, share, flat ? Math.min(COMFORT_FOV, 0.8 * roomFov(cur, l.media)) : undefined);
      commit(updateClip(t, c.id, { track, ...(cur === now ? {} : { lensMode: cur.lensMode, look: cur.look, keyframes: cur.keyframes }) }));
      openSection('Subject tracking');
      const end = out.points.at(-1)!.t;
      if (out.cancelled) setNotice(`Tracking stopped at ${fmtTime(end)}. The path so far is kept.`);
      else if (out.lostAt !== undefined && out.left) setNotice(`The subject left the picture at ${fmtTime(out.lostAt)} (clip time). When it comes back, use Track subject again to continue.`);
      else if (out.lostAt !== undefined) setNotice(`Lost the subject at ${fmtTime(out.lostAt)} (clip time). Go there and use Track subject again to continue.`);
      else setNotice(`Tracked the subject to the end of the clip.`);
    } catch (e) {
      setError(`Tracking: ${e}`);
    } finally {
      setTrackJob(null);
    }
  };

  /** Uses only part of a clip's tracked path; shows the frame at the edge being moved. */
  const setClipTrackRange = (id: string, from: number, to: number, edge: 'from' | 'to') => {
    const t = tlRef.current;
    const spot = clipSpot(t, id);
    const c = spot?.clip;
    if (!spot || !c?.track) return;
    const track = setTrackRange(c.track, from, to);
    commit(updateClip(t, id, { track }), `track-range-${edge}:${id}`);
    const r = trackRange(track);
    if (!r || player.playing) return;
    const m = mediaNow(c.mediaPath);
    const at0 = Math.max(c.inUs, Math.min(c.outUs - (m ? 1e6 / m.fps : 20_000), edge === 'from' ? r[0] : r[1]));
    const T = mediaToTimeline(spot.startUs, c, at0);
    // (Under a transition the playhead belongs to the other clip: leave it alone then.)
    if (spot.layer || locate(t, T)?.clip.id === id) player.seek(T);
  };

  const runTrackingRef = useRef(runTracking);
  runTrackingRef.current = runTracking;

  // --- Files -------------------------------------------------------------------------------------
  /** Asks for a folder and points everything that used a missing file at the one found there. */
  const relinkMissing = async (folder?: string) => {
    const t = tlRef.current;
    const gone = [...new Set([...binRef.current.filter((b) => b.error === MISSING).map((b) => b.path), ...filesOf(flattenTimeline(t)).filter((p) => !mediaNow(p))])];
    if (!gone.length) return;
    const r = await ace.relink(gone.map((path) => ({ path, size: savedSizes.current.get(path) })), folder);
    if (!r) return;
    if (!r.matches.length) { setNotice(`None of the missing videos are in “${r.folder}”. Try another folder or card.`); return; }
    const to = new Map(r.matches.map((m) => [m.from, m.to]));
    for (const m of r.matches) forgetMedia(m.from);
    const meta = new Map(binRef.current.map((b) => [b.path, b]));
    setBin((b) => b.filter((x) => !to.has(x.path)));
    binRef.current = binRef.current.filter((x) => !to.has(x.path));
    await importPaths(r.matches.map((m) => m.to));
    setBin((b) => b.map((x) => { const from = r.matches.find((m) => m.to === x.path)?.from; const old = from && meta.get(from); return old ? { ...x, rating: old.rating, flag: old.flag, bin: old.bin } : x; }));
    const move = <X extends { clips: TimelineClip[]; connected: ConnectedClip[]; audio: AudioClip[] }>(x: X): X => ({ ...x, clips: x.clips.map((c) => (to.has(c.mediaPath) ? { ...c, mediaPath: to.get(c.mediaPath)! } : c)), connected: x.connected.map((c) => (to.has(c.mediaPath) ? { ...c, mediaPath: to.get(c.mediaPath)! } : c)), audio: x.audio.map((a) => (to.has(a.path) ? { ...a, path: to.get(a.path)! } : a)) });
    commit({ ...move(t), ...(t.sequences ? { sequences: t.sequences.map(move) } : {}) });
    player.invalidate();
    const left = gone.length - r.matches.length;
    setNotice(`Found ${r.matches.length} of ${gone.length} missing video${gone.length === 1 ? '' : 's'} in “${r.folder}”${r.matches.some((m) => m.how === 'size') ? ' (some under new names, recognised by size)' : ''}.${left ? ` ${left} still missing.` : ''}`);
  };
  const relinkRef = useRef(relinkMissing);
  relinkRef.current = relinkMissing;

  const restore = useCallback(async (text: string) => {
    const raw = JSON.parse(text) as Partial<Omit<SaveFile, 'library'>> & { library?: unknown } & Partial<Timeline>;
    const timeline = loadTimeline(raw.timeline ?? raw);
    const entries = libraryOf(raw.library);
    const used = filesOf(timeline);
    const library = [...new Set([...entries.map((e) => e.path), ...used])];
    // A file moved or deleted since it was last opened mustn't come back from memory.
    await Promise.all([...library, ...timeline.audio.map((a) => a.path)].map((p) => ace.stat(p).catch(() => forgetMedia(p))));
    // Saved by a version newer than this one: opens, but what it added isn't shown.
    const newer = (typeof (raw as { version?: unknown }).version === 'number' && (raw as { version: number }).version > 2) || (((raw.timeline as { version?: unknown } | undefined)?.version ?? 2) as number) > TIMELINE_VERSION;
    setBin([]);
    binRef.current = [];
    setBins(Array.isArray(raw.bins) ? raw.bins.filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string') : []);
    hist.current = { past: [], future: [], lastKey: '', lastAt: 0 };
    await importPaths(library);
    // What the user said about each item comes back with it.
    const meta = new Map(entries.map((e) => [e.path, e]));
    savedSizes.current = new Map(entries.flatMap((e) => (e.size ? [[e.path, e.size] as [string, number]] : [])));
    setBin((b) => b.map((x) => { const e = meta.get(x.path); return e ? { ...x, rating: e.rating, flag: e.flag, bin: e.bin } : x; }));
    // (A clip may use one chapter of a recording the bin now shows as a whole.)
    await Promise.all(used.map((p) => getMedia(p).catch(() => {})));
    await Promise.all([...timeline.audio, ...(timeline.sequences ?? []).flatMap((q) => q.audio)].map((a) => loadMusic(a.path).catch(() => {})));
    // Clips whose files are missing stay, shown as offline until relinked.
    nestRef.current = [];
    setNest([]);
    tlRef.current = timeline;
    setTl(tlRef.current);
    setSel(null);
    player.seek(0);
    const offline = new Set(used.filter((p) => !mediaNow(p)));
    if (offline.size) setNotice(offline.size === 1 ? `“${baseName([...offline][0]!)}” is missing: it was moved, renamed or deleted. Choose Relink in Media to find it.` : `${offline.size} videos are missing: they were moved, renamed or deleted. Choose Relink in Media to find them.`);
    if (!offline.size && newer) setNotice('This project was saved by a newer version of the app. It opened, but what that version added isn’t shown here.');
  }, [importPaths, player]);

  const saveObject = (): SaveFile => ({ version: 2, timeline: rootTimeline(), library: binRef.current.map((b) => ({ path: b.path, ...(b.rating ? { rating: b.rating } : {}), ...(b.flag ? { flag: b.flag } : {}), ...(b.bin ? { bin: b.bin } : {}), ...((b.media?.size ?? savedSizes.current.get(b.path)) ? { size: b.media?.size ?? savedSizes.current.get(b.path) } : {}) })), bins: binsRef.current });
  const saveText = () => JSON.stringify(saveObject());
  /** The last session (with which project it was), so the app reopens where you left off. */
  const sessionText = () => JSON.stringify({ ...saveObject(), project: projectRef.current ?? undefined });

  // --- Projects ----------------------------------------------------------------------------------
  // Once an edit is saved as a project, changes go into that file as you go (with the autosave).
  /** The project file this edit is saved in (null: not saved as a project yet). */
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const projectRef = useRef<string | null>(null);
  /** What was last written to the project file. */
  const lastSaved = useRef<string | null>(null);
  /** Saving to the project file failed: stop trying until the user saves again. */
  const saveFailed = useRef(false);
  const bindProject = (p: string | null, saved: string | null) => {
    projectRef.current = p;
    setProjectPath(p);
    lastSaved.current = saved;
    saveFailed.current = false;
  };
  const projectName = projectPath ? baseName(projectPath).replace(/\.acproj$/i, '') : null;
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const defaultProjectName = () => `Ride ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  /** For the Projects page: a picture, how many clips and how long. */
  /** A picture that lasts: the media thumbnails are blob: addresses, gone when the app quits. */
  const thumbCache = useRef(new Map<string, string>());
  const keptThumb = async (url: string): Promise<string | undefined> => {
    if (!url.startsWith('blob:')) return url;
    const hit = thumbCache.current.get(url);
    if (hit) return hit;
    try {
      // (Drawn through a canvas: the page's security rules allow blob: pictures, not fetching them.)
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = Math.min(320, img.naturalWidth), h = Math.round((img.naturalHeight / img.naturalWidth) * w);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d')!.drawImage(img, 0, 0, w, h);
      const data = c.toDataURL('image/jpeg', 0.82);
      thumbCache.current.set(url, data);
      return data;
    } catch { return undefined; }
  };
  const projectMeta = async (): Promise<ProjectMeta> => {
    const t = tlRef.current;
    const first = t.clips[0]?.mediaPath ?? binRef.current.find((b) => b.media)?.path;
    const live = first ? mediaNow(first)?.thumbnail ?? binRef.current.find((b) => b.path === first)?.media?.thumbnail : undefined;
    return { thumb: live ? await keptThumb(live) : undefined, clips: t.clips.length, durationUs: timelineDuration(t) };
  };
  /** Writes the edit to a project file (`path`), or to a new one called `name` in Projects. */
  const writeProject = async (o: { path?: string; name?: string }) => {
    const text = saveText();
    const where = await ace.projectsSave({ ...o, text, meta: await projectMeta() });
    bindProject(where, text);
    return where;
  };
  /** A message that goes away by itself. */
  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  };
  const isEmpty = () => { const t = tlRef.current; return !t.clips.length && !t.audio.length && !t.overlays.length; };
  /** Before leaving this edit: save it, or keep it in Projects if it was never saved. False if that failed. */
  const keepCurrent = async (): Promise<boolean> => {
    try {
      const p = projectRef.current;
      if (p) { if (saveText() !== lastSaved.current) await writeProject({ path: p }); return true; }
      if (isEmpty()) return true;
      const where = await writeProject({ name: defaultProjectName() });
      setNotice(`Your last edit was kept in Projects as “${baseName(where).replace(/\.acproj$/i, '')}”.`);
      return true;
    } catch (e) {
      setError(`Your edit couldn’t be saved, so it’s still open: ${e}`);
      return false;
    }
  };
  /** Swaps the edit for a project's contents and saves into that project from now on. */
  const loadProject = async (r: { path: string; text: string }) => {
    // (Unbound first: if opening fails half way, nothing gets written over the other project.)
    bindProject(null, null);
    setBusy('Opening project…');
    try {
      await restore(r.text);
      bindProject(r.path, saveText());
    } catch (e) {
      setError(`That project couldn’t be opened: ${e}`);
    } finally {
      setBusy(null);
    }
  };
  const openProjectAt = async (path: string) => {
    if (path === projectRef.current) { setProjectsOpen(false); return; }
    if (!(await keepCurrent())) return;
    setProjectsOpen(false);
    try { await loadProject(await ace.projectsOpen(path)); } catch (e) { setError(`That project couldn’t be opened: ${e}`); }
  };
  const newProject = async () => {
    if (!(await keepCurrent())) return;
    setProjectsOpen(false);
    bindProject(null, null);
    await restore('{}').catch((e) => setError(String(e)));
  };
  /** A project was renamed or removed on the Projects page. */
  const projectMoved = (from: string, to: string | null) => {
    if (from !== projectRef.current) return;
    if (to) { projectRef.current = to; setProjectPath(to); } else bindProject(null, null);
  };
  const saveNamed = async (name: string) => {
    setNaming(false);
    try { await writeProject({ name }); flash(`Saved to Projects.`); } catch (e) { setError(`The project couldn’t be saved: ${e}`); }
  };

  // Autosave: the session (so the app reopens where you left off) and the open project's file.
  const [selftest, setSelftest] = useState(false);
  const restored = useRef(false);
  useEffect(() => {
    // (Self-tests don't keep a session, but do save into an open project, to check it.)
    if (!restored.current && !selftest) return;
    const id = setTimeout(async () => {
      const text = saveText(), p = projectRef.current;
      if (!selftest) void ace.autosaveSave(sessionText());
      if (!p || text === lastSaved.current || saveFailed.current) return;
      void ace.projectsSave({ path: p, text, meta: await projectMeta() }).then(
        () => { if (projectRef.current === p) lastSaved.current = text; },
        (e) => { saveFailed.current = true; setError(`Changes to “${baseName(p).replace(/\.acproj$/i, '')}” couldn’t be saved: ${e}. Use Save project as to save it somewhere else.`); },
      );
    }, 800);
    return () => clearTimeout(id);
  });

  // Startup: restore the last session (or run the self-test).
  useEffect(() => {
    void ace.info().then(async (info) => {
      if (info.selftest) {
        setSelftest(true);
        const api: EditorApi = {
          importPaths,
          getTimeline: () => tlRef.current,
          setTimeline: (t) => commit(t),
          player,
          setShowRaw,
          nextRender: () => new Promise((res) => renderWaiters.current.push(res)),
          lastResult: () => lastResult.current,
          versions: info.versions,
          mode: info.selftestMode,
          trackBox: (box) => runTrackingRef.current(box),
          run: (cmd) => runRef.current[cmd]?.(),
          dropPaths: async (paths, at) => importFoundRef.current(await ace.importPaths(paths), at),
          saveText: () => saveTextRef.current(),
          restore: (text) => restoreRef.current(text),
          relink: (folder) => relinkRef.current(folder),
          crashForTest: () => setCrashTest(true),
        };
        void runSelftest(api);
        return;
      }
      const text = await ace.autosaveLoad();
      // A last session that can't be opened is kept aside, so the app always starts.
      if (text) {
        const ok = await restore(text).then(() => true, async (e) => { ace.logError('restore', String(e)); await ace.autosaveAside(); setError('Your last session couldn’t be opened, so the app started fresh. It was kept, not deleted.'); return false; });
        // Carry on saving into the project that was open (if it's still there).
        const p = ok ? (JSON.parse(text) as { project?: unknown }).project : undefined;
        if (typeof p === 'string' && (await ace.projectsList().catch(() => [])).some((x) => x.path === p)) bindProject(p, saveText());
      }
      restored.current = true;
    });
  }, [commit, importPaths, player, restore]);

  const openProject = async () => {
    const r = await ace.openProjectDialog();
    if (!r) return;
    if (r.path === projectRef.current) return;
    if (!(await keepCurrent())) return;
    setProjectsOpen(false);
    await loadProject(r);
  };
  /** Saves into the open project; the first time, asks for a name and puts it in Projects. */
  const saveProject = async () => {
    const p = projectRef.current;
    if (!p) { setNaming(true); return; }
    try { await writeProject({ path: p }); flash('Saved.'); } catch (e) { setError(`The project couldn’t be saved: ${e}. Use Save project as to save it somewhere else.`); }
  };
  /** Saves wherever the user chooses, and keeps saving there. */
  const saveProjectAs = async () => {
    const path = await ace.saveDialog('project', `${projectName ?? defaultProjectName()}.acproj`);
    if (!path) return;
    try { await writeProject({ path }); flash('Saved.'); } catch (e) { setError(`The project couldn’t be saved: ${e}`); }
  };
  const importDialog = async () => importFound(await ace.openMediaDialog());
  /**
   * Brings in what a dialog or a drop found: videos to the media bin, sound to the music track.
   * Dropped on the timeline (at time `at`), the videos also go onto it there, in order.
   */
  const importFound = async (found: FoundMedia, at?: number) => {
    const { video, audio, skipped } = found;
    if (skipped.length) {
      const why = [...new Set(skipped.map((x) => x.why))];
      setNotice(skipped.length === 1 ? `“${skipped[0]!.name}” wasn’t imported: ${skipped[0]!.why}.` : `${skipped.length} items weren’t imported (${why.join('; ')}).`);
    } else if ([...video, ...audio].some(cardOf)) setNotice('These files are on a memory card, so they stop working when it’s taken out. “Import from memory card” copies them to the computer.');
    else if (!video.length && !audio.length) setNotice('Nothing there could be imported: videos (.360, .mp4, .mov) and sound (.mp3, .m4a, .wav…) can.');
    const paths = video.length ? await importPaths(video) : [];
    if (at !== undefined && paths.length) {
      const t = tlRef.current, d = timelineDuration(t);
      const hit = d > 0 ? locate(t, Math.min(at, d - 1)) : null;
      let index = hit ? hit.index + (at > hit.startUs + clipDuration(hit.clip) / 2 ? 1 : 0) : t.clips.length;
      if (at >= d) index = t.clips.length;
      for (const p of paths) if (mediaNow(p)) addToTimeline(p, index++);
    }
    if (audio.length) await addMusicPaths(audio, at);
  };
  const importFoundRef = useRef(importFound);
  importFoundRef.current = importFound;
  // Opened with the app from Finder / Explorer.
  const restoreRef = useRef(restore);
  const saveTextRef = useRef(saveText);
  saveTextRef.current = saveText;
  restoreRef.current = restore;
  const openedRef = useRef(async (_p: { path: string; text: string }) => {});
  openedRef.current = async (p) => { if (p.path !== projectRef.current && (await keepCurrent())) { setProjectsOpen(false); await loadProject(p); } };
  useEffect(() => {
    ace.onOpenMedia((f) => { setWelcome(false); void importFoundRef.current(f); });
    ace.onOpenProject((p) => { setWelcome(false); void openedRef.current(p); });
  }, []);
  // --- Files dragged in from the desktop ---------------------------------------------------------
  const [dropZone, setDropZone] = useState<null | 'app' | 'timeline'>(null);
  const dropAtRef = useRef<(x: number) => number | undefined>(() => undefined);
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const zone = (e: DragEvent) => ((e.target as Element | null)?.closest?.('.timeline-wrap') ? 'timeline' : 'app') as 'timeline' | 'app';
    let depth = 0;
    const enter = (e: DragEvent) => { if (!files(e)) return; depth++; setDropZone(zone(e)); };
    const over = (e: DragEvent) => { if (!files(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; setDropZone(zone(e)); };
    const leave = (e: DragEvent) => { if (!files(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDropZone(null); };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setDropZone(null);
      const paths = ace.pathsOf([...e.dataTransfer!.files]);
      if (!paths.length) return;
      const at = zone(e) === 'timeline' ? dropAtRef.current(e.clientX) : undefined;
      void ace.importPaths(paths).then((f) => importFound(f, at), (err) => setError(String(err)));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  });
  // --- Memory cards ------------------------------------------------------------------------------
  const [cardOpen, setCardOpen] = useState(false);
  const [cardFound, setCardFound] = useState<string | null>(null);
  const cardRun = useCards((s) => s.run), cards = useCards((s) => s.cards);
  useEffect(() => startCards((c) => setCardFound(c.root), (paths) => void importPaths(paths)), [importPaths]);
  useEffect(() => { if (cardOpen) { setCardFound(null); setNotice(null); } }, [cardOpen]);
  const foundCard = cards.find((c) => c.root === cardFound);
  const importing = running(cardRun);
  // An import that ends while its window is closed says so.
  const wasImporting = useRef(false);
  useEffect(() => {
    if (wasImporting.current && cardRun?.ended && !cardOpen) {
      const done = [...cardRun.states.values()].filter((x) => x.state === 'done').length, bad = cardRun.ids.length - done;
      if (cardRun.ended.error || (bad && !cardRun.ended.stopped)) setError(`Import: ${cardRun.ended.error ?? `${bad} recording${bad === 1 ? '' : 's'} couldn’t be copied.`} ${done} of ${cardRun.ids.length} imported.`);
      else if (!cardRun.ended.stopped) setNotice(`${done} recording${done === 1 ? '' : 's'} imported. The card can be taken out.`);
    }
    wasImporting.current = importing;
  }, [cardRun, importing, cardOpen]);
  const addMusic = async () => addMusicPaths(await ace.openAudioDialog());
  const addMusicPaths = async (paths: string[], at?: number) => {
    for (const p of paths) {
      try {
        setBusy(`Loading ${baseName(p)}…`);
        const m = await loadMusic(p);
        const t = tlRef.current;
        const start = at ?? (t.audio.length ? player.time : 0);
        const a = newAudioClip(p, m.durationUs, start);
        commit({ ...t, audio: [...t.audio, a] });
        setSel({ kind: 'audio', id: a.id });
      } catch (e) {
        setError(`${baseName(p)}: ${e}`);
      } finally {
        setBusy(null);
      }
    }
  };
  const loadLutFile = async () => {
    const p = await ace.openLutDialog();
    if (!p) return;
    try {
      parseCube(new TextDecoder().decode(await ace.readAll(p)));
      commit({ ...tlRef.current, lutPath: p });
    } catch (e) {
      setError(`LUT: ${e}`);
    }
  };
  const frameGrab = async () => {
    const res = lastResult.current;
    if (!res?.layers) return;
    const path = await ace.saveDialog('image', `${baseName(res.media.path).replace(/\.\w+$/, '')} ${fmtTime(res.mediaUs).replace(/[:.]/g, '-')}.jpg`);
    if (!path) return;
    setBusy('Saving frame…');
    try {
      await grabFrame(tlRef.current, player.time, res.layers, path);
    } catch (e) {
      setError(`Frame grab: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  // --- Full screen ---------------------------------------------------------------------------------
  const viewerRef = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const h = () => setFullscreen(document.fullscreenElement === viewerRef.current);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  /** Just the preview and playback controls, filling the screen. */
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void viewerRef.current?.requestFullscreen().catch((e) => setError(`Full screen: ${e}`));
  };

  // --- First launch: welcome screen and tour -----------------------------------------------------
  const [welcome, setWelcome] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [appName, setAppName] = useState('Action Cam Editor');
  useEffect(() => {
    void ace.info().then((info) => {
      if (info.name) setAppName(info.name);
      // (Self-tests start from a clean slate; only the tour's own test shows it.)
      if (!getPrefs().welcomed && (!info.selftest || info.selftestMode === 'tour')) setWelcome(true);
    });
  }, []);
  const closeWelcome = () => { setWelcome(false); if (!getPrefs().welcomed) setPrefs({ welcomed: true }); };

  // --- Updates -----------------------------------------------------------------------------------
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' });
  /** Show what a check finds (a check the user asked for, or a newer version found in the background). */
  const [updateShown, setUpdateShown] = useState(false);
  useEffect(() => {
    void ace.updateState().then(setUpdate);
    ace.onUpdate((s) => { setUpdate(s); if (s.state === 'ready') setUpdateShown(true); });
  }, []);
  const checkUpdates = async () => {
    setUpdateShown(true);
    const s = await ace.updateCheck();
    if (s.state === 'current') flash(`You have the newest version (${s.version}).`);
    else if (s.state === 'error') { setUpdateShown(false); setError(s.message); }
  };
  /** Saves everything, then quits and installs the new version (the app opens again by itself). */
  const restartToUpdate = async () => {
    try {
      const p = projectRef.current;
      if (p && saveText() !== lastSaved.current) await writeProject({ path: p });
      await ace.autosaveSave(sessionText());
    } catch (e) {
      setError(`Your edit couldn’t be saved, so the app didn’t restart: ${e}`);
      return;
    }
    const why = await ace.updateInstall();
    if (why) setError(why);
  };

  // --- Keyboard ----------------------------------------------------------------------------------
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [customize, setCustomize] = useState<CustomizePage | null>(null);
  const arranging = useArranging();
  const shortcuts = usePrefs((p) => p.shortcuts);
  const togglePanel = (ids: string[]) =>
    setPrefs((p) => {
      const open = ids.filter((id) => openPanels(p.layout).includes(id));
      return { layout: open.length ? open.reduce(closePanel, p.layout) : ids.reduce(reopenPanel, p.layout) };
    });
  const toggleDetach = () => (clip?.audioDetached ? commit(reattachAudio(tlRef.current, clip.id)) : clip && detach());
  /** What each command does (menu bar, toolbars and shortcuts all use these). */
  const run: Record<string, () => void> = {
    shuttleBack: () => shuttleTo(-1), shuttleStop: () => { stopShuttle(); player.pause(); }, shuttleFwd: () => shuttleTo(1),
    play: togglePlay, prevFrame: () => step(-1), nextFrame: () => step(1), back10: () => step(-10), fwd10: () => step(10), start: () => seek(0), end: () => seek(timelineDuration(tlRef.current)), fullscreen: () => { if (tlRef.current.clips.length) toggleFullscreen(); },
    split: () => split(), delLeft: () => deleteSide('left'), delRight: () => deleteSide('right'), keyframe: () => { if (player.playing || shuttle.current.dir) { stopShuttle(); player.pause(); } else addKeyframe(); }, delKey: deleteKeyframe, prevKey: () => jumpKey(-1), nextKey: () => jumpKey(1), text: addText, titles: () => addTitle("lt-bar"), track: startTrackPick, detach: toggleDetach,
    duplicate: duplicateCurrent, delete: deleteCurrent, undo, redo, connect: connectToTrack,
    import: () => void importDialog(), card: () => setCardOpen(true), music: () => void addMusic(), open: () => void openProject(), save: () => void saveProject(), saveAs: () => void saveProjectAs(), newProject: () => void newProject(), projects: () => { setWelcome(false); setProjectsOpen((v) => !v); }, export: () => {
      if (!tlRef.current.clips.length) return;
      const missing = [...new Set(filesOf(flattenTimeline(rootTimeline())).filter((p) => !mediaNow(p)).map(baseName))];
      if (missing.length) { setError(`Can’t export yet: ${missing.length === 1 ? `“${missing[0]}” is` : `${missing.length} videos are`} missing. Relink ${missing.length === 1 ? 'it' : 'them'} in Media first.`); return; }
      setExportOpen(true);
    }, grab: () => void frameGrab(),
    customize: () => setCustomize((v) => (v ? null : 'themes')), arrange: () => { setArranging(!isArranging()); setCustomize(null); }, undoUi: undoPrefs, toggleMedia: () => togglePanel(['media']),
    toggleInspector: () => togglePanel(['reframe', 'stabilize', 'color', 'effects', 'clip', 'selection']), toggleTimeline: () => togglePanel(['timeline']), compare: () => setCompare(true), sections: toggleAllSections, speedline: toggleSpeedLines, jumps: toggleJumpMarks, snap: toggleSnapping, source: () => { const p = binRef.current.find((b) => b.media)?.path; if (sourceRef.current) closeSource(); else if (p) openSource(p); }, markIn: () => markSource('inUs'), markOut: () => markSource('outUs'), insertEdit: () => placeSource('insert'), overwriteEdit: () => placeSource('overwrite'), toolSelect: () => setTool('select'), toolRoll: () => setTool('roll'), toolSlip: () => setTool('slip'), toolSlide: () => setTool('slide'), shortcuts: () => setShortcutsOpen(true), report: () => setReportOpen(true), tour: () => { setWelcome(false); setTourOpen(true); }, welcome: () => { setProjectsOpen(false); setWelcome(true); }, checkUpdates: () => void checkUpdates(),
    marker: () => { const r = addMarker(tlRef.current, player.time); commit(r.tl); },
    delMarker: () => { const m = markerNear(tlRef.current, player.time, 500_000); if (m) commit(removeMarker(tlRef.current, m.id)); },
    multicam: () => setMulticamOpen(true),
    subtitles: () => setSubtitlesOpen(true),
    saveSrt: () => void saveSrt(),
    aiModels: () => setModelsOpen(true),
    angle1: () => void cutToAngle(0), angle2: () => void cutToAngle(1), angle3: () => void cutToAngle(2), angle4: () => void cutToAngle(3),
    prevMarker: () => { const m = [...tlRef.current.markers].reverse().find((x) => x.t < player.time - 1000); if (m) seek(m.t); },
    nextMarker: () => { const m = tlRef.current.markers.find((x) => x.t > player.time + 1000); if (m) seek(m.t); },
    markersPanel: () => togglePanel(['markers']),
    scopesPanel: () => togglePanel(['scopes']),
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    ace.onCommand((cmd) => {
      // Undo in a text field undoes the typing, not the edit.
      if ((cmd === 'undo' || cmd === 'redo') && isTextEntry(document.activeElement as HTMLElement)) { document.execCommand(cmd); return; }
      if (cmd === 'compare') { setCompare((v) => !v); return; }
      runRef.current[cmd]?.();
    });
    ace.onWindowFullscreen((on) => { document.documentElement.dataset.winfull = on ? 'on' : 'off'; });
    onNativeTheme((o) => void ace.setWindow(o));
  }, []);

  const matcher = useRef(new KeyMatcher());
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    const typing = isTextEntry(el);
    // Space is always play/pause unless you are typing. Handled before anything else so a
    // focused button, checkbox or slider never receives it.
    const sheet = projectsOpen || naming;
    if (e.code === 'Space' && !typing && !cardOpen && !sheet) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keydown' && !e.repeat) togglePlay();
      return;
    }
    if (e.type === 'keyup') { matcher.current.release(e).forEach((c) => c !== 'compare' && run[c]?.()); setCompare(false); return; }
    if (typing) return;
    // Behind the import window, keys must not edit the timeline.
    if (cardOpen) { if (e.key === 'Escape') setCardOpen(false); return; }
    // (The Projects page and its sheets handle their own keys; ⌘⇧P still closes it.)
    if (sheet) { if (commandFor(comboFromEvent(e), shortcuts) === 'projects' && !naming) { e.preventDefault(); setProjectsOpen(false); } return; }
    if (e.key === 'Escape') {
      if (isArranging()) { setArranging(false); return; }
      if (customize) { setCustomize(null); return; }
      if (drawingMask) { setDrawingMask(false); drawPts.current = null; setNotice(null); return; }
      setShortcutsOpen(false); setCtxMenu(null); setSel(null); setTrackPick(false); setTrackBox(null); setNotice(null); setMaskSel(null);
      return;
    }
    // Sliders keep their own arrow, Home and End keys.
    const { mods, key: pressed } = keyOf(e);
    const slider = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range';
    if (slider && /^(Arrow\w+|Home|End)$/.test(pressed) && !mods.includes('Mod') && !mods.includes('Alt')) return;
    const r = matcher.current.press(e, shortcuts, performance.now());
    if (r.known) e.preventDefault();
    r.run.forEach((c) => run[c]?.());
    if (r.wait) setTimeout(() => matcher.current.flush(performance.now()).forEach((c) => runRef.current[c]?.()), Math.max(0, r.wait - performance.now()) + 5);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    // Capture phase: runs before the focused element's own key handling.
    window.addEventListener('keydown', h, true);
    window.addEventListener('keyup', h, true);
    const lost = () => { matcher.current.reset(); setCompare(false); };
    window.addEventListener('blur', lost);
    return () => {
      window.removeEventListener('blur', lost);
      window.removeEventListener('keydown', h, true);
      window.removeEventListener('keyup', h, true);
    };
  }, []);

  // --- Pointer on the preview: move overlays, or look around ---------------------------------------
  const drag = useRef<{ kind: 'look'; x: number; y: number; look: Look } | { kind: 'overlay'; x: number; y: number; o: Overlay } | { kind: 'layer'; x: number; y: number; xf: Transform }
    | { kind: 'mask'; clipId: string; id: string; t: number; u: number; v: number; x: number; y: number; xf: Transform | undefined } | { kind: 'drawmask' } | null>(null);
  /** The topmost clip on a track above the main row under a preview point (fractions of the frame). */
  const layerUnder = (fx: number, fy: number) => {
    const st = stackAt(tlRef.current, player.time);
    if (!st) return null;
    for (const l of [...st.layers].reverse()) {
      if (l.track === 0) break;
      if (tlRef.current.tracks[l.track - 1]?.locked) continue;
      const lk = clipLookAt(l.clip, l.mediaUs), xf = xfOf(lk);
      const shown = shownXf(l.clip, mediaNow(l.clip.mediaPath), lk, aspect) ?? xf;
      if (xf.opacity > 0.02 && hitsLayer(shown, fx, fy, aspect)) return { clip: l.clip, xf };
    }
    return null;
  };
  /** A regular video at the playhead moves and sizes as a picture when dragged or scrolled on the preview (its transform), as in other editors. */
  const pictureAt = () => {
    const cur = editingAt(), m = cur && mediaNow(cur.clip.mediaPath);
    if (!cur || !m || m.is360 || (cur.clip.track && trackWeight(cur.clip.track, cur.mediaUs) > 0)) return null;
    return xfOf(clipLookAt(cur.clip, cur.mediaUs));
  };
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  /** Alignment lines shown while dragging text or a gauge on the picture. */
  const [guides, setGuides] = useState<Guides | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Masks: drawing a freehand one, or dragging the selected one.
    if (drawingMask || maskSel) {
      const fr = frameRef.current!.getBoundingClientRect();
      const fx = (e.clientX - fr.left) / fr.width, fy = (e.clientY - fr.top) / fr.height;
      if (drawingMask) {
        drawPts.current = [[fx, fy]];
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { kind: 'drawmask' };
        return;
      }
      const sc = maskScene();
      const place = sc?.places.find((p) => p.mask.id === maskSel);
      if (sc && place) {
        const [u, v] = frameToLayer(sc.look.xf, aspect, fx, fy);
        if (insidePolygon(maskOutline(place.mask, place.pose, aspect, place.centre), u, v)) {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { kind: 'mask', clipId: sc.cur.clip.id, id: place.mask.id, t: sc.cur.mediaUs, u, v, x: place.pose.x, y: place.pose.y, xf: sc.look.xf };
          return;
        }
      }
    }
    if (trackPick) {
      const r = frameRef.current!.getBoundingClientRect();
      boxStart.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      setTrackBox({ x0: boxStart.current.x, y0: boxStart.current.y, x1: boxStart.current.x, y1: boxStart.current.y });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    const c = overlayRef.current!;
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width;
    const hit = hitOverlay(tlRef.current, player.time, c.width, c.height, (e.clientX - r.left) * sx, (e.clientY - r.top) * sx);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (hit) {
      setSel({ kind: 'overlay', id: hit.id });
      drag.current = { kind: 'overlay', x: e.clientX, y: e.clientY, o: hit };
      return;
    }
    // A clip over the main row: select it; dragging moves it.
    const over = layerUnder((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (over) {
      if (selRef.current?.kind !== 'layer' || selRef.current.id !== over.clip.id) { setSel({ kind: 'layer', id: over.clip.id }); selRef.current = { kind: 'layer', id: over.clip.id }; }
      drag.current = { kind: 'layer', x: e.clientX, y: e.clientY, xf: over.xf };
      return;
    }
    if (sel?.kind === 'overlay' || sel?.kind === 'layer') { setSel(null); selRef.current = null; }
    // A regular clip moves as a picture, as in other editors (unless subject tracking aims it here).
    const picture = pictureAt();
    if (picture) { drag.current = { kind: 'layer', x: e.clientX, y: e.clientY, xf: picture }; return; }
    if (look && media && canReframe(media)) drag.current = { kind: 'look', x: e.clientX, y: e.clientY, look };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (trackPick && boxStart.current) {
      const r = frameRef.current!.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, e.clientX - r.left)), y = Math.max(0, Math.min(r.height, e.clientY - r.top));
      setTrackBox({ x0: Math.min(boxStart.current.x, x), y0: Math.min(boxStart.current.y, y), x1: Math.max(boxStart.current.x, x), y1: Math.max(boxStart.current.y, y) });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const r = overlayRef.current!.getBoundingClientRect();
    if (d.kind === 'drawmask') {
      const p: [number, number] = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      const last = drawPts.current?.[drawPts.current.length - 1];
      if (drawPts.current && last && Math.hypot((p[0] - last[0]) * aspect, p[1] - last[1]) > 0.004) drawPts.current.push(p);
      return;
    }
    if (d.kind === 'mask') {
      const [u, v] = frameToLayer(d.xf, aspect, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      const c = findClip(tlRef.current, d.clipId), m = c?.masks?.find((x) => x.id === d.id);
      if (c && m) setClipMasks(c.id, c.masks!.map((x) => (x.id === d.id ? setMaskPose(x, d.t, { x: d.x + u - d.u, y: d.y + v - d.v }) : x)), 'mask-drag');
      return;
    }
    if (d.kind === 'layer') {
      // Lines up with the centre when close to it.
      const near = (v: number) => (Math.abs(v) < 0.012 ? 0 : v);
      editLook({ xf: cleanXf({ ...d.xf, x: near(d.xf.x + (e.clientX - d.x) / r.width), y: near(d.xf.y + (e.clientY - d.y) / r.height) }) }, 'xf-drag');
      return;
    }
    if (d.kind === 'overlay') {
      let x = Math.max(0, Math.min(1, d.o.x + (e.clientX - d.x) / r.width));
      let y = Math.max(0, Math.min(1, d.o.y + (e.clientY - d.y) / r.height));
      // Smart guides: lines up with the middle, the safe margins and the other items on screen
      // (hold ⌘ to place freely, as on the timeline).
      if (!e.metaKey && !e.ctrlKey) {
        const W = r.width, H = r.height;
        const frac = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H });
        const others = tlRef.current.overlays.filter((o) => o.id !== d.o.id && overlayState(o, player.time)).map((o) => frac(overlayBox(o, W, H)));
        const a = alignBox(frac(overlayBox({ ...d.o, x, y }, W, H)), others, 6 / W, 6 / H);
        x += a.dx; y += a.dy;
        setGuides(a.guides.v.length || a.guides.h.length ? a.guides : null);
      } else setGuides(null);
      commit(updateOverlay(tlRef.current, d.o.id, { x, y }), `ov-move:${d.o.id}`);
      return;
    }
    const flat = clip && media ? clipLens(media, clip) : null;
    // Regular clips: the field of view spans the picture, of which the output may show a part.
    const across = flat ? Math.min(1, aspect / (media!.width / media!.height)) : 1;
    const degPerPx = (Math.min(d.look.fov, 120) * across) / r.width;
    let yaw = d.look.yaw - (e.clientX - d.x) * degPerPx;
    yaw = ((yaw + 540) % 360) - 180;
    const pitch = Math.max(-90, Math.min(90, d.look.pitch + (e.clientY - d.y) * degPerPx));
    // Past the edge of a regular clip's picture the view zooms in; stop before that gets silly.
    if (flat && clip && media && clip.fit === 'fill' && !(clip.track && at && trackWeight(clip.track, at.mediaUs) > 0) && shownFov(adoptReframe(clip), media, { ...d.look, yaw, pitch }, aspect) < d.look.fov * 0.4) return;
    editLook({ yaw, pitch }, 'drag');
  };
  const onWheel = (e: React.WheelEvent) => {
    // The selected mask: scrolling resizes it.
    if (maskSel) {
      const cur = editingAt(), m = cur?.clip.masks?.find((x) => x.id === maskSel);
      if (cur && m) {
        const pz = maskPoseAt(m, cur.mediaUs), k = Math.exp(-e.deltaY * 0.0015);
        setClipMasks(cur.clip.id, cur.clip.masks!.map((x) => (x.id === m.id ? setMaskPose(x, cur.mediaUs, { w: pz.w * k, h: pz.h * k }) : x)), 'mask-wheel');
        return;
      }
    }
    // A selected clip over the main row: scrolling resizes it.
    if (layerSel && look) {
      const xf = xfOf(look);
      editLook({ xf: cleanXf({ ...xf, scale: xf.scale * Math.exp(-e.deltaY * 0.0015) }) }, 'xf-wheel');
      return;
    }
    if (selectedOverlay) {
      editOverlay({ size: Math.max(0.02, Math.min(1, selectedOverlay.size * Math.exp(-e.deltaY * 0.0015))) }, 'ov-size');
      return;
    }
    const xf = pictureAt();
    if (xf) {
      editLook({ xf: cleanXf({ ...xf, scale: xf.scale * Math.exp(-e.deltaY * 0.0015) }) }, 'xf-wheel');
      return;
    }
    if (!look || !media || !clip || !canReframe(media)) return;
    const flat = clipLens(media, clip);
    const max = !flat ? 360 : clip.lensMode === 'custom' ? 170 : flat.hfov;
    editLook({ fov: Math.max(flat ? 3 : 1, Math.min(max, look.fov * Math.exp(e.deltaY * 0.0015))) }, 'wheel');
  };

  // --- Toolbar items -------------------------------------------------------------------------------
  const [pps, setPps] = useState(60); // timeline zoom, pixels per second
  const key = (id: string) => { const c = combosOf(id, shortcuts); return c.length ? ` (${c.map(comboLabel).join(' or ')})` : ''; };
  const has = tl.clips.length > 0;
  const bars = usePrefs((p) => p.bars);
  const customPanels = usePrefs((p) => p.customPanels);
  const workspaces = usePrefs((p) => p.workspaces);
  const expLevel = usePrefs((p) => p.level);
  const cmdItem = (id: string, label: string, icon: string, extra: Partial<ToolItem> = {}): ToolItem => ({ label, icon, title: `${COMMANDS.find((c) => c.id === id)?.label ?? label}${key(id)}`, run: run[id], ...extra });
  const status = (
    <span className="status" aria-live="polite">
      {trackJob && (
        <span className="busy track-status">
          <Icon name="track" size={15} /> Tracking subject… {Math.round(trackJob.progress * 100)}%
          <span className="mini-bar"><span style={{ width: `${trackJob.progress * 100}%` }} /></span>
          <button className="link" onClick={() => trackJob.abort.abort()}>Stop</button>
        </span>
      )}
      {reframeJob && (
        <span className="busy track-status">
          <Icon name="frame" size={15} /> {reframeJob.label}… {Math.round(reframeJob.progress * 100)}%
          <span className="mini-bar"><span style={{ width: `${reframeJob.progress * 100}%` }} /></span>
          <button className="link" onClick={() => reframeJob.abort.abort()}>Stop</button>
        </span>
      )}
      {importing && !cardOpen && (
        <span className="busy track-status">
          <Icon name="card" size={15} /> {cardRun.paused ? 'Import paused' : 'Importing'} {Math.round(cardRun.fraction * 100)}%
          <span className="mini-bar"><span style={{ width: `${cardRun.fraction * 100}%` }} /></span>
          <button className="link" onClick={() => setCardOpen(true)}>Show</button>
        </span>
      )}
      {foundCard && !importing && !cardOpen && (
        <span className="notice track-status">
          <Icon name="card" size={15} /> {foundCard.name} connected
          <button className="link" onClick={() => setCardOpen(true)}>Import…</button>
          <button className="link" aria-label="Dismiss" onClick={() => setCardFound(null)}>✕</button>
        </span>
      )}
      {notice && !trackJob && <span className="notice" onClick={() => setNotice(null)} title={`${notice} (click to dismiss)`}>{notice} ✕</span>}
      {busy && <span className="busy">{busy}</span>}
      {error && <span className="error" title={error} onClick={() => setError(null)}>{error} ✕</span>}
      {updateShown && update.state === 'checking' && <span className="busy">Checking for updates…</span>}
      {updateShown && update.state === 'downloading' && (
        <span className="busy track-status">
          <Icon name="import" size={15} /> Downloading version {update.version}… {Math.round(update.fraction * 100)}%
          <span className="mini-bar"><span style={{ width: `${update.fraction * 100}%` }} /></span>
        </span>
      )}
      {updateShown && update.state === 'ready' && (
        <span className="notice track-status">
          <Icon name="import" size={15} /> Version {update.version} is ready
          <button className="link" onClick={() => void restartToUpdate()} title="Saves your work, installs the new version and opens the app again">Restart to update</button>
          <button className="link" aria-label="Later" title="Later: it’s installed next time you restart" onClick={() => setUpdateShown(false)}>✕</button>
        </span>
      )}
      {updateShown && update.state === 'manual' && (
        <span className="notice track-status" title={update.why}>
          Version {update.version} is out. {update.why}
          <button className="link" onClick={() => void ace.openReleases(update.url)}>Download</button>
          <button className="link" aria-label="Dismiss" onClick={() => setUpdateShown(false)}>✕</button>
        </span>
      )}
      {/* Which project this is, when nothing else is being said. */}
      {!trackJob && !importing && !foundCard && !notice && !busy && !error && !(updateShown && update.state !== 'idle' && update.state !== 'current') && (projectName || has) && (
        <button className="link project-status" title={projectName ? 'Changes are saved as you go. Click to see all projects.' : 'This edit isn’t saved as a project yet. Click to see all projects.'} onClick={() => setProjectsOpen(true)}>
          {projectName ?? 'Not saved yet'}
        </button>
      )}
    </span>
  );
  // The clip's own rate; while playing, what is really being shown if that is less.
  const clipFps = media ? Math.min(media.fps * (clip && at ? speedAt(clip, at.mediaUs) : 1), rate.screen > 20 ? Math.max(rate.screen, 59) : 60) : 0;
  const behind = playing && clipFps > 0 && rate.video > 0 && rate.video < clipFps * 0.9;
  const fpsLabel = !media ? '' : behind ? `${rate.video.toFixed(0)} of ${Math.round(clipFps)} fps` : `${Math.round(clipFps)} fps`;
  const noClips = has ? undefined : 'Add a clip to the timeline first.';
  const items: Record<string, ToolItem> = {
    menu: {
      label: 'Menu', icon: 'menu',
      menu: [
        { label: 'Import media…', hint: comboLabel(comboOf('import', shortcuts)), onClick: run.import! },
        { label: 'Import from memory card…', hint: comboLabel(comboOf('card', shortcuts)), onClick: run.card! },
        { label: 'Add music…', onClick: run.music! },
        { label: 'Projects…', hint: comboLabel(comboOf('projects', shortcuts)), onClick: run.projects! },
        { label: 'New project', hint: comboLabel(comboOf('newProject', shortcuts)), onClick: run.newProject! },
        { label: 'Open project…', hint: comboLabel(comboOf('open', shortcuts)), onClick: run.open! },
        { label: 'Save project', hint: comboLabel(comboOf('save', shortcuts)), onClick: run.save! },
        { label: 'Save project as…', hint: comboLabel(comboOf('saveAs', shortcuts)), onClick: run.saveAs! },
        { label: 'Export video…', hint: comboLabel(comboOf('export', shortcuts)), onClick: run.export!, disabled: !has },
        'sep',
        { label: 'Customize…', hint: comboLabel(comboOf('customize', shortcuts)), onClick: () => setCustomize('themes') },
        { label: 'Arrange interface', hint: comboLabel(comboOf('arrange', shortcuts)), onClick: () => setArranging(true) },
        'sep',
        { label: 'Show raw camera streams', checked: showRaw, onClick: () => setShowRaw(!showRaw) },
        { label: 'Full screen preview', hint: comboLabel(comboOf('fullscreen', shortcuts)), onClick: toggleFullscreen, disabled: !has },
        'sep',
        ...PREVIEW_LEVELS.map(([l, label, desc]) => ({ label: `Preview quality: ${label}`, hint: l === 1 ? '' : desc.split(' ')[0], checked: level === l, onClick: () => setLevel(l) })),
        'sep',
        { label: 'Keyboard shortcuts', hint: comboLabel(comboOf('shortcuts', shortcuts)), onClick: () => setShortcutsOpen(true) },
        { label: 'Check for updates…', onClick: run.checkUpdates! },
      ],
    },
    import: cmdItem('import', 'Import', 'import'),
    card: cmdItem('card', 'Card', 'card', { on: cardOpen || importing }),
    music: cmdItem('music', 'Music', 'music'),
    open: cmdItem('open', 'Open', 'open'),
    save: cmdItem('save', 'Save', 'save'),
    saveAs: cmdItem('saveAs', 'Save as', 'save'),
    newProject: cmdItem('newProject', 'New', 'plus'),
    projects: cmdItem('projects', 'Projects', 'projects', { on: projectsOpen, title: `${projectName ? `Projects — “${projectName}” is open` : 'Projects'}${key('projects')}` }),
    undo: cmdItem('undo', 'Undo', 'undo', { disabled: !hist.current.past.length }),
    redo: cmdItem('redo', 'Redo', 'redo', { disabled: !hist.current.future.length }),
    text: cmdItem('text', 'Text', 'text', { locked: noClips }),
    titles: { label: 'Titles', icon: 'text', title: 'Add a motion title: lower thirds, title cards, end cards, location tags', locked: noClips, menu: TITLE_CATEGORIES.flatMap(([cat, name], i) => [...(i ? ['sep' as const] : []), { label: `${name}:`, disabled: true, onClick: () => {} }, ...TITLE_TEMPLATES.filter((t) => t.category === cat).map((t) => ({ label: t.name, onClick: () => addTitle(t.id) }))]) },
    gauges: { label: 'Gauges', icon: 'gauge', title: 'Add a telemetry gauge', locked: noClips, menu: [...GAUGES.map(([k, label]) => ({ label, onClick: () => addGauge(k) })), 'sep' as const, { label: 'A matching set of gauges:', disabled: true, onClick: () => {} }, ...GAUGE_DESIGNS.map((d) => ({ label: `${d.name} set`, onClick: () => addGaugeSet(d.id) }))] },
    track: cmdItem('track', 'Track', 'track', { locked: noClips ?? (trackJob ? 'A subject is being tracked. Wait for it to finish, or press Stop.' : undefined), on: trackPick }),
    status: { label: 'Messages', control: status, wide: true },
    frame: {
      label: 'Frame shape', title: 'Output shape',
      control: <label className="inline"><Icon name="frame" /><select aria-label="Frame shape" value={tl.framing} onChange={(e) => commit({ ...tl, framing: e.target.value })}>{FRAMINGS.map((f) => <option key={f.label}>{f.label}</option>)}</select></label>,
    },
    grab: cmdItem('grab', 'Frame grab', 'camera', { locked: noClips }),
    workspaces: {
      label: 'Layouts', icon: 'workspaces', title: 'Switch layout',
      menu: [
        { label: 'Set up for your experience:', disabled: true, onClick: () => {} },
        ...LEVELS.map((l) => ({ label: l.name, checked: expLevel === l.id, onClick: () => setExpLevel(l.id) })),
        'sep' as const,
        ...LAYOUTS.map(([n, f]) => ({ label: n, onClick: () => setPrefs({ layout: f() }) })),
        ...(Object.keys(workspaces).length ? (['sep', ...Object.entries(workspaces).map(([n, w]) => ({ label: n, onClick: () => setPrefs({ layout: w.layout, bars: w.bars }) }))] as const) : []),
        'sep',
        ...[...Object.entries(PANELS), ...customPanels.map((c) => [c.id, c.title] as const)].map(([id, t]) => ({ label: t, checked: openPanels(getPrefs().layout).includes(id), onClick: () => togglePanel([id]) })),
        'sep',
        { label: 'Save or edit layouts…', onClick: () => setCustomize('layout') },
      ],
    },
    customize: cmdItem('customize', 'Customize', 'customize', { on: !!customize }),
    export: cmdItem('export', 'Export', 'export', { primary: true, locked: noClips }),
    ai: {
      label: 'AI tools', icon: 'sparkle', title: 'Smart reframe, auto subtitles, smooth slow motion and sharper pictures', locked: noClips ?? (reframeJob ? 'Smart reframe is running. Wait for it to finish, or press Stop.' : undefined),
      menu: [
        { label: 'Smart reframe the whole edit:', disabled: true, onClick: () => {} },
        ...FRAMINGS.filter((f) => f.aspect < 1.5).map((f) => ({ label: `For ${f.label}${f.label === '9:16' ? ' (Reels, TikTok, Shorts)' : f.label === '4:5' ? ' (feed posts)' : ''}`, onClick: () => void runSmartReframe(allClipIds(), f.label) })),
        { label: `Again for ${tl.framing} (keeps the frame shape)`, onClick: () => void runSmartReframe(allClipIds()) },
        'sep' as const,
        { label: 'Auto subtitles…', onClick: () => setSubtitlesOpen(true) },
        { label: 'Save subtitles as .srt…', disabled: !tl.overlays.some((o) => o.caption), onClick: () => void saveSrt() },
        'sep' as const,
        { label: 'AI models on this computer…', onClick: () => setModelsOpen(true) },
      ],
    },
    queue: { label: queuePending ? `Queue (${queuePending})` : 'Queue', icon: 'export', title: 'Export queue: exports running in the background', on: queueOpen, run: () => setQueueOpen((o) => !o) },
    start: cmdItem('start', 'Start', 'start'),
    prev: cmdItem('prevFrame', 'Previous', 'prev'),
    play: cmdItem('play', playing ? 'Pause' : 'Play', playing ? 'pause' : 'play', { disabled: !has }),
    next: cmdItem('nextFrame', 'Next', 'next'),
    end: cmdItem('end', 'End', 'end'),
    time: { label: 'Time', control: <code className="timecode">{fmtTime(time)} <span className="muted">/ {fmtTime(duration)}</span></code> },
    quality: {
      label: 'Preview quality', title: 'Preview quality: lower is smoother on slower computers. Export always uses the full-quality originals.',
      control: <label className="inline"><Icon name="quality" /><select aria-label="Preview quality" value={level} onChange={(e) => setLevel(Number(e.target.value) as PreviewLevel)}>{PREVIEW_LEVELS.map(([l, label]) => <option key={l} value={l}>{label}</option>)}</select></label>,
    },
    fps: {
      label: 'Frames per second',
      title: media ? `This clip is ${+media.fps.toFixed(2)} fps${clip && at && speedAt(clip, at.mediaUs) !== 1 ? `, played at ${+speedAt(clip, at.mediaUs).toFixed(2)}×` : ''}.${playing ? ` Showing ${rate.video.toFixed(0)} new pictures a second; the screen redraws ${rate.screen.toFixed(0)} times a second.` : ''}${player.skimming ? ' This is faster than this computer can decode, so the preview shows fewer pictures; a lower preview quality shows more. Exports have them all.' : ''}${player.stalls ? ` Playback has waited for the video ${player.stalls} times.` : ''}` : 'Frame rate of the clip under the playhead',
      control: <span className="muted small fps">{fpsLabel}</span>,
    },
    compare: cmdItem('compare', 'Before / after', 'compare', { title: `Hold to see the picture without color, LUT, effects and motion blur${key('compare')}`, disabled: !has, on: compare, hold: setCompare }),
    fullscreen: cmdItem('fullscreen', fullscreen ? 'Exit full screen' : 'Full screen', fullscreen ? 'exitfull' : 'fullscreen', { disabled: !has }),
    split: cmdItem('split', 'Split', 'split', { locked: noClips }),
    multicam: cmdItem('multicam', 'Multicam', 'layers', { title: 'New multicam clip: cut between cameras filming the same moment' }),
    delLeft: cmdItem('delLeft', 'Delete left', 'delLeft', { locked: noClips }),
    delRight: cmdItem('delRight', 'Delete right', 'delRight', { locked: noClips }),
    detach: cmdItem('detach', clip?.audioDetached ? 'Reattach audio' : 'Detach audio', 'detach', { locked: noClips ?? (media && !media.info.audioTracks.length ? 'This clip has no sound to detach.' : undefined), on: !!clip?.audioDetached }),
    delete: cmdItem('delete', 'Delete', 'trash', { danger: true, disabled: !clip && !sel }),
    duplicate: cmdItem('duplicate', 'Duplicate', 'duplicate', { locked: noClips }),
    keyframe: cmdItem('keyframe', 'Keyframe', 'keyframe', { locked: noClips }),
    delKey: cmdItem('delKey', 'Delete keyframe', 'delKey', { locked: noClips ?? (clip && at && keyframeNear(clip.keyframes, at.mediaUs, snapUs) ? undefined : 'The playhead isn’t on a keyframe. Click a ◆ on the timeline first.') }),
    prevKey: cmdItem('prevKey', 'Previous keyframe', 'prev', { disabled: !clip?.keyframes.length }),
    nextKey: cmdItem('nextKey', 'Next keyframe', 'next', { disabled: !clip?.keyframes.length }),
    sections: cmdItem('sections', 'Sections', 'collapse'),
    arrange: cmdItem('arrange', 'Arrange', 'workspaces', { on: arranging }),
    shortcuts: cmdItem('shortcuts', 'Shortcuts', 'keyboard'),
    speedline: cmdItem('speedline', 'Speed line', 'speedline', { on: speedLines, locked: noClips }),
    jumps: cmdItem('jumps', 'Jumps', 'jumps', { on: jumpMarks, locked: noClips }),
    snap: cmdItem('snap', 'Snapping', 'snap', { on: snapping }),
    tool: {
      label: TOOLS.find(([t]) => t === tool)![1], icon: `tool-${tool}`, title: 'What dragging a clip does', locked: noClips,
      menu: TOOLS.map(([t, label, hint]) => ({ label, hint: `${comboLabel(comboOf(`tool${t[0]!.toUpperCase()}${t.slice(1)}`, shortcuts))}  ${hint}`, checked: tool === t, onClick: () => setTool(t) })),
    },
    tlinfo: { label: 'Clip count', control: <span className="muted">{tl.clips.length} clip{tl.clips.length === 1 ? '' : 's'} · {fmtTime(duration)}</span> },
    tlzoom: { label: 'Timeline zoom', title: 'Timeline zoom', control: <label className="inline zoom"><Icon name="zoom" /><Range label="Timeline zoom" min={Math.log(MIN_PPS)} max={Math.log(MAX_PPS)} step={0.01} value={Math.log(pps)} onChange={(v) => setPps(Math.exp(v))} /></label> },
  };
  // A message must never be lost because its toolbar item was removed.
  const statusShown = (['main', 'transport', 'timeline'] as const).some((b) => !bars[b].hidden && bars[b].items.includes('status') && (b === 'main' || openPanels(getPrefs().layout).includes(b === 'transport' ? 'viewer' : 'timeline')));
  const anyStatus = trackJob || reframeJob || notice || busy || error || ((importing || foundCard) && !cardOpen) || (updateShown && (update.state === 'ready' || update.state === 'manual'));

  // --- Panels ------------------------------------------------------------------------------------------
  const inspector: InspectorProps = {
    clip: clip,
    clipIndex: at?.index ?? 0,
    clipCount: layerSel ? tl.connected.length : tl.clips.length,
    clipStartUs: at?.startUs ?? 0,
    layerTrack: layerSel ? trackName(tl, layerSel.trackId) : null,
    layersHere: stackAt(tl, time)?.layers.length ?? 0,
    maskSel,
    onMaskSel: setMaskSel,
    onMasks: (masks, key) => clip && setClipMasks(clip.id, masks, key),
    onMaskFollow: (id, on) => {
      if (!clip || !at) return;
      const m = clip.masks?.find((x) => x.id === id);
      if (!m) return;
      const s = media ? subjectInFrame(clip, media, clipLookAt(clip, at.mediaUs), at.mediaUs, aspect) : null;
      // Keep the mask where it is: its place becomes an offset from the subject (or back).
      const shift = (p: { x: number; y: number }) => (!s ? (on ? { x: 0.5, y: 0.5 } : p) : on ? { x: p.x - s.x + 0.5, y: p.y - s.y + 0.5 } : { x: p.x + s.x - 0.5, y: p.y + s.y - 0.5 });
      const next: Mask = { ...m, ...shift(m), follow: on, keys: m.keys.map((k) => ({ ...k, ...shift(k) })) };
      setClipMasks(clip.id, clip.masks!.map((x) => (x.id === id ? next : x)), 'mask-follow');
      if (on && !s) setNotice('The subject isn’t tracked at the playhead, so the mask is centred on it where it is.');
    },
    onDrawMask: () => {
      if (drawingMask) { setDrawingMask(false); return; }
      setDrawingMask(true);
      setNotice('Draw round what to cover on the preview (Esc to stop).');
    },
    drawingMask,
    onTrackPatchSteer: (steer) => clip?.track && commit(updateClip(tlRef.current, clip.id, { track: { ...clip.track, steer: steer ? undefined : false } }), `steer:${clip.id}`),
    onLayout: (id) => {
      const next = applyLayout(tlRef.current, player.time, id);
      if (next !== tlRef.current) commit(next);
    },
    media: media,
    mediaUs: at?.mediaUs ?? 0,
    look: look,
    audio: selectedAudio,
    overlay: selectedOverlay,
    transitionClip: transitionClip,
    timeline: tl,
    lutPath: tl.lutPath,
    showRaw: showRaw,
    onShowRaw: setShowRaw,
    onLook: editLook,
    onGrade: editGrade,
    onAddKeyframe: addKeyframe,
    onDeleteKeyframe: deleteKeyframe,
    onDeleteKeyframeId: (id) => clip && deleteKeyframeById(clip.id, id),
    onGoToKeyframe: (id) => clip && pickKeyframe(clip.id, id),
    onClearKeyframes: () => clip && at && editClip({ keyframes: [], look: ownLookAt(clip, at.mediaUs) }, 'clearkeys'),
    onEasing: (e: Easing) => {
          const k = clip && at ? keyframeNear(clip.keyframes, at.mediaUs, snapUs) : undefined;
          if (k && clip) editClip({ keyframes: setEasing(clip.keyframes, k.id, e) }, 'easing');
        },
    onPrevKey: () => jumpKey(-1),
    onNextKey: () => jumpKey(1),
    onClip: editClip,
    motionJob: motionJob && clip && motionJob.clipId === clip.id ? { progress: motionJob.progress } : null,
    motionBusy: !!motionJob,
    motionNote: motionNote && clip && motionNote.clipId === clip.id ? motionNote.text : null,
    reframeJob: reframeJob && clip && (reframeJob.clipId === clip.id || reframeJob.clipId === null) ? { progress: reframeJob.progress } : null,
    reframeNote: reframeNote && clip && reframeNote.clipId === clip.id ? reframeNote.text : null,
    onSmartReframe: () => { if (clip) void runSmartReframe([clip.id]); },
    onRetryCopy: () => { if (clip) retryCopy(clip); },
    onCancelSmartReframe: () => reframeJob?.abort.abort(),
    onPictureMotion: () => void pictureMotion(),
    onCancelPictureMotion: () => motionJob?.abort.abort(),
    onForgetPictureMotion: () => {
      const m = clip && mediaNow(clip.mediaPath);
      if (!m) return;
      void forgetPictureMotion(m).then(() => { setMotionNote(null); editClip({ stabilize: { ...clip!.stabilize, smoothing: 'off' } }, 'picture-motion-off'); });
    },
    lensBusy,
    onMatchLenses: (which) => void matchLensesNow(which),
    onLensesToAll: () => {
      if (!clip) return;
      const t = tlRef.current;
      commit({ ...t, clips: t.clips.map((c) => (hasTwoLenses(mediaNow(c.mediaPath)) ? { ...c, lenses: clip.lenses } : c)) });
    },
    onSpeed: (patch, key) => clip && changeSpeed(clip.id, patch, key),
    onGaugeDesignAll: gaugeDesignAll,
    speedLines,
    onSpeedLines: toggleSpeedLines,
    jumpMarks,
    onJumpMarks: toggleJumpMarks,
    onPreviewAt: (T) => { seek(T); if (!player.playing) player.play(); },
    onSeekMedia: (m) => { if (!clip) return; const spot = clipSpot(tlRef.current, clip.id); if (spot) seek(spot.startUs + localAt(clip, m)); },
    onGradeToAll: () => {
          if (!look) return;
          const t = tlRef.current;
          commit({ ...t, clips: t.clips.map((c) => ({ ...c, look: { ...c.look, grade: look.grade }, keyframes: c.keyframes.map((k) => ({ ...k, look: { ...k.look, grade: look.grade } })) })) });
        },
    onLoadLut: loadLutFile,
    onClearLut: () => commit({ ...tlRef.current, lutPath: null }),
    onAudio: (patch, key) => selectedAudio && commit(updateAudio(tlRef.current, selectedAudio.id, patch), `${key}:${selectedAudio.id}`),
    onDetachAudio: () => detach(),
    onReattachAudio: (clipId) => { commit(reattachAudio(tlRef.current, clipId)); setSel(null); },
    onOverlay: editOverlay,
    compoundName: clip ? findSequence(tl, sequenceIdOf(clip))?.name : undefined,
    onOpenCompound: openCompound,
    gaugeSources: tl.connected.map((c) => ({ id: c.id, label: `${trackName(tl, c.trackId)} · ${baseName(c.mediaPath)} (${fmtTime(c.startUs)})` })),
    onTransition: editTransition,
    onRemoveSelected: deleteCurrent,
    onCloseSelection: () => setSel(null),
    onTrackSubject: startTrackPick,
    trackBusy: !!trackJob || trackPick,
    onTrackRange: (from, to, edge) => clip && setClipTrackRange(clip.id, from, to, edge),
    onClearTrack: () => clip && commit(updateClip(tlRef.current, clip.id, { track: undefined })),
    onTrackPatch: (patch, key) => clip?.track && commit(updateClip(tlRef.current, clip.id, { track: { ...clip.track, ...patch } }), `${key}:${clip.id}`),
    onSplit: () => split(),
    onDuplicate: duplicateCurrent,
    onDelete: deleteCurrent,
    onMove: (dir) => clip && at && !layerSel && commit(moveClip(tlRef.current, clip.id, at.index + dir)),
  };
  // Selecting something brings its settings to the front, until another tab is clicked.
  const selKey = sel ? `${sel.kind}:${sel.id}` : '';
  const [frontOff, setFrontOff] = useState('');
  useEffect(() => {
    if (selKey) setPrefs((p) => (openPanels(p.layout).includes('selection') ? {} : { layout: reopenPanel(p.layout, 'selection') }), 'selopen');
    else setFrontOff('');
  }, [selKey]);

  const viewerPanel = () => (
    <main className={`viewer${fullscreen ? ' is-fullscreen' : ''}`} ref={viewerRef} onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('.frame') && !selectedOverlay) toggleFullscreen(); }}>
      {bars.transport.position === 'top' && transport}
      {source && (() => {
        const m = mediaNow(source.path), d = m?.durationUs ?? 1;
        const pct = (us: number | null, dflt: number) => `${((us ?? dflt) / d) * 100}%`;
        return (
          <div className="source-bar" role="toolbar" aria-label="Source clip">
            <span className="source-name"><b>Source</b> {baseName(source.path)}</span>
            <div className="source-scrub" style={{ '--in': pct(source.inUs, 0), '--out': pct(source.outUs, d) } as React.CSSProperties}>
              <input type="range" min={0} max={d} step={1000} value={Math.min(d, time)} aria-label="Position in the source clip" onChange={(e) => seek(+e.target.value)} />
            </div>
            <span className="source-marks">{fmtTime(source.inUs ?? 0)} – {fmtTime(source.outUs ?? d)}</span>
            <button onClick={() => markSource('inUs')} title={`Mark in${key('markIn')}`}>In</button>
            <button onClick={() => markSource('outUs')} title={`Mark out${key('markOut')}`}>Out</button>
            <button onClick={() => placeSource('insert')} title={`Put it in at the timeline playhead; the rest moves later${key('insertEdit')}`}>Insert</button>
            <button onClick={() => placeSource('overwrite')} title={`Put it over what's at the timeline playhead${key('overwriteEdit')}`}>Overwrite</button>
            <button className="primary" onClick={closeSource} title="Back to the timeline">Done</button>
          </div>
        );
      })()}
      <div className="stage" ref={stageRef}>
          <div
            style={{ visibility: tl.clips.length ? 'visible' : 'hidden' }}
            className={`frame${trackPick ? ' picking' : media ? ' grab' : ''}`}
            ref={frameRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => {
              if (drag.current?.kind === 'drawmask') finishDrawnMask();
              drag.current = null;
              setGuides(null);
              endGesture();
              if (trackPick && boxStart.current && trackBox) {
                boxStart.current = null;
                // A click without dragging picks a box around that point.
                const b = trackBox.x1 - trackBox.x0 < 8 ? { x0: trackBox.x0 - 40, y0: trackBox.y0 - 40, x1: trackBox.x0 + 40, y1: trackBox.y0 + 40 } : trackBox;
                setTrackBox(null);
                void runTracking(b);
              }
            }}
            onWheel={onWheel}
            onContextMenu={(e) => {
              e.preventDefault();
              drag.current = null;
              if (clip) setCtxMenu({ clipId: clip.id, T: player.time, x: e.clientX, y: e.clientY });
            }}
          >
            {Array.from({ length: MAX_LAYERS }, (_, i) => (
              <div key={i} className="layer-slot" ref={(el) => { slotEls.current[i] = el; }}>
                <div className="layer-box" ref={(el) => { boxEls.current[i] = el; }}>
                  <canvas className="layer" ref={(el) => { canvasEls.current[i] = el; }} />
                </div>
              </div>
            ))}
            <div ref={dipRef} className="dip" />
            <canvas ref={overlayRef} className="overlay-layer" />
            {guides && <div className="align-guides" aria-hidden>
              {guides.v.map((v) => <i key={`v${v}`} className={`v${v === 0.5 ? ' mid' : ''}`} style={{ left: `${v * 100}%` }} />)}
              {guides.h.map((h) => <i key={`h${h}`} className={`h${h === 0.5 ? ' mid' : ''}`} style={{ top: `${h * 100}%` }} />)}
            </div>}
            {compare && has && <span className="compare-tag">Before</span>}
            {trackBox && <div className="track-box" style={{ left: trackBox.x0, top: trackBox.y0, width: trackBox.x1 - trackBox.x0, height: trackBox.y1 - trackBox.y0 }} />}
          </div>
        {has && clip && !media && <div className="empty offline"><div><Icon name="media" size={42} /><p><b>“{baseName(clip.mediaPath)}” is missing</b><br />It was moved, renamed or deleted. Relink it in Media to see it again.</p></div></div>}
        {!has && <div className="empty"><div><Icon name="media" size={42} /><p>Drag videos or folders here,<br />or import them:</p><button className="primary" onClick={run.import}>Import media…</button> <button onClick={run.card}>From memory card…</button></div></div>}
      </div>
      {bars.transport.position === 'bottom' && transport}
    </main>
  );
  const transport = (!bars.transport.hidden || fullscreen) && (
    <div className="transport">
      {fullscreen && (
        <div className="fs-scrub">
          <Range label="Position" min={0} max={Math.max(1, duration)} step={1e6 / (media?.fps ?? 30)} value={Math.min(time, duration)} onPointerDown={() => player.pause()} onChange={seek} />
          {tl.clips.length > 1 && clipStarts(tl).slice(1).map((s0, i) => <i key={i} className="fs-cut" style={{ left: `${(s0 / Math.max(1, duration)) * 100}%` }} />)}
        </div>
      )}
      <Bar id="transport" items={items} />
    </div>
  );
  /** The timeline time under a point of the screen (where something dropped lands). */
  dropAtRef.current = (x: number) => {
    const scroller = document.querySelector<HTMLElement>('.timeline-wrap .timeline-scroll');
    if (!scroller) return undefined;
    const pxPerS = Number(scroller.dataset.pps) || 60, head = Number(scroller.dataset.head) || 0;
    return Math.max(0, Math.min(Math.max(duration, 1), ((x - scroller.getBoundingClientRect().left + scroller.scrollLeft - head) / pxPerS) * 1e6));
  };
  const timelinePanel = () => (
      <div
        className="timeline-wrap"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-ace-media')) e.preventDefault(); }}
        onDrop={(e) => {
          const path = e.dataTransfer.getData('text/x-ace-media');
          if (!path) return;
          e.preventDefault();
          // Insert after the clip under the drop point (or at the end).
          const T = dropAtRef.current(e.clientX) ?? 0;
          // Onto a track above the main row (or the row for a new one): placed there, at the drop point.
          const row = (e.target as HTMLElement).closest<HTMLElement>('[data-track]');
          if (row && tlRef.current.clips.length) {
            const c = clipFor(path);
            if (!c) return;
            // The row above the top track makes a new track; a track row puts it there (or on the next free one up).
            const fresh = row.dataset.track === 'new' ? addTrack(tlRef.current) : null;
            const placed = fresh?.id ? placeConnected(fresh.tl, { ...c, id: newId('v') }, T, fresh.id) : placeConnected(tlRef.current, { ...c, id: newId('v') }, T, row.dataset.track === 'new' ? undefined : row.dataset.track);
            if (placed) { commit(placed.tl); setSel({ kind: 'layer', id: placed.id }); }
            else setNotice('Every video track is taken there. Move or remove a clip on V2–V6 first.');
            return;
          }
          const hit = duration > 0 ? locate(tlRef.current, T) : null;
          addToTimeline(path, hit ? hit.index + (T > hit.startUs + clipDuration(hit.clip) / 2 ? 1 : 0) : undefined);
        }}
      >
        {nest.length > 0 && (
          <nav className="tl-crumbs" aria-label="Compound clips open">
            <button onClick={() => leaveCompound(0)}>Main edit</button>
            {nest.map((n, i) => (
              <span key={n.id}>
                <span className="crumb-sep" aria-hidden>›</span>
                {i < nest.length - 1 ? <button onClick={() => leaveCompound(i + 1)}>{n.name}</button> : (
                  <input aria-label="Compound clip name" value={tl.sequences?.find((q) => q.id === n.id)?.name ?? n.name} onChange={(e) => renameSequence(n.id, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                )}
              </span>
            ))}
            <span className="muted small">Editing inside a compound clip. Changes show wherever it is used.</span>
          </nav>
        )}
        {!source && at && at.clip.multicam && !layerSel && <AngleViewer timeline={tl} clip={at.clip} mediaUs={at.mediaUs} onPick={(a) => cutToAngle(a)} />}
        <TimelineView
          timeline={tl}
          time={source && sourceRef.current ? sourceRef.current.savedTime : time}
          playing={playing}
          selectedClipId={sel ? null : clip?.id ?? null}
          selection={sel}
          onSeek={(t) => { if (sourceRef.current) closeSource(); seek(t); }}
          onSelectClip={selectClip}
          onSelect={setSel}
          onTransition={openTransition}
          onTrimClip={(id, i, o) => {
            const c = tlRef.current.clips.find((x) => x.id === id);
            const d = c && sourceDuration(tlRef.current, c, (p) => mediaNow(p)?.durationUs);
            if (d) commit(rippleItems(tlRef.current, trimClip(tlRef.current, id, i, o, d), id), `trim:${id}`);
          }}
          onTrackRange={setClipTrackRange}
          keyframe={pickedKf()}
          onKeyframe={pickKeyframe}
          onMoveKeyframe={dragKeyframe}
          onKeyframeMenu={(clipId, id, x, y) => { pickKeyframe(clipId, id); setKfMenu({ clipId, id, x, y }); }}
          speedLines={speedLines}
          jumpMarks={jumpMarks}
          snapping={snapping}
          tool={tool}
          onProEdit={proEdit}
          speedPoint={pickedSpeed}
          onSpeedPoint={pickSpeedPoint}
          onMoveSpeedPoint={moveSpeedPoint}
          onAddSpeedPoint={addSpeedPoint}
          onSpeed={(id, speed) => changeSpeed(id, { speed }, 'speed')}
          onSpeedMenu={(clipId, id, x, y) => { pickSpeedPoint(clipId, id); setSpeedMenu({ clipId, id, x, y }); }}
          onReorderClip={(id, to) => commit(moveClip(tlRef.current, id, to))}
          onMoveAudio={(id, startUs, inUs, outUs) => commit(updateAudio(tlRef.current, id, { startUs, inUs, outUs }), `music:${id}`)}
          onMoveOverlay={(id, startUs, endUs) => commit(updateOverlay(tlRef.current, id, { startUs, endUs }), `ov-time:${id}`)}
          onMoveConnected={(id, startUs, trackId) => {
            const next = moveConnected(tlRef.current, id, startUs, trackId);
            if (next !== tlRef.current) commit(next, `layer-move:${id}`);
          }}
          onTrimConnected={(id, startUs, inUs, outUs) => {
            const t = tlRef.current, c = t.connected.find((x) => x.id === id);
            if (!c || t.tracks.find((x) => x.id === c.trackId)?.locked) return;
            const moved = { ...c, startUs, inUs, outUs };
            // Not over the clip next to it on the same track.
            if (!trackFree(t, c.trackId, startUs, startUs + playLength(moved), id)) return;
            commit({ ...t, connected: t.connected.map((x) => (x.id === id ? moved : x)) }, `layer-trim:${id}`);
          }}
          onTrack={(id, patch) => {
            commit(updateTrack(tlRef.current, id, patch));
            // A locked track's clips can't stay selected (they can't be changed).
            const s = selRef.current;
            if (patch.locked && s?.kind === 'layer' && tlRef.current.connected.find((c) => c.id === s.id)?.trackId === id) setSel(null);
          }}
          onDragEnd={() => { endGesture(); bump((n) => n + 1); }}
          onMarker={(id, patch) => commit(updateMarker(tlRef.current, id, patch), `marker:${id}`)}
          onRemoveMarker={(id) => commit(removeMarker(tlRef.current, id))}
          onClipMenu={(clipId, T, x, y) => setCtxMenu({ clipId, T, x, y })}
          onOpenCompound={openCompound}
          pps={pps}
          onPps={setPps}
          toolbarAt={bars.timeline.position}
          toolbar={!bars.timeline.hidden && <Bar id="timeline" items={items} />}
        />
      </div>
  );
  const panels: Record<string, PanelDef> = {
    media: { title: 'Media', icon: 'media', render: () => <MediaBin level={level} items={bin} folders={bins} onFolders={setBins} onItem={(path, patch) => setBin((b) => b.map((x) => (x.path === path ? { ...x, ...patch } : x)))} onRelink={() => void relinkMissing()} onProxiesCleared={() => { forgetProxies(); ensureProxies(binMedia()); }} onImport={importDialog} onBatchExport={() => setBatchOpen(true)} onAdd={(p) => addToTimeline(p)} onConnect={(p) => connectToTrack(p)} onSource={openSource} onRemove={(p) => setBin((b) => b.filter((x) => x.path !== p))} /> },
    viewer: { title: 'Preview', icon: 'viewer', bare: true, keep: true, render: viewerPanel },
    timeline: { title: 'Timeline', icon: 'timeline', bare: true, render: timelinePanel },
    ...Object.fromEntries((['reframe', 'stabilize', 'color', 'effects', 'clip'] as const).map((id) => [id, { title: PANELS[id], icon: id, render: () => <InspectorPanel {...inspector} panel={id} /> }])),
    selection: { title: PANELS.selection, icon: 'selection', idle: !sel || sel.kind === 'layer', render: () => <SelectionPanel {...inspector} /> },
    scopes: { title: PANELS.scopes, icon: 'scopes', render: () => <ScopesPanel clipId={clip?.id ?? null} /> },
    markers: { title: PANELS.markers, icon: 'marker', render: () => <MarkersPanel timeline={tl} time={time} onSeek={seek} onAdd={run.marker!} onChange={(id, patch) => commit(updateMarker(tlRef.current, id, patch), `marker:${id}`)} onRemove={(id) => commit(removeMarker(tlRef.current, id))} /> },
    ...Object.fromEntries(customPanels.map((c) => [c.id, { title: c.title, icon: 'custom', render: () => <InspectorPanel {...inspector} panel={c.id} /> }])),
  };
  const mainBar = !bars.main.hidden && <Bar id="main" items={items} />;
  const top = bars.main.position === 'top';

  return (
    <div className="app">
      {top && mainBar}
      {/* Without a toolbar at the top, the window still needs somewhere to be dragged from. */}
      {platformMac && (!mainBar || !top) && <div className="titlebar">Action Cam Editor</div>}
      <Dock panels={panels} front={sel && sel.kind !== 'layer' && frontOff !== selKey ? 'selection' : null} onFront={(p) => setFrontOff(p === 'selection' ? '' : selKey)} />
      {!top && mainBar}

        <AppMenu
          open={!!ctxMenu && !!ctxClip}
          at={ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : undefined}
          title={ctxClip ? `Clip ${ctxIndex + 1} · ${fmtTime(ctxMenu!.T)}` : undefined}
          onClose={() => setCtxMenu(null)}
          items={
            ctxMenu && ctxClip
              ? [
                  { label: 'Split here', hint: 'S', onClick: () => { splitHere(ctxMenu.T); seek(ctxMenu.T); } },
                  { label: 'Split and delete left', hint: 'Q', onClick: () => { selRef.current = null; setSel(null); deleteSide('left', ctxMenu.T); } },
                  { label: 'Split and delete right', hint: 'W', onClick: () => { selRef.current = null; setSel(null); deleteSide('right', ctxMenu.T); } },
                  'sep',
                  ctxClip.audioDetached
                    ? { label: 'Reattach audio', onClick: () => commit(reattachAudio(tlRef.current, ctxClip.id)) }
                    : { label: 'Detach audio', disabled: !ctxHasSound, onClick: () => detach(ctxClip.id) },
                  { label: 'Solo sound', checked: !!ctxClip.soloSound, disabled: !ctxHasSound, onClick: () => commit(updateClip(tlRef.current, ctxClip.id, { soloSound: !ctxClip.soloSound || undefined })) },
                  { label: 'Track subject from here…', disabled: !mediaNow(ctxClip.mediaPath), onClick: () => { seek(ctxMenu.T); setTimeout(() => runRef.current.track?.(), 150); } },
                  ...(() => {
                    const tr = ctxClip.track, r = tr && trackRange(tr), e = tr && trackExtent(tr);
                    if (!tr || !r || !e) return [];
                    const mUs = mediaAt(ctxClip, ctxMenu.T - clipStarts(tl)[ctxIndex]!);
                    return [
                      { label: 'Start following here', disabled: mUs < e[0] || mUs >= r[1], onClick: () => setClipTrackRange(ctxClip.id, mUs, r[1], 'from') },
                      { label: 'Stop following here', disabled: mUs > e[1] || mUs <= r[0], onClick: () => setClipTrackRange(ctxClip.id, r[0], mUs, 'to') },
                    ];
                  })(),
                  { label: ctxClip.transitionIn ? 'Edit transition in' : 'Add transition in', disabled: ctxIndex === 0, onClick: () => openTransition(ctxClip.id) },
                  { label: 'Duplicate clip', onClick: () => commit(duplicateClip(tlRef.current, ctxClip.id)) },
                  'sep',
                  ...(isCompound(ctxClip)
                    ? [
                        { label: 'Open compound clip', onClick: () => openCompound(ctxClip.id) },
                        { label: 'Break apart', onClick: () => { commit(breakApart(tlRef.current, ctxClip.id)); setSel(null); } },
                      ]
                    : []),
                  ...(ctxClip.multicam ? (groupOf(tl, ctxClip)?.angles ?? []).map((a, k) => ({ label: `Switch angle to ${k + 1}: ${baseName(a.path)}`, checked: ctxClip.multicam!.angle === k, onClick: () => { const n = switchAngle(tlRef.current, ctxClip.id, k); if (n === tlRef.current && ctxClip.multicam!.angle !== k) setNotice(`Angle ${k + 1} isn’t recording for all of this clip.`); else commit(n); } })) : []),
                  { label: 'Make compound clip', onClick: () => compoundOf(ctxIndex, ctxIndex) },
                  { label: 'Make compound clip with the next clip', disabled: ctxIndex >= tl.clips.length - 1, onClick: () => compoundOf(ctxIndex, ctxIndex + 1) },
                  { label: 'Make compound clip from here to the end', disabled: ctxIndex >= tl.clips.length - 1, onClick: () => compoundOf(ctxIndex, tl.clips.length - 1) },
                  'sep',
                  { label: 'Delete clip', hint: '⌫', onClick: () => { commit(removeClipRipple(tlRef.current, ctxClip.id)); setSel(null); } },
                ]
              : []
          }
        />

      <AppMenu
        open={!!ctxMenu && !!ctxLayer}
        at={ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : undefined}
        title={ctxLayer ? `${trackName(tl, ctxLayer.trackId)} · ${baseName(ctxLayer.mediaPath)}` : undefined}
        onClose={() => setCtxMenu(null)}
        items={
          ctxMenu && ctxLayer
            ? [
                { label: 'Split here', hint: 'S', onClick: () => { selRef.current = { kind: 'layer', id: ctxLayer.id }; setSel(selRef.current); split(ctxMenu.T); } },
                { label: 'Split and delete left', hint: 'Q', onClick: () => { selRef.current = { kind: 'layer', id: ctxLayer.id }; setSel(selRef.current); deleteSide('left', ctxMenu.T); } },
                { label: 'Split and delete right', hint: 'W', onClick: () => { selRef.current = { kind: 'layer', id: ctxLayer.id }; setSel(selRef.current); deleteSide('right', ctxMenu.T); } },
                { label: 'Solo sound', checked: !!ctxLayer.soloSound, disabled: !mediaNow(ctxLayer.mediaPath)?.info.audioTracks.length, onClick: () => commit(updateClip(tlRef.current, ctxLayer.id, { soloSound: !ctxLayer.soloSound || undefined })) },
                { label: 'Track subject from here…', disabled: !mediaNow(ctxLayer.mediaPath), onClick: () => { selRef.current = { kind: 'layer', id: ctxLayer.id }; setSel(selRef.current); seek(ctxMenu.T); setTimeout(() => runRef.current.track?.(), 150); } },
                { label: 'Duplicate clip', onClick: () => { setSel({ kind: 'layer', id: ctxLayer.id }); selRef.current = { kind: 'layer', id: ctxLayer.id }; duplicateCurrent(); } },
                'sep',
                ...LAYOUT_TEMPLATES.filter((l) => l.id.startsWith('pip')).map((l) => ({ label: l.label, onClick: () => commit(updateClip(tlRef.current, ctxLayer.id, { look: { ...ctxLayer.look, xf: cellTransform(l.cells[1]!, l.fill, xfOf(ctxLayer.look)) }, keyframes: ctxLayer.keyframes.map((k) => ({ ...k, look: { ...k.look, xf: cellTransform(l.cells[1]!, l.fill, xfOf(k.look)) } })) })) })),
                { label: 'Full frame', onClick: () => commit(updateClip(tlRef.current, ctxLayer.id, { look: { ...ctxLayer.look, xf: undefined }, keyframes: ctxLayer.keyframes.map((k) => ({ ...k, look: { ...k.look, xf: undefined } })) })) },
                'sep',
                { label: 'Delete clip', hint: '⌫', onClick: () => { commit(trimEmptyTracks(removeConnected(tlRef.current, ctxLayer.id))); setSel(null); } },
              ]
            : []
        }
      />

      <AppMenu
        open={!!kfMenu}
        at={kfMenu ?? undefined}
        title="Keyframe"
        onClose={() => setKfMenu(null)}
        items={(() => {
          const c = kfMenu && findClip(tl, kfMenu.clipId), k = c?.keyframes.find((x) => x.id === kfMenu!.id);
          if (!kfMenu || !c || !k) return [];
          const ease = (e: Easing) => () => commit(updateClip(tlRef.current, c.id, { keyframes: setEasing(c.keyframes, k.id, e) }));
          return [
            { label: 'Delete keyframe', icon: 'trash', hint: '⌫', onClick: () => deleteKeyframeById(c.id, k.id) },
            'sep',
            ...CURVES.map(([id, label]) => ({ label, checked: k.easing === id, onClick: ease(id) })),
            'sep',
            { label: `Delete all ${c.keyframes.length} keyframes`, onClick: () => commit(updateClip(tlRef.current, c.id, { keyframes: [], look: k.look })) },
          ];
        })()}
      />
      <AppMenu
        open={!!speedMenu}
        at={speedMenu ?? undefined}
        title="Speed point"
        onClose={() => setSpeedMenu(null)}
        items={(() => {
          const c = speedMenu && findClip(tl, speedMenu.clipId), k = c?.speedKeys?.find((x) => x.id === speedMenu!.id);
          if (!speedMenu || !c?.speedKeys || !k) return [];
          const keys = c.speedKeys, set = (patch: Parameters<typeof setClipSpeed>[2]) => () => changeSpeed(c.id, patch, 'speedmenu');
          return [
            { label: 'Delete point', icon: 'trash', hint: '⌫', onClick: () => deleteSpeedPoint(c.id, k.id) },
            { label: 'Normal speed here', onClick: set({ speedKeys: keys.map((x) => (x.id === k.id ? { ...x, speed: 1 } : x)) }) },
            'sep',
            { label: 'Ease to the next point', checked: (k.ease ?? 'smooth') === 'smooth', onClick: set({ speedKeys: setSpeedEase(keys, k.id, 'smooth') }) },
            { label: 'Change evenly', checked: k.ease === 'linear', onClick: set({ speedKeys: setSpeedEase(keys, k.id, 'linear') }) },
            { label: 'Jump', checked: k.ease === 'jump', onClick: set({ speedKeys: setSpeedEase(keys, k.id, 'jump') }) },
            'sep',
            { label: 'Remove the whole ramp', onClick: set({ speedKeys: undefined, speed: 1 }) },
          ];
        })()}
      />
      {anyStatus && !statusShown && <div className="toast">{status}</div>}
      {dropZone && (
        <div className={`drop-veil ${dropZone}`} aria-hidden>
          <div className="drop-card"><Icon name="media" size={34} /><b>{dropZone === 'timeline' ? 'Drop to add to the timeline' : 'Drop to import'}</b><span>Videos, folders and music</span></div>
        </div>
      )}
      {arranging && <ArrangeBar items={items} drag={(e, id, label) => dragItem(e, id, label, null)} onCustomize={() => setCustomize('layout')} onDone={() => setArranging(false)} />}
      {customize && <Customize page={customize} onPage={setCustomize} onClose={() => setCustomize(null)} items={items} />}
      {subtitlesOpen && <SubtitlesDialog timeline={tl} onCaptions={(caps) => commit(withCaptions(tlRef.current, caps), 'captions')} onSaveSrt={() => void saveSrt()} onClose={() => setSubtitlesOpen(false)} />}
      {modelsOpen && <ModelsDialog onClose={() => setModelsOpen(false)} />}
      {multicamOpen && <MulticamDialog files={bin.filter((b) => b.media).map((b) => b.path)} busy={multicamBusy} onMake={(ps, m) => void makeMulticam(ps, m)} onClose={() => setMulticamOpen(false)} />}
      {exportOpen && <ExportDialog timeline={flattenTimeline(rootTimeline())} onClose={() => setExportOpen(false)} onShowQueue={() => setQueueOpen(true)} />}
      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
      {batchOpen && <BatchDialog items={bin.filter((b) => b.media).map((b) => ({ path: b.path, rating: b.rating, flag: b.flag }))} onClose={() => setBatchOpen(false)} onQueued={(n) => { setNotice(`${n} video${n === 1 ? '' : 's'} added to the export queue.`); setQueueOpen(true); }} />}
      {cardOpen && <ImportWindow onClose={() => setCardOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {reportOpen && <ReportProblem onClose={() => setReportOpen(false)} />}
      {projectsOpen && <ProjectsPage current={projectPath} onOpen={(p) => void openProjectAt(p)} onNew={() => void newProject()} onOpenOther={() => void openProject()} onMoved={projectMoved} onClose={() => setProjectsOpen(false)} />}
      {naming && <NameSheet title="Save project" action="Save" initial={defaultProjectName()} onCancel={() => setNaming(false)} onSave={(n) => void saveNamed(n)} />}
      {welcome && <Welcome name={appName} onClose={closeWelcome} onImport={run.import!} onCard={run.card!} onOpen={run.projects!} onTour={() => setTourOpen(true)} />}
      {tourOpen && <Tour onClose={() => setTourOpen(false)} />}
    </div>
  );
}

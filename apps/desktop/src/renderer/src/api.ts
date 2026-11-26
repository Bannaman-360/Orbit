import type { ByteReader } from '@ace/engine';
import type { OrientationData } from '@ace/telemetry';
import type { CardRecording, ImportEvent } from '../../main/card';
import type { UpdateState } from '../../main/updater';
import type { ModelState } from '../../main/models';
export type { ModelState };
export type { UpdateState };

export interface Card { root: string; name: string }
/** A saved project, as the Projects page lists it. */
export interface ProjectEntry { path: string; name: string; modified: number; inLibrary: boolean; thumb?: string; clips?: number; durationUs?: number }
export interface ProjectMeta { thumb?: string; clips?: number; durationUs?: number }
/** `copies`: where it was imported to, if those files are still there. */
export type ListedRecording = CardRecording & { imported: boolean; copies: string[] | null };
export type { ImportEvent };

/** What a set of files and folders held that can be imported. */
export interface FoundMedia { video: string[]; audio: string[]; skipped: { name: string; why: string }[] }

export interface AceApi {
  info(): Promise<{ selftest: boolean; selftestMode: string; fixtures: string; packaged?: boolean; name?: string; version?: string; versions: Record<string, string> }>;
  openMediaDialog(): Promise<FoundMedia>;
  importPaths(paths: string[]): Promise<FoundMedia>;
  /** 10-bit HEVC / ProRes: which this computer can write (by encoder name). */
  /** Notes a problem in the log (Help → Report a Problem). */
  logError(source: string, message: string): void;
  reportText(gpu: string): Promise<string>;
  reportCopy(text: string): Promise<void>;
  reportReveal(): Promise<void>;
  /** Puts text on the clipboard. */
  copyText(text: string): Promise<void>;
  /** Self-tests: what would have been copied. */
  selftestCopied(): Promise<string>;
  proxyUsage(): Promise<{ files: number; bytes: number }>;
  proxyClear(): Promise<void>;
  proxyReveal(): Promise<void>;
  /** Looks for missing files in a folder the user picks (null: they cancelled). */
  relink(wanted: { path: string; size?: number }[], folder?: string): Promise<{ folder: string; matches: { from: string; to: string; how: string }[] } | null>;
  encoderAvailable(): Promise<{ hevc10?: string; prores?: string }>;
  encoderStart(o: { path: string; width: number; height: number; fps: number; kind: 'hevc10' | 'prores'; bitrate: number; layout: 'p010le' | 'p210le'; audio?: Uint8Array }): Promise<number>;
  encoderFrame(id: number, data: Uint8Array): Promise<void>;
  encoderFinish(id: number): Promise<void>;
  encoderCancel(id: number): Promise<void>;
  pathsOf(files: File[]): string[];
  /** Files opened with the app from Finder / Explorer. */
  onOpenProject(f: (p: { path: string; text: string }) => void): void;
  onOpenMedia(f: (found: FoundMedia) => void): void;
  openAudioDialog(): Promise<string[]>;
  openLutDialog(): Promise<string | null>;
  openProjectDialog(): Promise<{ path: string; text: string } | null>;
  openThemeDialog(): Promise<string | null>;
  /** Every saved project, most recently changed first. */
  projectsList(): Promise<ProjectEntry[]>;
  projectsOpen(path: string): Promise<{ path: string; text: string }>;
  /** Saves to `path`, or as a new project called `name` in the Projects folder. Returns where it went. */
  projectsSave(o: { path?: string; name?: string; text: string; meta?: ProjectMeta }): Promise<string>;
  projectsRename(path: string, name: string): Promise<string>;
  projectsDuplicate(path: string): Promise<string>;
  /** Moves a Projects-folder project to the Trash; one saved elsewhere just leaves the list. */
  projectsRemove(path: string): Promise<void>;
  projectsReveal(path: string): Promise<void>;
  /** Updates from GitHub Releases (downloaded in the background, installed on Restart). */
  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  /** Quits and installs; returns why not, if it can't now. */
  updateInstall(): Promise<string | null>;
  openReleases(url?: string): Promise<void>;
  onUpdate(f: (s: UpdateState) => void): void;
  /** AI models: which are downloaded, downloading one (progress comes through onModelProgress), removing one, reading a file of one. */
  modelsList(): Promise<ModelState[]>;
  modelsDownload(id: string): Promise<{ ok: boolean; error?: string }>;
  modelsCancel(id: string): Promise<void>;
  modelsRemove(id: string): Promise<void>;
  modelsRead(id: string, name: string): Promise<Uint8Array>;
  onModelProgress(f: (id: string, fraction: number) => void): () => void;
  setWindow(o: { mode: 'auto' | 'light' | 'dark'; translucent: boolean }): Promise<void>;
  /** Menu bar choices. */
  onCommand(f: (cmd: string) => void): void;
  onWindowFullscreen(f: (on: boolean) => void): void;
  saveDialog(kind: 'project' | 'video' | 'mov' | 'image' | 'theme' | 'lut' | 'srt', defaultName: string): Promise<string | null>;
  /** Choose a folder for batch exports (files may then be made in it). */
  exportFolderDialog(): Promise<string | null>;
  /** A free file name in that folder, which may then be written. */
  pathInFolder(dir: string, name: string, ext: 'mp4' | 'mov'): Promise<string>;
  /** Shows an exported file in Finder / Explorer. */
  reveal(path: string): Promise<void>;
  stat(path: string): Promise<{ path: string; size: number }>;
  /** Files of the same chaptered recording, in order. */
  chapters(path: string): Promise<{ path: string; part: number }[]>;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  readAll(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<string>;
  createFile(path: string): Promise<void>;
  writeAt(path: string, position: number, data: Uint8Array): Promise<void>;
  closeFile(path: string): Promise<void>;
  /** Stops keeping a file open. */
  release(path: string): Promise<void>;
  cards(): Promise<Card[]>;
  scanCard(root: string): Promise<ListedRecording[]>;
  cardThumb(id: string): Promise<Uint8Array | null>;
  importDest(): Promise<{ path: string; free: number | null }>;
  chooseImportDest(): Promise<{ path: string; free: number | null }>;
  importCard(ids: string[]): Promise<void>;
  importControl(what: 'pause' | 'resume' | 'stop'): Promise<void>;
  onCards(f: (cards: Card[]) => void): void;
  onImport(f: (e: ImportEvent) => void): void;
  selftestFiles(what: string, a?: string, b?: string | number | Uint8Array): Promise<unknown>;
  proxyPath(src: string, level: number, tag?: string): Promise<{ path: string; exists: boolean }>;
  /** Where a file's motion worked out from its picture is kept. */
  motionPath(src: string): Promise<{ path: string; exists: boolean }>;
  proxyFinish(file: string): Promise<void>;
  proxyDiscard(file: string): Promise<void>;
  listFixtures(): Promise<string[]>;
  orientation(path: string, req: unknown): Promise<OrientationData>;
  autosaveLoad(): Promise<string | null>;
  autosaveSave(text: string): Promise<void>;
  /** Keeps the last session under another name; the app starts fresh next time. */
  autosaveAside(): Promise<void>;
  capture(name: string): Promise<string>;
  selftestMetrics(): Promise<Record<string, number>>;
  selftestInput(ev: Record<string, unknown>): Promise<void>;
  selftestOut(name: string): Promise<string>;
  selftestGesture(code: string): Promise<unknown>;
  selftestDone(report: unknown): Promise<void>;
}

declare global {
  interface Window {
    ace: AceApi;
  }
}

export const ace = window.ace;

/** ByteReader backed by the main process. */
export function ipcReader(path: string, size: number): ByteReader {
  return {
    size,
    read: (offset, length) => ace.read(path, offset, Math.min(length, size - offset)),
  };
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

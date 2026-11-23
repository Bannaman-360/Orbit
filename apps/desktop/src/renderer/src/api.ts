import type { ByteReader } from '@ace/engine';
import type { OrientationData } from '@ace/telemetry';
import type { CardRecording, ImportEvent } from '../../main/card';

export interface Card { root: string; name: string }
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
  setWindow(o: { mode: 'auto' | 'light' | 'dark'; translucent: boolean }): Promise<void>;
  /** Menu bar choices. */
  onCommand(f: (cmd: string) => void): void;
  onWindowFullscreen(f: (on: boolean) => void): void;
  saveDialog(kind: 'project' | 'video' | 'mov' | 'image' | 'theme', defaultName: string): Promise<string | null>;
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
  proxyFinish(file: string): Promise<void>;
  proxyDiscard(file: string): Promise<void>;
  listFixtures(): Promise<string[]>;
  orientation(path: string, req: unknown): Promise<OrientationData>;
  autosaveLoad(): Promise<string | null>;
  autosaveSave(text: string): Promise<void>;
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

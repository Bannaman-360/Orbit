import type { ByteReader } from '@ace/engine';
import type { OrientationData } from '@ace/telemetry';

export interface AceApi {
  info(): Promise<{ selftest: boolean; selftestMode: string; fixtures: string; versions: Record<string, string> }>;
  openMediaDialog(): Promise<string[]>;
  openAudioDialog(): Promise<string[]>;
  openLutDialog(): Promise<string | null>;
  openProjectDialog(): Promise<{ path: string; text: string } | null>;
  openThemeDialog(): Promise<string | null>;
  setWindow(o: { mode: 'auto' | 'light' | 'dark'; translucent: boolean }): Promise<void>;
  /** Menu bar choices. */
  onCommand(f: (cmd: string) => void): void;
  onWindowFullscreen(f: (on: boolean) => void): void;
  saveDialog(kind: 'project' | 'video' | 'image' | 'theme', defaultName: string): Promise<string | null>;
  stat(path: string): Promise<{ path: string; size: number }>;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  readAll(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<string>;
  createFile(path: string): Promise<void>;
  writeAt(path: string, position: number, data: Uint8Array): Promise<void>;
  closeFile(path: string): Promise<void>;
  proxyPath(src: string, level: number): Promise<{ path: string; exists: boolean }>;
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

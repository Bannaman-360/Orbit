import type { ByteReader } from '@ace/engine';
import type { OrientationData } from '@ace/telemetry';

export interface AceApi {
  info(): Promise<{ selftest: boolean; fixtures: string; versions: Record<string, string> }>;
  openDialog(): Promise<{ path: string; size: number } | null>;
  stat(path: string): Promise<{ path: string; size: number }>;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  listFixtures(): Promise<string[]>;
  orientation(path: string, req: unknown): Promise<OrientationData>;
  writeFixture(name: string, data: Uint8Array): Promise<string>;
  capture(name: string): Promise<string>;
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

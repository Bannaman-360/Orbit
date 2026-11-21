import { contextBridge, ipcRenderer } from 'electron';

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  openDialog: () => ipcRenderer.invoke('media:open-dialog'),
  stat: (path: string) => ipcRenderer.invoke('media:stat', path),
  read: (path: string, offset: number, length: number) => ipcRenderer.invoke('media:read', path, offset, length),
  listFixtures: () => ipcRenderer.invoke('media:list-fixtures'),
  orientation: (path: string, req: unknown) => ipcRenderer.invoke('telemetry:orientation', path, req),
  writeFixture: (name: string, data: Uint8Array) => ipcRenderer.invoke('fixtures:write', name, data),
  capture: (name: string) => ipcRenderer.invoke('selftest:capture', name),
  selftestDone: (report: unknown) => ipcRenderer.invoke('selftest:done', report),
};

contextBridge.exposeInMainWorld('ace', api);

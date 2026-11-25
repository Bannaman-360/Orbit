// The updater against a local stand-in for GitHub Releases: which release it picks, the download
// and its checksum, what it says when a release isn't ready for this computer, and the Mac swap
// script (including putting the old app back when the new one can't be copied).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => os.tmpdir(), isPackaged: true, quit: () => {} },
  net: { fetch: (url: string, init?: RequestInit) => fetch(url, init) },
  shell: { openExternal: () => {} },
}));
vi.mock('./diagnostics', () => ({ log: () => {} }));
const { setupUpdater, MAC_SCRIPT } = await import('./updater');
type State = ReturnType<ReturnType<typeof setupUpdater>['state']>;

let root = '', base = '', server: http.Server;
const sha512 = (b: Buffer | string) => createHash('sha512').update(b).digest('hex');
const sh = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, (e) => (e ? rej(e) : res())));

/** A release as GitHub lists it, with its files written to the server. */
async function release(tag: string, files: Record<string, Buffer | string>, o: { draft?: boolean; prerelease?: boolean } = {}) {
  const dir = path.join(root, 'files', tag);
  await mkdir(dir, { recursive: true });
  for (const [n, b] of Object.entries(files)) await writeFile(path.join(dir, n), b);
  return { tag_name: tag, draft: !!o.draft, prerelease: o.prerelease ?? tag.includes('-'), html_url: `https://github.com/x/y/releases/tag/${tag}`, assets: Object.keys(files).map((n) => ({ name: n, browser_download_url: `${base}/files/${tag}/${n}` })) };
}
const publish = (list: unknown[]) => writeFile(path.join(root, 'releases.json'), JSON.stringify(list));
const setup = (current: string, platform: 'darwin' | 'win32' | 'linux' = 'win32', cannotInstall?: () => Promise<string | null>) => {
  const seen: State[] = [];
  const u = setupUpdater({ enabled: false, send: (s) => seen.push(s), busy: () => null, test: { feed: base, current, platform, arch: 'arm64', dir: path.join(root, `dl-${Math.random().toString(36).slice(2)}`), cannotInstall } });
  return { u, seen };
};
const winFiles = (v: string, exe = Buffer.from(`installer ${v}`)) => ({ [`Action-Cam-Editor-${v}-setup.exe`]: exe, 'checksums-windows.txt': `${sha512(exe)}  Action-Cam-Editor-${v}-setup.exe\n` });

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ace-updater-'));
  server = http.createServer(async (req, res) => {
    if (req.url!.startsWith('/hang/')) return; // never answers
    try { res.end(await readFile(path.join(root, decodeURIComponent(req.url!.split('?')[0]!)))); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await rm(root, { recursive: true, force: true }); });

describe('updates', () => {
  it('downloads the newest published release, checks it, and is ready to install', async () => {
    await publish([
      await release('v0.1.0-beta.5', winFiles('0.1.0-beta.5'), { draft: true }),
      await release('v0.1.0-beta.4', winFiles('0.1.0-beta.4')),
      await release('v0.1.0-beta.2', winFiles('0.1.0-beta.2')),
    ]);
    const { u, seen } = setup('0.1.0-beta.3');
    const s = await u.check();
    expect(s).toEqual({ state: 'ready', version: '0.1.0-beta.4' });
    expect(seen.map((x) => x.state)).toEqual(expect.arrayContaining(['checking', 'downloading', 'ready']));
  });
  it('clears a big leftover download, and one a failed clean-up left behind, before downloading again', async () => {
    await publish([await release('v0.1.0-beta.4', winFiles('0.1.0-beta.4'))]);
    const dir = path.join(root, 'leftover', 'updates');
    for (let i = 0; i < 40; i++) {
      const d = path.join(dir, 'new', 'Action Cam Editor.app', 'Contents', 'Resources', `f${i}`, 'a', 'b');
      await mkdir(d, { recursive: true });
      for (let j = 0; j < 10; j++) await writeFile(path.join(d, `x${j}`), 'x');
    }
    await mkdir(path.join(dir + '-old-1', 'new'), { recursive: true });
    const u = setupUpdater({ enabled: false, send: () => {}, busy: () => null, test: { feed: base, current: '0.1.0-beta.3', platform: 'win32', arch: 'arm64', dir } });
    expect(await u.check()).toEqual({ state: 'ready', version: '0.1.0-beta.4' });
    expect((await readdir(path.join(root, 'leftover'))).sort()).toEqual(['updates']);
    expect(await readdir(dir)).not.toContain('new');
  });
  it('gives up with a clear message when GitHub never answers, and checks again afresh', async () => {
    const seen: State[] = [];
    const u = setupUpdater({ enabled: false, send: (s) => seen.push(s), busy: () => null, test: { feed: `${base}/hang`, current: '0.1.0-beta.3', platform: 'win32', arch: 'arm64', dir: path.join(root, 'dl-hang'), limits: { request: 300, check: 600 } } });
    const s = await u.check();
    expect(s.state).toBe('error');
    expect((s as { message: string }).message).toMatch(/didn’t answer|took too long/);
    expect(u.state().state).toBe('error');
    // A second check isn't stuck behind the first.
    expect((await u.check()).state).toBe('error');
  });
  it('says it is up to date when nothing newer is published', async () => {
    await publish([await release('v0.1.0-beta.3', winFiles('0.1.0-beta.3')), await release('v0.1.0-beta.9', winFiles('0.1.0-beta.9'), { draft: true })]);
    expect(await setup('0.1.0-beta.3').u.check()).toEqual({ state: 'current', version: '0.1.0-beta.3' });
  });
  it('offers test versions only to people already on one', async () => {
    await publish([await release('v0.3.0-beta.1', winFiles('0.3.0-beta.1')), await release('v0.2.0', winFiles('0.2.0'))]);
    expect(await setup('0.1.0').u.check()).toEqual({ state: 'ready', version: '0.2.0' });
    expect(await setup('0.2.0').u.check()).toEqual({ state: 'current', version: '0.2.0' });
    expect(await setup('0.2.0-beta.1').u.check()).toEqual({ state: 'ready', version: '0.3.0-beta.1' });
  });
  it('waits quietly while this computer’s half of a release is missing, and says so when asked', async () => {
    // Only the Mac half is up; this is a Windows copy.
    await publish([await release('v0.1.0-beta.4', { 'Action-Cam-Editor-0.1.0-beta.4-mac-arm64.zip': 'zip', 'checksums-mac.txt': `${sha512('zip')}  Action-Cam-Editor-0.1.0-beta.4-mac-arm64.zip\n` })]);
    const { u, seen } = setup('0.1.0-beta.3');
    const asked = await u.check();
    expect(asked.state).toBe('error');
    expect(asked.state === 'error' && asked.message).toMatch(/still being prepared for this computer/);
    expect(seen.at(-1)?.state).toBe('error');
  });
  it('refuses a damaged download', async () => {
    const files = winFiles('0.1.0-beta.4');
    files['checksums-windows.txt'] = `${sha512('something else')}  Action-Cam-Editor-0.1.0-beta.4-setup.exe\n`;
    await publish([await release('v0.1.0-beta.4', files)]);
    const s = await setup('0.1.0-beta.3').u.check();
    expect(s.state === 'error' && s.message).toMatch(/damaged/);
  });
  it('sends people to the download page when this copy can’t replace itself', async () => {
    await publish([await release('v0.1.0-beta.4', winFiles('0.1.0-beta.4'))]);
    const s = await setup('0.1.0-beta.3', 'win32', async () => 'The portable version can’t update itself.').u.check();
    expect(s).toEqual({ state: 'manual', version: '0.1.0-beta.4', url: 'https://github.com/x/y/releases/tag/v0.1.0-beta.4', why: 'The portable version can’t update itself.' });
  });
  it.skipIf(process.platform !== 'darwin')('unpacks the Mac app from its zip, ready to swap in', async () => {
    const work = path.join(root, 'macbuild');
    await mkdir(path.join(work, 'Action Cam Editor.app', 'Contents'), { recursive: true });
    await writeFile(path.join(work, 'Action Cam Editor.app', 'Contents', 'Info.plist'), 'beta 4');
    const zip = path.join(root, 'app.zip');
    await sh('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(work, 'Action Cam Editor.app'), zip]);
    const bytes = await readFile(zip);
    await publish([await release('v0.1.0-beta.4', { 'Action-Cam-Editor-0.1.0-beta.4-mac-arm64.zip': bytes, 'checksums-mac.txt': `${sha512(bytes)}  Action-Cam-Editor-0.1.0-beta.4-mac-arm64.zip\n` })]);
    const { u } = setup('0.1.0-beta.3', 'darwin');
    expect(await u.check()).toEqual({ state: 'ready', version: '0.1.0-beta.4' });
  });
});

describe.skipIf(process.platform !== 'darwin')('the Mac swap', () => {
  // (Mac only: the script uses ditto, which other systems don't have.)
  // (The real script finishes by opening the app; here that's left out.)
  const script = MAC_SCRIPT.replace(/^open .*$/m, ': opened');
  const run = async (newApp: string, dest: string) => {
    const f = path.join(root, `swap-${Math.random().toString(36).slice(2)}.sh`);
    await writeFile(f, script, { mode: 0o755 });
    // A process id that has already ended: no waiting.
    await sh('/bin/sh', [f, '999999', newApp, dest]);
  };
  const appDir = async (where: string, text: string) => { await mkdir(path.join(where, 'Contents'), { recursive: true }); await writeFile(path.join(where, 'Contents', 'Info.plist'), text); };
  it('replaces the app with the new one', async () => {
    const d = path.join(root, 'swap1');
    await appDir(path.join(d, 'Applications', 'Action Cam Editor.app'), 'old');
    await appDir(path.join(d, 'new', 'Action Cam Editor.app'), 'new');
    await run(path.join(d, 'new', 'Action Cam Editor.app'), path.join(d, 'Applications', 'Action Cam Editor.app'));
    expect(await readFile(path.join(d, 'Applications', 'Action Cam Editor.app', 'Contents', 'Info.plist'), 'utf8')).toBe('new');
    expect(existsSync(path.join(d, 'Applications', 'Action Cam Editor.app.updating-old'))).toBe(false);
  });
  it('puts the old app back if the new one can’t be copied', async () => {
    const d = path.join(root, 'swap2');
    await appDir(path.join(d, 'Applications', 'Action Cam Editor.app'), 'old');
    await run(path.join(d, 'missing', 'Action Cam Editor.app'), path.join(d, 'Applications', 'Action Cam Editor.app'));
    expect(await readFile(path.join(d, 'Applications', 'Action Cam Editor.app', 'Contents', 'Info.plist'), 'utf8')).toBe('old');
  });
});

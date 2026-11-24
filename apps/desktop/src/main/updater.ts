// Updates from the project's GitHub Releases.
//
// The app isn't signed yet, and the standard Electron updater only installs into signed Mac apps,
// so this does it itself: it finds the newest published release, downloads this computer's file
// in the background, checks it against the release's checksums file (checksums-mac.txt or
// checksums-windows.txt: each half of a release is built separately), and installs when the user
// chooses Restart (Mac: swaps the app bundle once the app has quit; Windows: runs the installer
// silently). Drafts are never offered: a release reaches testers when it's published.
import { app, net, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { access, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from './diagnostics';
import { checksumFor, compareVersions, isVersion } from './versions';

const REPO = 'Bannaman-360/Orbit';
const RELEASES = `https://github.com/${REPO}/releases`;
const FIRST_CHECK_MS = 20_000;
const EVERY_MS = 6 * 3600_000;

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; version: string }
  | { state: 'downloading'; version: string; fraction: number }
  | { state: 'ready'; version: string }
  /** There's a newer version, but it has to be installed by hand (`why` says why). */
  | { state: 'manual'; version: string; url: string; why: string }
  | { state: 'error'; message: string };

interface Release { tag_name: string; draft: boolean; prerelease: boolean; html_url: string; assets: { name: string; browser_download_url: string }[] }

export function setupUpdater(o: { enabled: boolean; send: (s: UpdateState) => void; busy: () => string | null }) {
  let state: UpdateState = { state: 'idle' };
  let install: (() => void) | null = null;
  let running: Promise<UpdateState> | null = null;
  const dir = () => path.join(app.getPath('userData'), 'updates');
  const set = (s: UpdateState) => { state = s; o.send(s); return s; };
  const current = app.getVersion();
  const mac = process.platform === 'darwin', win = process.platform === 'win32';

  const fetchOk = async (url: string, accept?: string) => {
    const r = await net.fetch(url, { headers: { 'User-Agent': 'ActionCamEditor-Updater', ...(accept ? { Accept: accept } : {}) } });
    if (!r.ok) throw new Error(`${url.replace(/^https:\/\/[^/]+/, '')} answered ${r.status}`);
    return r;
  };

  /** The newest published release newer than this one (betas only for people already on a beta). */
  const newest = async (): Promise<Release | null> => {
    const list = (await (await fetchOk(`https://api.github.com/repos/${REPO}/releases?per_page=20`, 'application/vnd.github+json')).json()) as Release[];
    const onBeta = current.includes('-');
    return list
      .filter((r) => !r.draft && isVersion(r.tag_name) && (onBeta || !r.prerelease) && compareVersions(r.tag_name, current) > 0)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
  };

  /** Why this copy of the app can't replace itself, if it can't. */
  const cannotInstall = async (): Promise<string | null> => {
    if (!app.isPackaged) return 'This is a development copy.';
    if (win) return process.env.PORTABLE_EXECUTABLE_FILE ? 'The portable version can’t update itself.' : null;
    if (!mac) return 'Updates are only installed on Mac and Windows.';
    const bundle = macBundle();
    if (!bundle.endsWith('.app')) return 'The app’s location couldn’t be found.';
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return 'The app is running from the download, not from Applications. Drag it into the Applications folder first.';
    try { await access(bundle, constants.W_OK); await access(path.dirname(bundle), constants.W_OK); } catch { return 'This Mac account can’t change the app in its folder.'; }
    return null;
  };
  const macBundle = () => path.resolve(app.getPath('exe'), '..', '..', '..');
  const assetName = (v: string) => (mac ? `Action-Cam-Editor-${v}-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip` : `Action-Cam-Editor-${v}-setup.exe`);

  /** Downloads to `to`, reporting progress; returns the file's sha512 (hex). */
  const download = async (url: string, to: string, progress: (f: number) => void) => {
    const r = await fetchOk(url);
    const total = Number(r.headers.get('content-length')) || 0;
    const hash = createHash('sha512');
    const fh = await open(to, 'w');
    try {
      const reader = r.body!.getReader();
      let got = 0, shown = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await fh.write(value);
        got += value.length;
        if (total && got - shown > total / 200) { shown = got; progress(got / total); }
      }
    } finally {
      await fh.close();
    }
    return hash.digest('hex');
  };

  const run = async (byHand: boolean): Promise<UpdateState> => {
    if (state.state === 'ready' || state.state === 'downloading') return state;
    set({ state: 'checking' });
    try {
      const rel = await newest();
      if (!rel) return set({ state: 'current', version: current });
      const v = rel.tag_name.replace(/^v/, '');
      const manual = (why: string) => set({ state: 'manual', version: v, url: rel.html_url, why });
      const why = await cannotInstall();
      if (why) return manual(why);
      const sumsName = mac ? 'checksums-mac.txt' : 'checksums-windows.txt';
      const file = rel.assets.find((a) => a.name === assetName(v)), sums = rel.assets.find((a) => a.name === sumsName) ?? rel.assets.find((a) => a.name === 'checksums.txt');
      // (Each computer's half of a release is added separately: wait for this one's, checking again later.)
      if (!file || !sums) return set(byHand ? { state: 'error', message: `Version ${v} is still being prepared for this computer. Try again in a little while.` } : { state: 'idle' });
      const want = checksumFor(await (await fetchOk(sums.browser_download_url)).text(), file.name);
      if (!want) return set(byHand ? { state: 'error', message: `Version ${v} is still being prepared for this computer. Try again in a little while.` } : { state: 'idle' });

      // Earlier downloads are no longer needed.
      await rm(dir(), { recursive: true, force: true });
      await mkdir(dir(), { recursive: true });
      const to = path.join(dir(), file.name);
      set({ state: 'downloading', version: v, fraction: 0 });
      const got = await download(file.browser_download_url, `${to}.part`, (f) => set({ state: 'downloading', version: v, fraction: f }));
      if (got !== want) throw new Error('The download was damaged (its checksum doesn’t match). It will be tried again later.');
      await rename(`${to}.part`, to);

      if (mac) {
        const out = path.join(dir(), 'new');
        await new Promise<void>((res, rej) => execFile('/usr/bin/ditto', ['-x', '-k', to, out], (e) => (e ? rej(e) : res())));
        const name = (await readdir(out)).find((n) => n.endsWith('.app'));
        if (!name) throw new Error('The download had no app in it.');
        const newApp = path.join(out, name), script = path.join(dir(), 'install.sh');
        await writeFile(script, MAC_SCRIPT, { mode: 0o755 });
        install = () => spawn('/bin/sh', [script, String(process.pid), newApp, macBundle()], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // (--force-run starts the app again after a silent install.)
        install = () => spawn(to, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      }
      log('info', 'update', `version ${v} downloaded`);
      return set({ state: 'ready', version: v });
    } catch (e) {
      const message = String(e).replace(/^(Type)?Error: /, '');
      log('error', 'update', message);
      // Checks in the background fail quietly (offline, GitHub busy…); they're tried again later.
      return set(byHand ? { state: 'error', message: `The update check didn’t work: ${message.replace(/\.?$/, '.')} Check the internet connection and try again.` } : { state: 'idle' });
    }
  };
  const check = (byHand: boolean) => (running ??= run(byHand).finally(() => { running = null; }));

  if (o.enabled) {
    // Leftovers from an update that was installed.
    if (existsSync(dir())) void rm(dir(), { recursive: true, force: true }).catch(() => {});
    setTimeout(() => void check(false), FIRST_CHECK_MS);
    setInterval(() => void check(false), EVERY_MS);
  }

  return {
    state: () => state,
    check: () => check(true),
    /** Quits and installs the downloaded version. Returns why not, if it can't now. */
    install: (): string | null => {
      if (state.state !== 'ready' || !install) return 'No update is ready yet.';
      const busy = o.busy();
      if (busy) return busy;
      log('info', 'update', `installing version ${state.version}`);
      install();
      app.quit();
      return null;
    },
    openReleases: (url?: string) => void shell.openExternal(url?.startsWith(RELEASES) ? url : RELEASES),
  };
}

// Waits for the app to quit, swaps in the new one (putting the old one back if that fails), and
// starts it again.
const MAC_SCRIPT = `#!/bin/sh
pid="$1"; new="$2"; dest="$3"
while kill -0 "$pid" 2>/dev/null; do sleep 0.3; done
old="$dest.updating-old"
rm -rf "$old"
if mv "$dest" "$old"; then
  if ditto "$new" "$dest"; then rm -rf "$old"; else rm -rf "$dest"; mv "$old" "$dest"; fi
fi
xattr -dr com.apple.quarantine "$dest" 2>/dev/null
open "$dest"
`;

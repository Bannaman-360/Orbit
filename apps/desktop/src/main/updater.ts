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
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { log } from './diagnostics';
import { checksumFor, compareVersions, isVersion } from './versions';

// Electron's own `fs` treats .asar files as folders, so removing a downloaded app (its
// Resources/app.asar) never finishes and every later check waits on it. `original-fs` is the
// plain one. (Loaded at run time so the bundler leaves it alone; tests use node:fs.)
// eslint-disable-next-line no-eval
const fsx: typeof nodeFs = process.versions.electron ? (eval('require') as NodeRequire)('original-fs') : nodeFs;
const { constants, existsSync } = fsx;
const { access, mkdir, open, readdir, rename, rm, writeFile } = fsx.promises;

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

/** For tests: releases from a local server instead of GitHub, and a stand-in for this copy. */
export interface UpdaterTest {
  /** Base URL serving releases.json and the files it lists. */
  feed: string;
  current: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64';
  /** Where downloads go. */
  dir: string;
  /** Why this copy couldn't replace itself (default: it can). */
  cannotInstall?: () => Promise<string | null>;
  /** Shorter time limits (ms) so tests don't wait long. */
  limits?: { request?: number; stall?: number; check?: number };
}

/** A request for the release list or checksums gets this long. */
const REQUEST_MS = 20_000;
/** A download that receives nothing for this long is given up. */
const STALL_MS = 60_000;
/** A check (before downloading starts) gets this long in all. */
const CHECK_MS = 45_000;

class TimedOut extends Error {}

export function setupUpdater(o: { enabled: boolean; send: (s: UpdateState) => void; busy: () => string | null; test?: UpdaterTest }) {
  let state: UpdateState = { state: 'idle' };
  let install: (() => void) | null = null;
  let running: Promise<UpdateState> | null = null;
  const dir = () => o.test?.dir ?? path.join(app.getPath('userData'), 'updates');
  const set = (s: UpdateState) => { state = s; o.send(s); return s; };
  // Clears earlier downloads. The folder is first moved aside (instant, so a new download can start
  // right away) and deleted after; deletes run one at a time, since two at once over a big .app fail
  // with ENOTEMPTY.
  let clearing: Promise<void> = Promise.resolve();
  const clear = () => (clearing = clearing.catch(() => {}).then(async () => {
    const d = dir(), parent = path.dirname(d), base = path.basename(d);
    const old = (await readdir(parent).catch(() => [] as string[])).filter((n) => n.startsWith(`${base}-old-`)).map((n) => path.join(parent, n));
    if (existsSync(d)) {
      const aside = `${d}-old-${Date.now()}`;
      try { await rename(d, aside); old.push(aside); } catch { await rm(d, { recursive: true, force: true, maxRetries: 5 }); }
    }
    for (const o of old) await rm(o, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }));
  const current = o.test?.current ?? app.getVersion();
  const platform = o.test?.platform ?? process.platform, arch = o.test?.arch ?? process.arch;
  const mac = platform === 'darwin', win = platform === 'win32';

  const limit = { request: o.test?.limits?.request ?? REQUEST_MS, stall: o.test?.limits?.stall ?? STALL_MS, check: o.test?.limits?.check ?? CHECK_MS };
  const fetchOk = async (url: string, accept?: string, signal: AbortSignal = AbortSignal.timeout(limit.request)) => {
    try {
      const r = await net.fetch(url, { signal, headers: { 'User-Agent': 'ActionCamEditor-Updater', ...(accept ? { Accept: accept } : {}) } });
      if (!r.ok) throw new Error(`${url.replace(/^https:\/\/[^/]+/, '')} answered ${r.status}`);
      return r;
    } catch (e) {
      if (signal.aborted) throw new TimedOut('GitHub didn’t answer in time');
      throw e;
    }
  };
  /** Small downloads (the release list, checksums): the time limit covers reading the body too. */
  const fetchText = async (url: string, accept?: string) => {
    const signal = AbortSignal.timeout(limit.request);
    const r = await fetchOk(url, accept, signal);
    try { return await r.text(); } catch (e) { if (signal.aborted) throw new TimedOut('GitHub didn’t answer in time'); throw e; }
  };

  /** The newest published release newer than this one (betas only for people already on a beta). */
  const newest = async (): Promise<Release | null> => {
    const list = JSON.parse(await fetchText(o.test ? `${o.test.feed}/releases.json` : `https://api.github.com/repos/${REPO}/releases?per_page=20`, 'application/vnd.github+json')) as Release[];
    const onBeta = current.includes('-');
    return list
      .filter((r) => !r.draft && isVersion(r.tag_name) && (onBeta || !r.prerelease) && compareVersions(r.tag_name, current) > 0)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
  };

  /** Why this copy of the app can't replace itself, if it can't. */
  const cannotInstall = async (): Promise<string | null> => {
    if (o.test) return (await o.test.cannotInstall?.()) ?? null;
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
  const assetName = (v: string) => (mac ? `Action-Cam-Editor-${v}-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.zip` : `Action-Cam-Editor-${v}-setup.exe`);

  /** Downloads to `to`, reporting progress; returns the file's sha512 (hex). */
  const download = async (url: string, to: string, progress: (f: number) => void) => {
    // Given up when nothing arrives for a while (a connection that hangs instead of failing).
    const abort = new AbortController();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const alive = () => { clearTimeout(stall); stall = setTimeout(() => abort.abort(), limit.stall); };
    alive();
    const r = await fetchOk(url, undefined, abort.signal).catch((e) => { clearTimeout(stall); throw e; });
    const total = Number(r.headers.get('content-length')) || 0;
    const hash = createHash('sha512');
    const fh = await open(to, 'w');
    try {
      const reader = r.body!.getReader();
      let got = 0, shown = 0;
      for (;;) {
        const { done, value } = await reader.read().catch((e) => { throw abort.signal.aborted ? new TimedOut('The download stopped arriving') : e; });
        alive();
        if (done) break;
        hash.update(value);
        await fh.write(value);
        got += value.length;
        if (total && got - shown > total / 200) { shown = got; progress(got / total); }
      }
    } finally {
      clearTimeout(stall);
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
      const want = checksumFor(await fetchText(sums.browser_download_url), file.name);
      if (!want) return set(byHand ? { state: 'error', message: `Version ${v} is still being prepared for this computer. Try again in a little while.` } : { state: 'idle' });

      // Earlier downloads are no longer needed. (A clean-up that can't finish mustn't hold up the
      // update: after 20 s the download goes ahead; the folder is reused.)
      await Promise.race([clear(), new Promise((r) => setTimeout(r, 20_000))]);
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
      // (Errors with a code like ENOTEMPTY come from the disk, not the network.)
      const disk = typeof (e as { code?: unknown })?.code === 'string' && /^E[A-Z]+$/.test((e as { code: string }).code) && !/^E(CONN|HOST|NET|AI_|TIMEDOUT|PIPE)/.test((e as { code: string }).code);
      const hint = disk ? 'Restart the app and try again.' : e instanceof TimedOut ? 'Try again in a few minutes.' : 'Check the internet connection and try again.';
      return set(byHand ? { state: 'error', message: `The update check didn’t work: ${message.replace(/\.?$/, '.')} ${hint}` } : { state: 'idle' });
    }
  };
  // A check never stays on "Checking…": past the time limit it ends with a message, and the next
  // check starts afresh (a download already under way carries on; it has its own stall limit).
  const timed = (byHand: boolean): Promise<UpdateState> => {
    const job = run(byHand);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<UpdateState>((res) => {
      timer = setTimeout(() => {
        if (state.state !== 'checking') return;
        log('error', 'update', 'check took too long');
        res(set(byHand ? { state: 'error', message: 'The update check took too long: GitHub didn’t answer. Try again in a few minutes.' } : { state: 'idle' }));
      }, limit.check);
    });
    return Promise.race([job.then((s) => (state.state === 'checking' ? s : state)), late]).finally(() => clearTimeout(timer));
  };
  const check = (byHand: boolean) => (running ??= timed(byHand).finally(() => { running = null; }));

  if (o.enabled) {
    // Leftovers from an update that was installed.
    void clear().catch(() => {});
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
export const MAC_SCRIPT = `#!/bin/sh
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

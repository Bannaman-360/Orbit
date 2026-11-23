// What goes into the problem log, made safe to share: no home folder, no folder names, just the
// file names (enough to tell which clip, without telling where someone keeps their files).

/** Paths in a message cut to their last part; the home folder written as ~. */
export function scrub(text: string, home: string): string {
  let s = text;
  if (home) {
    const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'gi'), '~');
  }
  // URLs into the app itself (file:///…/app.asar/out/…) keep only the file name.
  s = s.replace(/file:\/\/\/[^\s)'"]*\/([^\s/)'"]+)/g, '$1');
  // Unix paths: every folder up to the last “/” goes (folder names may have spaces), the file
  // name stays: /Volumes/Card/DCIM/100GOPRO/GX010001.MP4 → …/GX010001.MP4
  s = s.replace(/(^|[\s'"(=:])((?:~|\/)(?:[^/\n'"()]*\/)+)([^\s/'"()]+)/g, (_m, pre: string, _dir: string, name: string) => `${pre}…/${name}`);
  // Windows paths: C:\Users\Name\Videos\clip.mp4 or \\server\share\clip.mp4 → …\clip.mp4
  s = s.replace(/(^|[\s'"(=:])((?:[A-Za-z]:|~|\\\\[^\s\\'"()]+)\\(?:[^\\\n'"()]*\\)*)([^\s\\'"()]+)/g, (_m, pre: string, _dir: string, name: string) => `${pre}…\\${name}`);
  return s;
}

/** One log line. */
export function logLine(level: 'error' | 'warn' | 'info', source: string, message: string, home: string, at = new Date()): string {
  const one = scrub(message, home).replace(/\r?\n/g, '\n    ').slice(0, 4000);
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${one}\n`;
}

/** Drops a message repeated within a short time, and caps how many get written per minute. */
export function makeLimiter(perMinute = 120, repeatMs = 2000) {
  const last = new Map<string, number>();
  let windowStart = 0, count = 0;
  return (key: string, now = Date.now()) => {
    if (now - windowStart > 60_000) { windowStart = now; count = 0; }
    const prev = last.get(key);
    if (prev !== undefined && now - prev < repeatMs) return false;
    last.set(key, now);
    if (last.size > 500) last.clear();
    return ++count <= perMinute;
  };
}

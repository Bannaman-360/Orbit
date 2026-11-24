// File names for projects: what the user typed, made safe on Mac and Windows, never clashing.

/** A file name (without extension) from what the user typed. */
export function projectFileName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // (Windows won't take a name ending in a dot, and a leading dot hides the file.)
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? `${clean} project` : clean || 'Untitled project';
}

/** `base` + `ext`, or `base 2` + `ext`, `base 3`… whichever isn't taken (ignoring case). */
export function uniqueName(base: string, taken: string[], ext: string): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = `${i === 1 ? base : `${base} ${i}`}${ext}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

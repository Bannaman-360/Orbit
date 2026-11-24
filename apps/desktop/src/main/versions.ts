// Version numbers as releases are tagged: 0.1.0, 0.1.0-beta.3 (a leading "v" is fine).

const parse = (v: string) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  return m ? { nums: [+m[1]!, +m[2]!, +m[3]!], pre: m[4] ? m[4].split('.') : [] } : null;
};

/** Negative if a is older than b, positive if newer, 0 if the same (or either can't be read). */
export function compareVersions(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  // A test version comes before the finished one: 1.0.0-beta.2 < 1.0.0.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const isVersion = (v: string) => parse(v) !== null;

/** The sha512 (hex) listed for a file in a `sha512sum` / `shasum -a 512` output. */
export function checksumFor(list: string, file: string): string | null {
  for (const line of list.split(/\r?\n/)) {
    const m = /^([0-9a-f]{128})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2]!.split('/').pop() === file) return m[1]!.toLowerCase();
  }
  return null;
}

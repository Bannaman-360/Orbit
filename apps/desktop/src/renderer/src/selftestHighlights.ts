// HiLight tags: read from the file, listed in Clip ▸ HiLight tags, shown on the timeline and in
// Media, and turned into markers. None of the real rides have tags, so a copy of a short Max 2
// clip gets two, written into its (empty) HMMT box: same size, nothing else in the file moves.
// Runs hidden.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { openSection } from './ui';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = <T extends HTMLElement = HTMLElement>(q: string) => [...document.querySelectorAll<T>(q)];
const button = (text: string) => $$<HTMLButtonElement>('button').find((b) => b.textContent === text);

export async function highlightsCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const src = all.find((f) => f.endsWith('max2/GS010114.360'));
  if (!src) return { fails: ['needs fixtures/max2/GS010114.360'], ...out };

  // Untagged files have none (every real ride, .360 and .MP4).
  const untagged: Record<string, number[]> = {};
  for (const f of all.filter((x) => /max2\/G[SX]\d+\.(360|MP4)$/i.test(x)).slice(0, 4)) untagged[f.split('/').pop()!] = (await getMedia(f)).hilights;
  ok('files without tags have none', Object.values(untagged).every((t) => t.length === 0), untagged);

  // A copy with two tags.
  const orig = await getMedia(src);
  const want = [Math.round(orig.durationUs * 0.25 / 1000) * 1000, Math.round(orig.durationUs * 0.7 / 1000) * 1000];
  const bytes = new Uint8Array((await ace.readAll(src)) as Uint8Array);
  let at = -1;
  for (let i = bytes.length - 8; i > 0; i--) if (bytes[i] === 0x48 && bytes[i + 1] === 0x4d && bytes[i + 2] === 0x4d && bytes[i + 3] === 0x54) { at = i + 4; break; }
  ok('the clip has an HMMT box to write into', at > 0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dv.setUint32(at, 2); dv.setUint32(at + 4, want[0]! / 1000); dv.setUint32(at + 8, want[1]! / 1000);
  const path = await ace.writeFile(`${await ace.selftestOut('hilight')}/GS010114.360`, bytes);
  const m = await getMedia(path);
  ok('reads the tags from the file', JSON.stringify(m.hilights) === JSON.stringify(want), { got: m.hilights, want });

  // In the app.
  await api.importPaths([m.path]);
  api.setTimeline(addClip(emptyTimeline(), newClip(m.path, m.durationUs, true)));
  api.player.seek(0);
  await sleep(600);
  ok('Media says how many tags', $$('.bin-item').some((e) => e.textContent?.includes('2 HiLights')), $$('.bin-item').map((e) => e.textContent));
  ok('a star on the timeline at each', $$('.clip-star').length === 2, $$('.clip-star').length);
  document.querySelector<HTMLElement>('.dock-tab[data-panel="clip"]')?.click();
  openSection('HiLight tags');
  await sleep(500);
  const rows = $$('[data-section="HiLight tags"] .hl-row');
  ok('Clip ▸ HiLight tags lists them', rows.length === 2, rows.map((r) => r.textContent));
  document.querySelector('[data-section="HiLight tags"]')?.scrollIntoView({ block: 'start' });
  await sleep(200);
  await ace.capture('hilight-section');
  rows[1]?.click();
  await sleep(200);
  ok('clicking one goes to it', Math.abs(api.player.time - want[1]!) < 50_000, { at: api.player.time, want: want[1] });
  api.player.seek(0);
  await sleep(200);
  $$<HTMLElement>('.clip-star')[0]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await sleep(200);
  ok('clicking a star goes to it', Math.abs(api.player.time - want[0]!) < 50_000, { at: api.player.time, want: want[0] });

  button('Add as markers')?.click();
  await sleep(300);
  const mk = api.getTimeline().markers;
  ok('Add as markers puts a marker at each', mk.length === 2 && mk.every((x, i) => Math.abs(x.t - want[i]!) < 1000 && x.note === `HiLight ${i + 1}`), mk.map((x) => `${x.t} ${x.note}`));
  button('Add as markers')?.click();
  await sleep(300);
  ok('adding again doesn’t double them', api.getTimeline().markers.length === 2);

  // A clip trimmed to leave the second tag out lists one, and says one is elsewhere.
  const half = Math.round((want[0]! + want[1]!) / 2);
  api.setTimeline(addClip(emptyTimeline(), { ...newClip(m.path, m.durationUs, true), outUs: half }));
  api.player.seek(0);
  await sleep(600);
  openSection('HiLight tags');
  await sleep(300);
  const sect = document.querySelector('[data-section="HiLight tags"]')?.textContent ?? '';
  ok('a trimmed clip lists only its own', $$('[data-section="HiLight tags"] .hl-row').length === 1 && sect.includes('1 more tag is in parts of the file'), sect.slice(0, 200));

  return { fails, ...out };
}

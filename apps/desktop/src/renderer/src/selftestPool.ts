// The Media pool: ratings, favourites and rejects, search and filters, folders, saving them with
// the project, finding missing files again (by name, or by size when renamed), and preview copies.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const F = ace.selftestFiles;

export async function poolCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end))!;
  // Fresh copies to rename and move later.
  await F('remove', 'away/pool');
  await F('copy', fix('GX010133.MP4'), 'away/pool/orig/GX010133.MP4');
  await F('copy', fix('GX010132.MP4'), 'away/pool/orig/GX010132.MP4');
  const dir = (await ace.selftestOut('away')) + '/pool';
  const p1 = `${dir}/orig/GX010133.MP4`, p2 = `${dir}/orig/GX010132.MP4`;
  await api.restore!(JSON.stringify({ version: 2, timeline: emptyTimeline(), library: [], bins: [] }));
  await api.importPaths([p1, p2]);
  await sleep(800);
  const item = (name: string) => $$('.bin-item').find((e) => e.querySelector('.name')?.textContent?.includes(name))!;

  // Stars, favourite, reject.
  item('GX010133').querySelectorAll<HTMLButtonElement>('.bin-rate .star')[3]!.click();
  item('GX010133').querySelector<HTMLButtonElement>('.bin-rate .fav')!.click();
  item('GX010132').querySelector<HTMLButtonElement>('.bin-rate .reject')!.click();
  await sleep(200);
  ok('rates, marks favourite and reject', item('GX010133').querySelectorAll('.star.on').length === 4 && !!item('GX010133').querySelector('.fav.on') && item('GX010132').classList.contains('rejected'));

  // Filters and search.
  const select = document.querySelector<HTMLSelectElement>('.bin-filter select')!;
  const setSel = (v: string) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, v); select.dispatchEvent(new Event('change', { bubbles: true })); };
  setSel('fav'); await sleep(150);
  const favOnly = $$('.bin-item .name').map((e) => e.textContent);
  setSel('notRejected'); await sleep(150);
  const noRejects = $$('.bin-item .name').map((e) => e.textContent);
  setSel('all'); await sleep(150);
  const search = document.querySelector<HTMLInputElement>('.bin-filter input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '0132');
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  const found = $$('.bin-item .name').map((e) => e.textContent);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '');
  search.dispatchEvent(new Event('input', { bubbles: true }));
  ok('filters: favourites, hide rejected, search', favOnly.length === 1 && /0133/.test(favOnly[0]!) && noRejects.length === 1 && found.length === 1 && /0132/.test(found[0]!), { favOnly, noRejects, found });

  // A folder, and an item dragged into it.
  document.querySelector<HTMLButtonElement>('.bin-more')!.click();
  await sleep(200);
  $$('.bin-menu button').find((b) => /New folder/.test(b.textContent ?? ''))!.click();
  await sleep(200);
  const nameInput = document.querySelector<HTMLInputElement>('.bin-folder-head input')!;
  nameInput.value = 'Pump track';
  // (A hidden window has no focus to lose: send what a click elsewhere would.)
  nameInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await sleep(200);
  const dt = new DataTransfer();
  dt.setData('text/x-ace-media', p1);
  const folder = document.querySelector<HTMLElement>('.bin-folder')!;
  folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(200);
  ok('folders hold dragged-in videos', document.querySelector('.bin-folder-name')?.textContent === 'Pump track' && !!document.querySelector('.bin-folder .bin-item') && /0133/.test(document.querySelector('.bin-folder .bin-item .name')?.textContent ?? ''));
  await ace.capture('pool-folders');

  // All of it is saved with the project.
  const m1 = await getMedia(p1), m2 = await getMedia(p2);
  api.setTimeline(addClip(addClip(emptyTimeline(), newClip(p1, m1.durationUs, false)), newClip(p2, m2.durationUs, false)));
  await sleep(200);
  const text = api.saveText!();
  const saved = JSON.parse(text);
  const e1 = saved.library.find((e: { path: string }) => e.path === p1);
  ok('ratings, flags, folders and sizes are saved', e1?.rating === 4 && e1?.flag === 'fav' && !!e1?.bin && e1?.size === m1.size && saved.bins[0]?.name === 'Pump track', { e1, bins: saved.bins });

  // Move one file and rename the other; open the project; find them again.
  await F('move', 'away/pool/orig/GX010133.MP4', 'away/pool/card/DCIM/100GOPRO/GX010133.MP4');
  await F('move', 'away/pool/orig/GX010132.MP4', 'away/pool/card/DCIM/100GOPRO/Ride clip.MP4');
  await api.restore!(text);
  await sleep(800);
  ok('both show as missing', $$('.clip.offline').length === 2 && /2 videos are missing/.test(document.querySelector('.bin-missing')?.textContent ?? ''), { offline: $$('.clip.offline').length, banner: document.querySelector('.bin-missing')?.textContent });
  await api.relink!(`${dir}/card`);
  await sleep(1200);
  const tl = api.getTimeline();
  ok('relink finds a moved file by name and a renamed one by size', !$$('.clip.offline').length && tl.clips[0]!.mediaPath.endsWith('100GOPRO/GX010133.MP4') && tl.clips[1]!.mediaPath.endsWith('Ride clip.MP4'), tl.clips.map((c) => c.mediaPath.split('/').slice(-2).join('/')));
  ok('and keeps their ratings and folders', item('GX010133')?.querySelectorAll('.star.on').length === 4 && !!document.querySelector('.bin-folder .bin-item'));
  ok('and says what it found', /Found 2 of 2.*by size/.test($$('.notice').map((n) => n.textContent).join(' ')), $$('.notice').map((n) => n.textContent));

  // Preview copies: how much room, and deleting them.
  document.querySelector<HTMLButtonElement>('.bin-more')!.click();
  await sleep(600);
  const usageText = $$('.bin-menu p')[0]?.textContent ?? '';
  const del = $$('.bin-menu button').find((b) => /Delete preview copies/.test(b.textContent ?? '')) as HTMLButtonElement;
  const before = await ace.proxyUsage();
  if (!del.disabled) { del.click(); await sleep(600); }
  const after = await ace.proxyUsage();
  ok('shows and deletes preview copies', /Preview copies: \d+ files?, \d/.test(usageText) && after.files === 0, { usageText, before: before.files, after: after.files });
  await ace.capture('pool-menu');
  return { fails, ...out };
}

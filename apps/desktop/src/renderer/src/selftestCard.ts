// Importing from a memory card, with folders standing in for cards. The computer's real drives
// are never looked at.

import { ace } from './api';
import { cardState, running, setOption } from './cardImport';
import { getMedia } from './media';
import { defaultPrefs, setPrefs } from './ui/prefs';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (q: string) => document.querySelector<HTMLElement>(q);
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const button = (text: RegExp) => $$('.modal.import button').find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const tile = (name: string) => $(`.card-tile[aria-label="${name}"]`)!;
const until = async (f: () => boolean, ms = 15000) => { const t = performance.now(); while (!f() && performance.now() - t < ms) await sleep(20); return f(); };
const F = ace.selftestFiles;
const list = (d: string) => F('list', d) as Promise<string[]>;

export async function cardCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  setPrefs(defaultPrefs());
  setOption('addToProject', true);
  setOption('hideImported', false);
  const all = await ace.listFixtures();
  const fix = (end: string) => all.find((f) => f.endsWith(end))!;
  for (const d of ['drives', 'imported', 'away']) await F('remove', d);
  await F('mkdir', 'drives');
  await F('slow', '', 0);
  await F('dest', 'imported/Action Cam');
  await F('forget');
  const A = 'drives/HERO/DCIM/100GOPRO';

  // --- Nothing connected ------------------------------------------------------------------------
  ok('toolbar has the item', $$('.bar-main .tool').some((b) => /Card/.test(b.textContent ?? '') || /memory card/i.test(b.title)));
  api.run!('card');
  await sleep(400);
  ok('says when no card is in', /No memory card found/.test($('.modal.import')?.textContent ?? ''));
  await ace.capture('card-none');

  // --- A card is put in with the window open -------------------------------------------------------
  for (const f of ['GX010900.MP4', 'GX020900.MP4', 'GX030900.MP4', 'GS010116.360', 'GS010120.360', 'GX010133.MP4']) await F('copy', fix(f), `${A}/${f}`);
  await F('copy', fix('GX010132.MP4'), 'drives/HERO/DCIM/101GOPRO/GX010133.MP4');
  await F('write', `${A}/GX010777.MP4`, 'cut off');
  await F('write', `${A}/GL010133.LRV`, 'low res');
  await F('write', `${A}/._GX010133.MP4`, 'notes');
  await F('write', `${A}/GOPR0005.JPG`, 'photo');
  const c = new OffscreenCanvas(160, 120), x = c.getContext('2d')!;
  x.fillStyle = '#2a7';
  x.fillRect(0, 0, 160, 120);
  await F('write', `${A}/GX010133.THM`, new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer()));
  await F('mkdir', 'drives/Backup');
  const cardBefore = await list('drives');
  ok('a card put in appears by itself', await until(() => $$('.card-tile').length > 0, 6000));
  await until(() => !cardState().scanning && $$('.card-tile').length === 6, 4000);
  // (Put in while files were still arriving: look again.)
  const { scan } = await import('./cardImport');
  await scan(cardState().root!);
  await sleep(200);
  const names = $$('.card-tile').map((t) => t.getAttribute('aria-label'));
  ok('lists recordings, not photos or small copies; parts together', names.length === 6 && names.filter((n) => n === 'GX010133.MP4').length === 2 && /3 parts/.test(tile('GX010900.MP4').textContent!), names);
  ok('shows length, 360 and size', /0:/.test(tile('GS010120.360').textContent!) && /360/.test(tile('GS010120.360').textContent!) && /42 MB/.test(tile('GS010120.360').textContent!), tile('GS010120.360').textContent);
  ok('an unfinished recording is marked and not picked', /Unfinished/.test(tile('GX010777.MP4').textContent!) && tile('GX010777.MP4').getAttribute('aria-checked') === 'false');
  ok('new recordings start picked', $$('.card-tile[aria-checked="true"]').length === 5);
  ok('thumbnails appear', await until(() => $$('.card-tile').filter((t) => /url/.test(t.querySelector<HTMLElement>('.thumb')!.style.backgroundImage)).length === 5, 8000), $$('.card-tile').map((t) => t.querySelector<HTMLElement>('.thumb')!.style.backgroundImage));
  ok('no card file is kept open', (await until(() => true)) && ((await F('open')) as number) === 0, await F('open'));
  await ace.capture('card-list');
  const body = $('.import-list')!;
  ok('fits the window', body.scrollWidth <= body.clientWidth && $('.modal.import')!.getBoundingClientRect().bottom < innerHeight && $('.import-foot')!.scrollWidth <= $('.import-foot')!.clientWidth);

  // --- Picking -------------------------------------------------------------------------------------------
  tile('GS010120.360').click();
  await sleep(80);
  ok('click unpicks', tile('GS010120.360').getAttribute('aria-checked') === 'false' && /Import 4/.test(button(/^Import/)!.textContent!), button(/^Import/)!.textContent);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true }));
  await sleep(80);
  ok('⌘A picks all', $$('.card-tile[aria-checked="true"]').length === 6);
  const tl0 = api.getTimeline();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true }));
  await sleep(80);
  ok('editing keys do nothing behind the window', api.getTimeline() === tl0);
  for (const n of ['GX010777.MP4']) tile(n).click();
  await sleep(80);

  // --- Pausing, hiding, resuming --------------------------------------------------------------------------
  await F('slow', '', 25);
  button(/^Import/)!.click();
  ok('starts copying', await until(() => running(cardState().run) && cardState().run!.fraction > 0.02));
  await sleep(250);
  await ace.capture('card-copying');
  button(/Pause/)!.click();
  await sleep(400);
  const p1 = cardState().run!.fraction, l1 = JSON.stringify(await list('imported'));
  await sleep(700);
  ok('pause stops everything', cardState().run!.fraction === p1 && JSON.stringify(await list('imported')) === l1 && /Paused/.test($('.import-status')!.textContent!), p1);
  ok('a file being copied has no real name yet', /\.part/.test(l1));
  button(/Resume/)!.click();
  await sleep(200);
  button(/Keep editing/)!.click();
  await sleep(250);
  ok('carries on with the window closed, and says so', !$('.modal.import') && /Importing \d+%/.test(document.body.textContent!) && running(cardState().run));
  await ace.capture('card-hidden');
  ok('finishes', await until(() => !!cardState().run?.ended, 60000), cardState().run && [...cardState().run!.states.values()].map((s) => s.state));
  await F('slow', '', 0);
  const run = cardState().run!;
  ok('all of it arrived', [...run.states.values()].every((s) => s.state === 'done') && run.states.size === 5, [...run.states.values()]);
  await sleep(1200);
  ok('tells you when it is done', /5 recordings imported/.test(document.body.textContent!));
  // Byte for byte, and the same times.
  let same = true;
  for (const r of cardState().list) if (run.states.has(r.id)) for (const [i, f] of r.files.entries()) {
    const to = (run.states.get(r.id) as { paths: string[] }).paths[i]!;
    if ((await F('hash', f.path)) !== (await F('hash', to))) same = false;
  }
  ok('copies are identical to the card', same);
  const got = await list('imported');
  ok('by day, no half files, names kept', got.length === 7 && got.every((g) => /Action Cam[\\/]\d{4}-\d\d-\d\d( 2)?[\\/]G[XS]\d{6}\.(MP4|360)\|/.test(g)), got);
  ok('file times kept', got.every((g) => cardBefore.some((b) => b.split('|').slice(1).join() === g.split('|').slice(1).join())));
  ok('the card is exactly as it was', JSON.stringify(await list('drives')) === JSON.stringify(cardBefore));
  ok('recordings are in the project, parts joined', await until(() => $$('.bin-item:not(.loading)').length === 5, 15000) && $$('.bin-item').some((b) => /GX010900.*3 parts/.test(b.textContent!)) && !$$('.bin-item.error').length, $$('.bin-item').map((b) => b.textContent));
  const heads = [...run.states.values()].flatMap((s) => (s.state === 'done' ? [s.paths[0]!] : []));
  ok('from the copies, not the card', heads.every((h) => /imported/.test(h)) && (await Promise.all(heads.map((h) => getMedia(h)))).every((m) => m.parts.every((q) => !/drives/.test(q.path))));

  // --- Coming back --------------------------------------------------------------------------------------------
  api.run!('card');
  await until(() => $$('.card-tile').length === 6 && !cardState().scanning, 4000);
  await sleep(300);
  ok('already imported is marked and not picked', $$('.card-tile').filter((t) => /Imported/.test(t.textContent!)).length === 5 && $$('.card-tile[aria-checked="true"]').length === 0, $$('.card-tile').map((t) => t.textContent));
  await ace.capture('card-imported');
  tile('GS010120.360').click();
  await sleep(100);
  ok('picking one again only adds it', /Add 1 to project/.test(button(/^Add/)?.textContent ?? ''), $$('.import-foot button').map((b) => b.textContent));
  const before = JSON.stringify(await list('imported'));
  button(/^Add/)!.click();
  await sleep(300);
  ok('and copies nothing', JSON.stringify(await list('imported')) === before && !running(cardState().run));
  ($$('.import-head input')[0] as HTMLInputElement).click();
  await sleep(100);
  ok('hide imported', $$('.card-tile').length === 1);
  ($$('.import-head input')[0] as HTMLInputElement).click();
  // Moved away since: says so, and can be copied again.
  const rec = cardState().list.find((r) => r.name === 'GS010116.360')!;
  const rel = `imported/${got.find((g) => g.includes('GS010116'))!.split('|')[0]}`;
  await F('move', rel, 'imported/moved.360');
  await scan(cardState().root!);
  await sleep(200);
  ok('a copy that was moved is noticed', /Imported before/.test(tile('GS010116.360').textContent!) && tile('GS010116.360').getAttribute('aria-checked') === 'false', rec.id);
  // Same recording, card under another name (another reader or drive letter).
  await F('move', 'drives/HERO', 'drives/RENAMED');
  await until(() => cardState().root?.includes('RENAMED') === true && cardState().list.length === 6, 6000);
  await sleep(200);
  ok('recognised under another drive name', $$('.card-tile').filter((t) => /Imported/.test(t.textContent!)).length === 5, $$('.card-tile').map((t) => t.textContent));

  // --- Trouble ------------------------------------------------------------------------------------------------
  await F('copy', fix('GS010083.360'), 'drives/RENAMED/DCIM/100GOPRO/GS010083.360');
  await F('copy', fix('GS010115.360'), 'drives/RENAMED/DCIM/100GOPRO/GS010115.360');
  await scan(cardState().root!);
  await sleep(200);
  ok('recordings added to the card later start picked', $$('.card-tile[aria-checked="true"]').length === 2);
  await F('slow', '', 12);
  button(/^Import/)!.click();
  await until(() => (cardState().run?.fraction ?? 0) > 0.1);
  button(/^Stop/)!.click();
  ok('stop', await until(() => !!cardState().run?.ended, 5000) && cardState().run!.ended!.stopped);
  await sleep(300);
  ok('stopping leaves nothing half done', !(await list('imported')).some((g) => /\.part|GS010083\.360\|(?!391486294)/.test(g)), await list('imported'));
  ok('what is left stays picked', button(/^Import/)!.textContent!.trim() !== 'Import' && !button(/^Import/)!.disabled, button(/^Import/)!.textContent);
  button(/^Import/)!.click();
  await until(() => running(cardState().run) && cardState().run!.fraction > 0.12);
  // Two imports at once are refused.
  ok('only one import at a time', await ace.importCard([cardState().list[0]!.id]).then(() => false, () => true));
  await F('move', 'drives/RENAMED', 'away/RENAMED');
  ok('pulling the card out ends it with the reason', await until(() => !!cardState().run?.ended, 8000) && /removed/.test(cardState().run!.ended!.error ?? ''), cardState().run!.ended);
  await sleep(300);
  await ace.capture('card-removed');
  ok('and is shown', /removed/.test($('.import-foot')?.textContent ?? ''), $('.import-foot')?.textContent);
  ok('and leaves nothing half done', !(await list('imported')).some((g) => /\.part/.test(g)));
  await F('slow', '', 0);
  await F('move', 'away/RENAMED', 'drives/RENAMED');
  ok('putting it back carries on from there', await until(() => cardState().list.length === 8 && !cardState().scanning, 8000) && $$('.card-tile[aria-checked="true"]').length >= 1, [cardState().list.length, $$('.card-tile[aria-checked="true"]').length]);
  button(/^Import/)!.click();
  ok('and completes', await until(() => !!cardState().run?.ended, 60000) && !cardState().run!.ended!.error && [...cardState().run!.states.values()].every((s) => s.state === 'done'));
  await sleep(300);
  await ace.capture('card-done');
  for (const r of cardState().list.filter((q) => cardState().run!.states.has(q.id))) ok(`${r.name} identical after all that`, (await F('hash', r.files[0]!.path)) === (await F('hash', r.copies![0]!)));
  // The card as its own destination is refused.
  await F('dest', 'drives/RENAMED/DCIM');
  const fresh = cardState().list.find((r) => r.name === 'GX010777.MP4')!;
  const onCard = JSON.stringify(await list('drives'));
  ok('never copies onto the card', await ace.importCard([fresh.id]).then(() => '', String).then((e) => /on the card/.test(e)) && JSON.stringify(await list('drives')) === onCard);
  ok('only files found on a card can be asked for', await ace.importCard(['/etc/hosts']).then(() => false, () => true) && await ace.scanCard('/').then(() => false, () => true));
  await F('dest', 'imported/Action Cam');
  // An unfinished recording can still be saved.
  tile('GX010777.MP4').click();
  await sleep(80);
  button(/^Import/)!.click();
  const inBin = $$('.bin-item').length;
  ok('an unfinished recording can still be copied', await until(() => !!cardState().run?.ended, 5000) && cardState().run!.states.get(fresh.id)?.state === 'done', cardState().run?.ended);

  await sleep(300);
  ok('but is not added to the project', $$('.bin-item').length === inBin && !$$('.bin-item.error').length);

  // --- Two cards; a card put in while editing ---------------------------------------------------------------------
  button(/^(Done|Close)/)!.click();
  await sleep(200);
  await F('copy', fix('GX010132.MP4'), 'drives/SECOND/DCIM/100GOPRO/GX010132.MP4');
  ok('a card put in while editing is offered', await until(() => /SECOND connected/.test(document.body.textContent!), 6000));
  await sleep(400);
  await ace.capture('card-offer');
  api.run!('card');
  await sleep(600);
  const sel = $('.import-head select') as HTMLSelectElement | null;
  ok('with two cards you choose', sel?.options.length === 2, sel?.options.length);
  await F('slow', '', 0);

  // --- Playing while copying ----------------------------------------------------------------------------------------
  button(/^(Done|Close)/)!.click();
  const head = cardState().list.find((r) => r.name === 'GS010083.360')!.copies![0]!;
  const m = await getMedia(head);
  const { addClip, emptyTimeline, newClip } = await import('@ace/project');
  api.setTimeline(addClip(emptyTimeline(), newClip(head, m.durationUs, true), 0));
  await F('dest', 'imported/Again');
  for (const f of ['GS010117.360', 'GS010119.360']) await F('copy', fix(f), `drives/THIRD/DCIM/100GOPRO/${f}`);
  await until(() => cardState().cards.some((q) => /THIRD/.test(q.root)), 6000);
  const third = await ace.scanCard(cardState().cards.find((q) => /THIRD/.test(q.root))!.root);
  api.player.seek(0);
  await sleep(1500);
  await F('slow', '', 8);
  await ace.importCard(third.map((r) => r.id));
  const t0 = performance.now(), copy = { ended: 0 };
  ace.onImport((e) => { if (e.type === 'end') copy.ended = performance.now(); });
  const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
  api.player.play();
  await sleep(4000);
  api.player.pause();
  const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
  await until(() => copy.ended > 0, 30000);
  const mb = third.reduce((n, r) => n + r.size, 0) / 1e6;
  ok('playback keeps real time during an import', speed > 0.95 && api.player.stalls - s0 <= 2, { speed: +speed.toFixed(3), stalls: api.player.stalls - s0, copiedMB: Math.round(mb), copyS: +((copy.ended - t0) / 1000).toFixed(1) });
  for (const d of ['drives', 'imported', 'away']) await F('remove', d);
  await F('mkdir', 'drives');
  await F('forget');
  await F('dest', '');
  ok('no errors', !errors.length, errors);
  return { fails, ...out };
}

/** Leaves the app quitting in the middle of an import (the folder is checked afterwards). */
export async function cardQuit() {
  for (const d of ['drives', 'imported', 'away']) await F('remove', d);
  await F('forget');
  await F('dest', 'imported/Quit');
  const all = await ace.listFixtures();
  for (const f of ['GS010116.360', 'GS010118.360']) await F('copy', all.find((x) => x.endsWith(f))!, `drives/HERO/DCIM/100GOPRO/${f}`);
  const [c] = await ace.cards();
  const recs = await ace.scanCard(c!.root);
  await F('slow', '', 60);
  await ace.importCard(recs.map((r) => r.id));
  await until(() => false, 2600);
  const l = await list('imported');
  return { fails: l.some((x) => /\.part/.test(x)) ? [] : ['nothing was being copied'], l };
}

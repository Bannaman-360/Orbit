// The Projects page: save an edit with a name, later changes saved into it as you go, the page
// listing it, rename, duplicate, New project, and opening a project again.
// (Move to Trash isn't tried: it would put test files in the user's real Trash.)

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
const typeInto = (el: HTMLInputElement, text: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const until = async (f: () => boolean, ms = 5000) => { const t = performance.now(); while (!f() && performance.now() - t < ms) await sleep(50); return f(); };

export async function projectsCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const tag = Date.now().toString(36);
  const name = `Test ride ${tag}`;
  const all = await ace.listFixtures();
  const a = await getMedia(all.find((f) => f.endsWith('GX010133.MP4'))!);
  const b = await getMedia(all.find((f) => f.endsWith('GX010132.MP4'))!);
  await api.importPaths([a.path, b.path]);
  api.setTimeline(addClip(emptyTimeline(), newClip(a.path, a.durationUs, false)));
  await sleep(400);

  // Save: asks for a name, then it's in Projects.
  api.run!('save');
  await until(() => !!document.querySelector('input[aria-label="Project name"]'));
  typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!, name);
  await sleep(100);
  document.querySelector<HTMLFormElement>('form[aria-label="Save project"]')!.requestSubmit();
  await sleep(800);
  let list = await ace.projectsList();
  const saved = list.find((p) => p.name === name);
  ok('saving asks for a name and puts the edit in Projects', !!saved && saved.inLibrary && saved.clips === 1, saved ? { name: saved.name, clips: saved.clips } : list.map((p) => p.name).slice(0, 5));
  ok('with a picture that lasts after the app quits', !!saved?.thumb?.startsWith('data:image/'), saved?.thumb?.slice(0, 30));

  // A later change goes into the project by itself.
  api.setTimeline(addClip(api.getTimeline(), newClip(b.path, b.durationUs, false)));
  await sleep(2000);
  const text = saved ? (await ace.projectsOpen(saved.path)).text : '{}';
  ok('later changes are saved into it as you go', (JSON.parse(text).timeline?.clips?.length ?? 0) === 2, JSON.parse(text).timeline?.clips?.length);

  // The Projects page lists it, marked as open now.
  api.run!('projects');
  await until(() => $$('.project-card').some((c) => c.textContent?.includes(name)));
  const card = () => $$('.project-card').find((c) => c.querySelector('b')?.textContent === name || c.querySelector('input.project-rename'));
  ok('the Projects page lists it as open now', !!card() && /Open now/.test(card()!.textContent ?? '') && /2 clips/.test(card()!.textContent ?? ''), card()?.textContent);
  await sleep(700); // (after it fades in)
  await ace.capture('projects-page');

  // Rename on the page.
  card()!.querySelector('b')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => !!document.querySelector('input.project-rename'));
  const field = document.querySelector<HTMLInputElement>('input.project-rename')!;
  field.value = `${name} renamed`;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => $$('.project-card b').some((e) => e.textContent === `${name} renamed`));
  list = await ace.projectsList();
  ok('renames it', list.some((p) => p.name === `${name} renamed`) && !list.some((p) => p.name === name), list.map((p) => p.name).filter((n) => n.includes(tag)));

  // Duplicate from its menu.
  const renamed = () => $$('.project-card').find((c) => c.querySelector('b')?.textContent === `${name} renamed`)!;
  renamed().querySelector<HTMLButtonElement>('.project-more')!.click();
  await sleep(200);
  $$('button, [role="menuitem"]').find((e) => e.textContent?.trim() === 'Duplicate')?.click();
  await until(() => $$('.project-card b').some((e) => e.textContent === `${name} renamed copy`));
  ok('duplicates it', (await ace.projectsList()).some((p) => p.name === `${name} renamed copy`));

  // New project: an empty edit (the renamed project stays as it was).
  $$('.projects button.primary').find((e) => /New project/.test(e.textContent ?? ''))!.click();
  await until(() => !document.querySelector('.projects'));
  await sleep(300);
  ok('New project starts an empty edit', api.getTimeline().clips.length === 0 && !document.querySelector('.projects'));

  // Open the copy again from the page.
  api.run!('projects');
  await until(() => $$('.project-card b').some((e) => e.textContent === `${name} renamed copy`));
  $$('.project-card').find((c) => c.querySelector('b')?.textContent === `${name} renamed copy`)!.querySelector<HTMLButtonElement>('.project-thumb')!.click();
  await until(() => api.getTimeline().clips.length === 2, 8000);
  ok('opens a project again from the page', api.getTimeline().clips.length === 2 && !document.querySelector('.projects'), api.getTimeline().clips.length);

  // Esc closes the page.
  api.run!('projects');
  await until(() => !!document.querySelector('.projects'));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(200);
  ok('Esc closes the page', !document.querySelector('.projects'));
  return { fails, ...out };
}

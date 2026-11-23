// The welcome screen and the tour: every step points at something real, inside the window,
// with the standard layout and with a rearranged one.

import { addClip, emptyTimeline, newClip } from '@ace/project';
import { ace } from './api';
import { getMedia } from './media';
import { TOUR } from './Tour';
import { openPanels } from './ui/dockModel';
import { defaultPrefs, getPrefs, setPrefs } from './ui/prefs';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (q: string) => document.querySelector<HTMLElement>(q);

export async function tourCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  await sleep(800);
  const firstLaunch = !!$('.welcome');
  out['welcome shown at start'] = firstLaunch ? 'yes' : 'no (already seen in an earlier run)';
  setPrefs({ ...defaultPrefs(), welcomed: true });
  await sleep(200);
  const all = await ace.listFixtures();
  const m = await getMedia(all.find((f) => f.endsWith('GS010115.360'))!);
  await api.importPaths([m.path]);
  api.setTimeline(addClip(emptyTimeline(), newClip(m.path, m.durationUs, true)));
  await sleep(800);
  api.run!('welcome');
  await sleep(300);
  ok('the welcome screen offers import, card and tour', ['Import videos', 'From a memory card', 'Take the tour'].every((t) => ($('.welcome')?.textContent ?? '').includes(t)));
  await ace.capture('welcome');
  [...document.querySelectorAll<HTMLButtonElement>('.welcome-choice')].find((b) => /tour/i.test(b.textContent ?? ''))!.click();
  await sleep(400);
  ok('the welcome screen closes and the tour starts', !$('.welcome') && !!$('.tour'));
  const walk = async (label: string, shots: boolean) => {
    const missed: string[] = [], outside: string[] = [];
    for (let i = 0; i < TOUR.length; i++) {
      await sleep(350);
      const spot = $('.tour-spot'), card = $('.tour-card')!;
      const c = card.getBoundingClientRect();
      if (!spot) missed.push(TOUR[i]!.title);
      else {
        const s = spot.getBoundingClientRect();
        if (s.width < 10 || s.height < 10) missed.push(TOUR[i]!.title);
        // The card must not cover what it points at.
        const overlap = Math.max(0, Math.min(c.right, s.right - 6) - Math.max(c.left, s.left + 6)) * Math.max(0, Math.min(c.bottom, s.bottom - 6) - Math.max(c.top, s.top + 6));
        if (overlap > 0.25 * c.width * c.height && s.width * s.height < innerWidth * innerHeight * 0.3) outside.push(`${TOUR[i]!.title} (card covers it)`);
      }
      if (c.left < 0 || c.top < 0 || c.right > innerWidth || c.bottom > innerHeight) outside.push(TOUR[i]!.title);
      if (shots && (i === 0 || i === 4 || i === 6)) await ace.capture(`tour-${i + 1}`);
      ($('.tour-actions .primary') as HTMLButtonElement).click();
    }
    await sleep(300);
    ok(`${label}: every step points at its part of the window`, !missed.length, missed);
    ok(`${label}: every card is fully on screen and beside its target`, !outside.length, outside);
    ok(`${label}: the tour ends with Done`, !$('.tour'));
  };
  await walk('standard layout', true);
  // A rearranged window: the media panel closed. The tour opens it when needed, and closes it after.
  api.run!('toggleMedia');
  await sleep(400);
  const closedBefore = !openPanels(getPrefs().layout).includes('media');
  api.run!('tour');
  await sleep(500);
  ok('a hidden panel is shown for its step', !!$('[data-panel-body="media"]') && !!$('.tour-spot'));
  await walk('media panel hidden', false);
  ok('and hidden again after the tour', closedBefore && !openPanels(getPrefs().layout).includes('media'));
  api.run!('toggleMedia');
  // Escape leaves the tour.
  api.run!('tour');
  await sleep(400);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  ok('Escape leaves the tour', !$('.tour'));
  // Seen once, not again.
  ok('the welcome screen is remembered as seen', getPrefs().welcomed === true);
  // (So the next run of this test starts as a first launch again.)
  setPrefs({ welcomed: false });
  await sleep(1200);
  return { fails, ...out };
}

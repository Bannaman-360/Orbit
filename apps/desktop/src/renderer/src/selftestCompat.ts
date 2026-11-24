// Projects saved by newer versions open (what they added is left out, with a note), and if drawing
// the editor ever fails, the window says what to do instead of staying blank.

import { ace } from './api';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];

export async function compatCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const errors: string[] = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  const a = (await ace.listFixtures()).find((f) => f.endsWith('GX010133.MP4'))!;
  // A project from a version after this one (format 4), with things this version doesn't know.
  const newer = JSON.stringify({
    version: 3,
    timeline: { version: 4, futureThing: { x: 1 }, clips: [{ id: 'c1', mediaPath: a, inUs: 0, outUs: 5e6 }], audio: [], framing: '16:9', lutPath: null, overlays: [], markers: [{ id: 'm', t: 1e6, note: 'x', color: 'red' }] },
    library: [{ path: a, rating: 4, flag: 'fav', bin: 'f1', size: 123 }],
    bins: [{ id: 'f1', name: 'Pump track' }],
  });
  await api.restore!(newer);
  await sleep(1200);
  ok('opens a project saved by a newer version', api.getTimeline().clips.length === 1 && $$('.bin-item').length === 1 && !document.querySelector('.recover'), { clips: api.getTimeline().clips.length, bin: $$('.bin-item').length });
  ok('and says what is left out', /newer version/.test($$('.notice').map((n) => n.textContent).join(' ')), $$('.notice').map((n) => n.textContent));
  ok('without errors', !errors.length, errors);

  // Drawing fails: the recovery screen shows, with its choices.
  api.crashForTest!();
  await sleep(500);
  const card = document.querySelector('.recover');
  ok('a failure shows what to do, not a blank window', !!card && /Something went wrong/.test(card.textContent ?? '') && $$('.recover-actions button').length === 3, card?.textContent?.slice(0, 80));
  await ace.capture('compat-recover');
  const report = await ace.reportText('');
  ok('and it is in the problem log', /drawing failed on purpose/.test(report));
  return { fails, ...out };
}

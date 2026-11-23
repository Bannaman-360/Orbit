// Self-test: problems from the window reach the log, with folders and names removed, and
// Help → Report a Problem shows them along with the app and computer facts.

import { sharedDevice } from '@ace/media360';
import { ace } from './api';
import type { EditorApi } from './selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function reportCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const tag = `t${Date.now().toString(36)}`;
  // An uncaught error and a failed promise, both mentioning a private folder.
  setTimeout(() => { throw new Error(`thrown-${tag} reading /Users/privateperson/Movies/Secret Trip/GX010001.MP4`); }, 0);
  void Promise.reject(new Error(`rejected-${tag} at C:\\Users\\privateperson\\Videos\\ride.mp4`));
  // A GPU mistake (a buffer that can't exist) — normally invisible.
  const dev = await sharedDevice();
  dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE });
  await sleep(1200);
  const text = await ace.reportText('selftest adapter');
  out.report = text.split('\n').slice(0, 8);
  ok('the uncaught error is in the log', text.includes(`thrown-${tag}`) && text.includes('GX010001.MP4'));
  ok('the failed promise is in the log', text.includes(`rejected-${tag}`) && text.includes('ride.mp4'));
  ok('GPU errors are in the log', /GPU error/.test(text));
  ok('no folder or person names', !/privateperson|Secret Trip|\/Users\/|\\Users\\/.test(text), text.match(/.{0,40}(privateperson|Secret Trip|\/Users\/).{0,20}/)?.[0]);
  ok('version, system and graphics are given', /\d+\.\d+\.\d+/.test(text.split('\n')[0]!) && /System: /.test(text) && /Graphics: .*selftest adapter/.test(text) && /10-bit HEVC: /.test(text), text.split('\n').slice(0, 5));
  // The dialog opens from the Help menu command and shows the same.
  api.run?.('report');
  await sleep(1500);
  const box = document.querySelector<HTMLTextAreaElement>('.report-text');
  ok('Help → Report a Problem shows it', !!box && box.value.includes(`thrown-${tag}`), box?.value.slice(0, 80));
  await ace.capture('report');
  return { fails, ...out };
}

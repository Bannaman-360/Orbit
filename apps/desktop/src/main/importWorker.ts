// Runs an import away from the main process, so copying and checking never hold up playback.

import { parentPort, workerData } from 'node:worker_threads';
import { runImport, Stopped, type ImportJob } from './card';

let paused = false, stopped = false;
let wake: (() => void)[] = [];
parentPort!.on('message', (m: 'pause' | 'resume' | 'stop') => {
  if (m === 'pause') { paused = true; return; }
  if (m === 'stop') stopped = true;
  paused = false;
  const w = wake;
  wake = [];
  w.forEach((f) => f());
});

const { job, slowMs } = workerData as { job: ImportJob; slowMs: number };
void runImport(job, {
  async gate() {
    // (Self-tests slow a copy down to have time to pause it.)
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    while (paused && !stopped) await new Promise<void>((r) => wake.push(r));
    if (stopped) throw new Stopped();
  },
}, (e) => parentPort!.postMessage(e)).finally(() => parentPort!.close());

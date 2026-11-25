// The export queue: exports run one after another in the background while editing goes on.
// Each job keeps its own copy of the edit, so later changes don't affect it. Jobs can be paused
// (between frames), resumed, cancelled and cleared.

import { exportTimeline, type ExportOptions, type ExportProgress, type ExportResult } from './exporter';
import type { Timeline } from '@ace/project';

export type JobStatus = 'waiting' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export interface ExportJob {
  id: string;
  name: string;
  timeline: Timeline;
  opts: Omit<ExportOptions, 'gate'>;
  status: JobStatus;
  progress: ExportProgress | null;
  error?: string;
  result?: ExportResult;
  /** A job paused before it started waits paused. */
  holdBeforeStart?: boolean;
}

let jobs: ExportJob[] = [];
const listeners = new Set<() => void>();
let running: { id: string; abort: AbortController; resume: (() => void) | null; paused: boolean } | null = null;
let counter = 0;

const emit = () => { jobs = [...jobs]; for (const l of listeners) l(); };
const patch = (id: string, p: Partial<ExportJob>) => { jobs = jobs.map((j) => (j.id === id ? { ...j, ...p } : j)); emit(); };

export const queueJobs = () => jobs;
export function onQueue(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }
/** Jobs still to do or doing. */
export const pendingCount = () => jobs.filter((j) => j.status === 'waiting' || j.status === 'running' || j.status === 'paused').length;

/** Adds an export to the queue; it starts when the ones before it are done. */
export function enqueue(name: string, timeline: Timeline, opts: Omit<ExportOptions, 'gate'>): string {
  const id = `x${Date.now().toString(36)}${(counter++).toString(36)}`;
  jobs = [...jobs, { id, name, timeline: structuredClone(timeline), opts, status: 'waiting', progress: null }];
  emit();
  void pump();
  return id;
}

export function pauseJob(id: string) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  if (running?.id === id) { running.paused = true; patch(id, { status: 'paused' }); }
  else if (j.status === 'waiting') patch(id, { status: 'paused', holdBeforeStart: true });
}
export function resumeJob(id: string) {
  const j = jobs.find((x) => x.id === id);
  if (!j || j.status !== 'paused') return;
  if (running?.id === id) { running.paused = false; running.resume?.(); running.resume = null; patch(id, { status: 'running' }); }
  else { patch(id, { status: 'waiting', holdBeforeStart: false }); void pump(); }
}
export function cancelJob(id: string) {
  if (running?.id === id) { running.abort.abort(); running.resume?.(); return; }
  const j = jobs.find((x) => x.id === id);
  if (j && (j.status === 'waiting' || j.status === 'paused')) patch(id, { status: 'cancelled' });
}
/** Removes finished, failed and cancelled jobs (or one of them). */
export function clearJobs(id?: string) {
  jobs = jobs.filter((j) => (id ? j.id !== id : j.status === 'waiting' || j.status === 'running' || j.status === 'paused') || j.id === running?.id);
  emit();
}
/** Moves a waiting job up or down. */
export function moveJob(id: string, dir: -1 | 1) {
  const i = jobs.findIndex((j) => j.id === id), k = i + dir;
  if (i < 0 || k < 0 || k >= jobs.length) return;
  const next = [...jobs];
  [next[i], next[k]] = [next[k]!, next[i]!];
  jobs = next;
  emit();
}

async function pump() {
  if (running) return;
  const j = jobs.find((x) => x.status === 'waiting');
  if (!j) return;
  const r = (running = { id: j.id, abort: new AbortController(), resume: null as (() => void) | null, paused: false });
  patch(j.id, { status: 'running', progress: { fraction: 0, stage: 'Starting' } });
  const gate = () => (r.paused ? new Promise<void>((res) => { r.resume = res; }) : Promise.resolve());
  try {
    const result = await exportTimeline(j.timeline, { ...j.opts, gate }, (p) => patch(j.id, { progress: p }), r.abort.signal);
    patch(j.id, { status: 'done', result, progress: { fraction: 1, stage: 'Done' } });
  } catch (e) {
    const cancelled = e instanceof DOMException && e.name === 'AbortError';
    patch(j.id, cancelled ? { status: 'cancelled' } : { status: 'failed', error: e instanceof Error ? e.message : String(e) });
  } finally {
    running = null;
    // (Let the timeline breathe between exports.)
    setTimeout(() => void pump(), 50);
  }
}

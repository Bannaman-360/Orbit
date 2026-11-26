// AI models, downloaded the first time a tool needs them, once each, into userData/models.
// Every file has a pinned size and SHA-256: anything else is thrown away. They come from our own
// GitHub release (models-v1); if that can't be reached, from the same pinned files on Hugging Face.

import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface ModelFile { name: string; size: number; sha256: string; /** Hugging Face, pinned to a revision. */ hf: string }
export interface ModelInfo { id: string; name: string; what: string; licence: string; files: ModelFile[] }

const RELEASE = 'https://github.com/Bannaman-360/Orbit/releases/download/models-v1';
const hf = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;
const WHISPER_BASE = ['onnx-community/whisper-base', '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c'] as const;

export const MODELS: ModelInfo[] = [
  {
    id: 'whisper-base', name: 'Speech to text (Whisper base)', what: 'Auto subtitles', licence: 'MIT (OpenAI), ONNX by onnx-community, Apache-2.0',
    files: [
      { name: 'encoder_model_quantized.onnx', size: 23201314, sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46', hf: hf(...WHISPER_BASE, 'onnx/encoder_model_quantized.onnx') },
      { name: 'decoder_model_merged_quantized.onnx', size: 53693315, sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b', hf: hf(...WHISPER_BASE, 'onnx/decoder_model_merged_quantized.onnx') },
      { name: 'config.json', size: 2243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b', hf: hf(...WHISPER_BASE, 'config.json') },
      { name: 'generation_config.json', size: 3832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0', hf: hf(...WHISPER_BASE, 'generation_config.json') },
      { name: 'vocab.json', size: 1036584, sha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a', hf: hf(...WHISPER_BASE, 'vocab.json') },
      { name: 'added_tokens.json', size: 34604, sha256: '9715fd2243b6f06a5858b5e32950d2853f73dd5bc201aafcf76f5082a2d8acd1', hf: hf(...WHISPER_BASE, 'added_tokens.json') },
    ],
  },
  {
    id: 'rife-4.25-lite', name: 'Smooth slow motion (RIFE 4.25 lite)', what: 'Smooth slow motion', licence: 'MIT (hzwer)',
    files: [{ name: 'rife_v425lite.onnx', size: 22677513, sha256: '702802d0862ab78f2d72133c6bc3768e7e89b81756f7cd51d1055a2fe3d06577', hf: hf('t9749/rife-4.25-lite-onnx', '8d1488a82e19fd2f2ca5b3ee1d1bfacd6787b9df', 'rife_v425lite.onnx') }],
  },
  {
    id: 'realesr-general-x4v3', name: 'Sharper pictures (Real-ESRGAN general v3)', what: 'Upscale', licence: 'BSD-3-Clause (Xintao Wang)',
    files: [{ name: 'realesr-general-x4v3.onnx', size: 4866420, sha256: '7b10e80021ec3e0ff35017ae5022791879d93a799b2e201e1010a37510202266', hf: hf('vlad-grig/realesr-general-x4v3-onnx', '0e95d93e454cf6b5de9bdf5a1c9e7ec340d38231', 'onnx/model.onnx') }],
  },
];

/** Where a model's files go. Release assets are one flat list, so each file is named `<model>--<file>` there. */
export const modelsDir = () => path.join(app.getPath('userData'), 'models');
const fileOf = (m: ModelInfo, f: ModelFile) => path.join(modelsDir(), m.id, f.name);
const assetName = (m: ModelInfo, f: ModelFile) => `${m.id}--${f.name}`;

export type ModelState = { id: string; name: string; what: string; licence: string; bytes: number } & (
  | { state: 'missing' } | { state: 'ready' } | { state: 'downloading'; fraction: number } | { state: 'failed'; error: string }
);

const running = new Map<string, { fraction: number; done: Promise<void>; abort: AbortController }>();
const failed = new Map<string, string>();
/** Files already checked this run (checking a big file's SHA-256 takes a moment). */
const checked = new Set<string>();

async function present(m: ModelInfo, f: ModelFile): Promise<boolean> {
  const p = fileOf(m, f);
  const st = await stat(p).catch(() => null);
  if (!st || st.size !== f.size) return false;
  if (checked.has(p)) return true;
  const h = createHash('sha256').update(await readFile(p)).digest('hex');
  if (h !== f.sha256) { await rm(p, { force: true }); return false; }
  checked.add(p);
  return true;
}

export async function modelStates(): Promise<ModelState[]> {
  return Promise.all(MODELS.map(async (m) => {
    const base = { id: m.id, name: m.name, what: m.what, licence: m.licence, bytes: m.files.reduce((s, f) => s + f.size, 0) };
    const r = running.get(m.id);
    if (r) return { ...base, state: 'downloading', fraction: r.fraction } as ModelState;
    const all = (await Promise.all(m.files.map((f) => present(m, f)))).every(Boolean);
    if (all) return { ...base, state: 'ready' } as ModelState;
    const e = failed.get(m.id);
    return (e ? { ...base, state: 'failed', error: e } : { ...base, state: 'missing' }) as ModelState;
  }));
}

/** One file to `to`, checked as it arrives. Gives up when nothing arrives for 30 s. */
async function fetchFile(url: string, to: string, f: ModelFile, signal: AbortSignal, onBytes: (n: number) => void) {
  const stallMs = 30_000;
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal.addEventListener('abort', stop);
  let stall: ReturnType<typeof setTimeout> | undefined;
  const alive = () => { clearTimeout(stall); stall = setTimeout(stop, stallMs); };
  alive();
  try {
    const r = await net.fetch(url, { signal: abort.signal, headers: { 'User-Agent': 'ActionCamEditor-Models' } });
    if (!r.ok || !r.body) throw new Error(`the server answered ${r.status}`);
    const hash = createHash('sha256');
    const fh = await open(to, 'w');
    let got = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        alive();
        if (done) break;
        got += value.length;
        if (got > f.size) throw new Error('the file is bigger than it should be');
        hash.update(value);
        await fh.write(value);
        onBytes(value.length);
      }
    } finally {
      await fh.close();
    }
    if (got !== f.size || hash.digest('hex') !== f.sha256) throw new Error('the file arrived damaged');
  } catch (e) {
    if (signal.aborted) throw new Error('Cancelled');
    if (abort.signal.aborted) throw new Error('the download stopped arriving');
    throw e;
  } finally {
    clearTimeout(stall);
    signal.removeEventListener('abort', stop);
  }
}

/** Downloads a model (each file from our release, or Hugging Face if that fails). */
export function downloadModel(id: string, onProgress: (fraction: number) => void): Promise<void> {
  const m = MODELS.find((x) => x.id === id);
  if (!m) return Promise.reject(new Error('Unknown model'));
  const r0 = running.get(id);
  if (r0) return r0.done;
  failed.delete(id);
  const abort = new AbortController();
  const total = m.files.reduce((s, f) => s + f.size, 0);
  let got = 0;
  const job = { fraction: 0, abort, done: Promise.resolve() };
  job.done = (async () => {
    await mkdir(path.join(modelsDir(), m.id), { recursive: true });
    for (const f of m.files) {
      if (await present(m, f)) { got += f.size; continue; }
      const to = fileOf(m, f), part = `${to}.part`;
      let last: unknown = null;
      const start = got;
      for (const url of [`${RELEASE}/${assetName(m, f)}`, f.hf]) {
        got = start;
        try {
          await fetchFile(url, part, f, abort.signal, (n) => { got += n; job.fraction = got / total; onProgress(job.fraction); });
          await rename(part, to);
          checked.add(to);
          last = null;
          break;
        } catch (e) {
          last = e;
          await rm(part, { force: true });
          if (abort.signal.aborted) break;
        }
      }
      if (last) throw last instanceof Error ? last : new Error(String(last));
    }
    onProgress(1);
  })()
    .catch((e: Error) => { failed.set(id, e.message); throw e; })
    .finally(() => running.delete(id));
  running.set(id, job);
  return job.done;
}

export const cancelModel = (id: string) => running.get(id)?.abort.abort();

export async function removeModel(id: string) {
  const m = MODELS.find((x) => x.id === id);
  if (!m || running.has(id)) return;
  await rm(path.join(modelsDir(), m.id), { recursive: true, force: true });
  for (const f of m.files) checked.delete(fileOf(m, f));
}

/** A model file's bytes (after it was downloaded and checked). */
export async function readModelFile(id: string, name: string): Promise<Buffer> {
  const m = MODELS.find((x) => x.id === id), f = m?.files.find((x) => x.name === name);
  if (!m || !f) throw new Error('Unknown model file');
  if (!(await present(m, f))) throw new Error(`${m.name} isn’t downloaded yet.`);
  return readFile(fileOf(m, f));
}

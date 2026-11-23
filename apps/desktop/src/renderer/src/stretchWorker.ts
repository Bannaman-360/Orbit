// Stretches sound away from the window, so the interface never waits on it.
import { wsola } from './wsola';

self.onmessage = (e: MessageEvent<{ id: number; src: Float32Array[]; centres: Float64Array; length: number }>) => {
  const { id, src, centres, length } = e.data;
  const out = wsola(src, centres, length);
  (self as unknown as Worker).postMessage({ id, out }, out.map((o) => o.buffer as ArrayBuffer));
};

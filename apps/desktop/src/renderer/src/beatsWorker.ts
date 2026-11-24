// Finds the beats in a piece of music away from the window.
import { findBeats } from '@ace/engine/src/beats';

self.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[]; rate: number }>) => {
  const { id, channels, rate } = e.data;
  (self as unknown as Worker).postMessage({ id, grid: findBeats(channels, rate) });
};

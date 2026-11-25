// Audio worklet processors for the sound tools: wind reduction and ducking. Loaded into each
// AudioContext (live playback) and OfflineAudioContext (export mix) so both sound the same.

import { duckBlock, newDuckState, WindReducer } from '@ace/project/src/sound';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown); }

/** Stops processing (and lets the node go) when told to. */
class Stoppable extends AudioWorkletProcessor {
  protected alive = true;
  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
}

class WindProcessor extends Stoppable {
  private w: WindReducer | null = null;
  private strength: number;
  constructor(options: { processorOptions?: { strength?: number } }) {
    super(options);
    this.strength = options.processorOptions?.strength ?? 0.7;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0] ?? [], output = outputs[0] ?? [];
    if (!this.alive) return false;
    if (!output.length) return true;
    // (Two channels in, or one copied to both.)
    this.w ??= new WindReducer(Math.max(1, input.length || 2), sampleRate, this.strength);
    this.w.process(input.length ? input : [new Float32Array(output[0]!.length)], output);
    return true;
  }
}

class DuckProcessor extends Stoppable {
  private st = newDuckState();
  private depth: number;
  constructor(options: { processorOptions?: { depth?: number } }) {
    super(options);
    this.depth = options.processorOptions?.depth ?? 12;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const music = inputs[0] ?? [], key = inputs[1] ?? [], output = outputs[0] ?? [];
    if (!this.alive) return false;
    if (!output.length) return true;
    duckBlock(music.length ? music : [new Float32Array(output[0]!.length)], key, this.depth, sampleRate, this.st, output);
    return true;
  }
}

registerProcessor('ace-wind', WindProcessor);
registerProcessor('ace-duck', DuckProcessor);

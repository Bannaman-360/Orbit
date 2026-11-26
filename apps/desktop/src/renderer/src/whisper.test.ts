import { describe, expect, it } from 'vitest';
import { decodeText, FRAMES, logMel, makeVocab, melFilters, nextToken, repetitive, SAMPLE_RATE, segmentsOf } from './whisper';

// A tiny made-up vocabulary laid out like Whisper's: text, then specials, then timestamps.
const vocabJson: Record<string, number> = { 'Hello': 0, 'Ġworld': 1, 'Ġthere': 2, 'Ã©': 3 };
const added: Record<string, number> = { '<|endoftext|>': 4, '<|startoftranscript|>': 5, '<|en|>': 6, '<|transcribe|>': 7, '<|nospeech|>': 8, '<|notimestamps|>': 9 };
for (let i = 0; i <= 1500; i++) added[`<|${(i * 0.02).toFixed(2)}|>`] = 10 + i;
const v = makeVocab(vocabJson, added, { eos_token_id: 4, decoder_start_token_id: 5, no_timestamps_token_id: 9, task_to_id: { transcribe: 7 }, lang_to_id: { '<|en|>': 6 } });
const T = v.timestampBegin;
const logits = (pick: Record<number, number>) => { const l = new Float32Array(10 + 1501).fill(-10); for (const [k, x] of Object.entries(pick)) l[+k] = x; return l; };

describe('whisper helpers', () => {
  it('mel filters cover the spectrum without gaps', () => {
    const f = melFilters(80);
    expect(f.length).toBe(80);
    for (let k = 3; k < 195; k++) expect(f.some((w) => w[k]! > 0)).toBe(true);
  });

  it('a tone lights the right mel band', () => {
    const pcm = Float32Array.from({ length: SAMPLE_RATE * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE));
    const mel = logMel(pcm);
    const col = 50;
    let best = 0;
    for (let m = 0; m < 80; m++) if (mel[m * FRAMES + col]! > mel[best * FRAMES + col]!) best = m;
    // 1 kHz is mel 15 on the Slaney scale, of 0…~45.2 spread over 80 bands.
    expect(Math.abs(best - Math.round((15 / 45.25) * 81) + 1)).toBeLessThanOrEqual(2);
    // Silence after the tone sits at the floor (8 below the loudest, scaled).
    expect(mel[best * FRAMES + 2900]!).toBeLessThan(mel[best * FRAMES + col]! - 1.5);
  });

  it('turns tokens into text, including accents', () => {
    expect(decodeText(v, [0, 1, T, 3])).toBe('Hello worldé');
  });

  it('starts with a timestamp in the first second, then text, then closes with one', () => {
    expect(nextToken(v, logits({ 0: 5 }), []).id).toBeGreaterThanOrEqual(T);
    expect(nextToken(v, logits({ [T + 200]: 5, [T + 10]: 1 }), []).id).toBe(T + 10);
    // After an opening timestamp: no second timestamp straight away.
    expect(nextToken(v, logits({ [T + 20]: 5, 0: 1 }), [T]).id).toBe(0);
    // After text, a timestamp more likely overall than any word wins; never earlier than the last one.
    expect(nextToken(v, logits({ [T + 50]: 3, [T + 51]: 3, 1: 3.5 }), [T + 40, 0]).id).toBe(T + 50);
    expect(nextToken(v, logits({ [T + 10]: 9, 1: 1 }), [T + 40, 0]).id).toBe(1);
  });

  it('cuts windows into stretches and says where to go on', () => {
    const r = segmentsOf(v, [T, 0, 1, T + 100, T + 100, 2, T + 200, 4]);
    expect(r.segments).toEqual([{ start: 0, end: 2, text: 'Hello world' }, { start: 2, end: 4, text: 'there' }]);
    expect(r.next).toBe(30);
    // Cut mid-sentence: start again where that sentence began.
    expect(segmentsOf(v, [T, 0, T + 100, T + 1250, 1, 2]).next).toBeCloseTo(25);
  });

  it('spots looping output', () => {
    expect(repetitive('go go go go go go go go go go go go')).toBe(true);
    expect(repetitive('we hit the jump and landed it clean then rolled into the next berm')).toBe(false);
  });
});

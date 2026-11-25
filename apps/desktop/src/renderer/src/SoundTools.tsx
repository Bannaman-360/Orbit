// The Sound tools section for a clip or a piece of music: wind reduction, low cut, a 3-band EQ,
// a compressor, and (music) ducking under talking. Changes are heard on the next play.

import { COMP_PRESETS, NO_SOUND_FX, SOUND_PRESETS, isNeutralSound, type CompPreset, type SoundFx } from '@ace/project';
import { Seg, Slider } from './ui';

const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const hz = (v: number) => (v ? `${Math.round(v)} Hz` : 'Off');
const pct = (v: number) => (v ? `${Math.round(v * 100)}%` : 'Off');

export function SoundTools({ sound, onSound, music, hasVoiceClips }: {
  sound: SoundFx | undefined;
  onSound: (s: SoundFx | undefined, key: string) => void;
  /** Music (not a clip's own sound): offers ducking instead of "this is talking". */
  music?: boolean;
  /** Some clip is marked as talking (ducking has something to follow). */
  hasVoiceClips?: boolean;
}) {
  const s = sound ?? NO_SOUND_FX;
  const set = (patch: Partial<SoundFx>, key: string) => {
    const next = { ...s, ...patch };
    const empty = isNeutralSound(next) && !next.voice && !next.duck;
    onSound(empty ? undefined : next, key);
  };
  return (
    <>
      <div className="chips">
        {SOUND_PRESETS.filter(([name]) => !music || name !== 'Talking').map(([name, patch]) => (
          <button key={name} onClick={() => set(patch, `snd-preset-${name}`)}>{name}</button>
        ))}
        {sound && <button onClick={() => onSound(sound.duck || sound.voice ? { ...NO_SOUND_FX, ...(sound.duck ? { duck: sound.duck } : {}), ...(sound.voice ? { voice: true } : {}) } : undefined, 'snd-reset')}>Reset</button>}
      </div>
      <Slider label="Wind reduction" value={s.wind} min={0} max={1} step={0.01} reset={0} format={pct} hint="Turns down the low roar of wind across the microphones and keeps voices and engine sound." onChange={(v) => set({ wind: v }, 'snd-wind')} />
      <Slider label="Low cut" value={s.lowCut} min={0} max={300} step={1} reset={0} format={hz} hint="Removes rumble below this pitch (80–120 Hz suits most rides)." onChange={(v) => set({ lowCut: v < 20 ? 0 : v }, 'snd-lowcut')} />
      <Slider label="Bass" value={s.low} min={-12} max={12} step={0.5} reset={0} format={db} onChange={(v) => set({ low: v }, 'snd-low')} />
      <Slider label="Middle" value={s.mid} min={-12} max={12} step={0.5} reset={0} format={db} hint="Voices sit here: a little more makes talking clearer." onChange={(v) => set({ mid: v }, 'snd-mid')} />
      <Slider label="Treble" value={s.high} min={-12} max={12} step={0.5} reset={0} format={db} onChange={(v) => set({ high: v }, 'snd-high')} />
      <label className="field">Compressor
        <Seg value={s.comp} options={COMP_PRESETS.map(([id, label]) => [id, label] as [CompPreset, string])} onChange={(v) => set({ comp: v }, 'snd-comp')} />
      </label>
      {music ? (
        <>
          <Slider label="Lower under talking" value={s.duck ?? 0} min={0} max={24} step={1} reset={12} format={(v) => (v ? `−${v} dB` : 'Off')} hint="Turns the music down while a clip marked as talking is heard, and back up after." onChange={(v) => set({ duck: v || undefined }, 'snd-duck')} />
          {(s.duck ?? 0) > 0 && !hasVoiceClips && <p className="hint">No clip is marked as talking yet: tick “This is talking” under Sound tools on the clips where someone speaks.</p>}
        </>
      ) : (
        <label className="check" title="Music set to “Lower under talking” goes down while this clip's sound is heard">
          <input type="checkbox" checked={!!s.voice} onChange={(e) => set({ voice: e.target.checked || undefined }, 'snd-voice')} /> This is talking (music goes down under it)
        </label>
      )}
    </>
  );
}

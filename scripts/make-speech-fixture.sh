#!/bin/bash
# Makes fixtures/synthetic/speech.wav: known sentences spoken by macOS's own voice, with pauses,
# for the auto subtitles self-test (mode `ai`). Uses only tools built into macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
out=fixtures/synthetic/speech.wav
tmp=$(mktemp -d)
say -v Samantha -r 170 -o "$tmp/a.aiff" "Welcome to the pump track. Today we are riding the big jump line."
say -v Samantha -r 170 -o "$tmp/b.aiff" "[[slnc 2500]] Keep your speed through the berm and stay light on the bike."
say -v Samantha -r 170 -o "$tmp/c.aiff" "[[slnc 3000]] That was the best lap of the day."
for x in a b c; do afconvert -f WAVE -d LEI16@16000 -c 1 "$tmp/$x.aiff" "$tmp/$x.wav"; done
python3 -I - "$tmp" "$out" <<'PY'
import sys, wave
tmp, out = sys.argv[1], sys.argv[2]
frames = b''
for x in 'abc':
    with wave.open(f'{tmp}/{x}.wav') as w: frames += w.readframes(w.getnframes())
frames += b'\x00\x00' * 16000 * 2
with wave.open(out, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(frames)
print(out, len(frames) / 32000, 's')
PY
rm -rf "$tmp"

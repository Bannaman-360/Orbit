#!/usr/bin/env bash
# Runs hidden self-tests: scripts/selftest.sh ui tour drop
# Builds first only when a source file is newer than the last build (or with --build).
# Each mode's report is kept as selftest-out/report-<mode>.json; a line per mode is printed:
#   ui pass   /   gauges FAILS [...]
# Exit code: 0 when every mode passed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/desktop"
OUT="$ROOT/selftest-out"
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env)" >/dev/null 2>&1 || true

force=0; modes=()
for a in "$@"; do [ "$a" = "--build" ] && force=1 || modes+=("$a"); done
[ ${#modes[@]} -eq 0 ] && { echo "usage: scripts/selftest.sh [--build] <mode>..."; exit 2; }

stamp="$APP/out/.built"
stale() {
  [ $force = 1 ] || [ ! -f "$stamp" ] && return 0
  [ -n "$(find "$APP/src" "$ROOT/packages" -newer "$stamp" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.wgsl' \) -not -path '*/node_modules/*' -not -name '*.test.ts' -print -quit)" ]
}
if stale; then
  echo "building…"
  (cd "$APP" && npx electron-vite build >"$OUT/build.log" 2>&1) || { echo "BUILD FAILED (see $OUT/build.log)"; tail -20 "$OUT/build.log"; exit 1; }
  touch "$stamp"
fi

mkdir -p "$OUT"; rc=0
for m in "${modes[@]}"; do
  t=420; [ "$m" = rider ] && t=560; [ "$m" = long ] && t=600
  rm -f "$OUT/report.json"
  (cd "$APP" && timeout "$t" npx electron . --selftest --selftest-mode="$m" >"$OUT/log-$m.txt" 2>&1)
  if [ ! -f "$OUT/report.json" ]; then echo "$m NO REPORT (crashed or timed out; see $OUT/log-$m.txt)"; rc=1; continue; fi
  cp "$OUT/report.json" "$OUT/report-$m.json"
  python3 - "$m" "$OUT/report.json" <<'PY' || rc=1
import json, sys
m, f = sys.argv[1], sys.argv[2]
r = json.load(open(f))
if 'error' in r: print(m, 'ERROR', str(r['error'])[:300]); sys.exit(1)
fails = r.get('fails', [])
print(m, 'FAILS ' + json.dumps(fails) if fails else 'pass')
sys.exit(1 if fails else 0)
PY
done
exit $rc

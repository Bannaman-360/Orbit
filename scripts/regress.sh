#!/usr/bin/env bash
# Every hidden self-test mode (about 45 minutes), or a quick set with --quick (about 5).
# A failing mode is run once more: timing checks can fail when the machine is busy.
# Prints one line per mode; exit code 0 when all passed (after the retry).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
QUICK="ui export airtime odd gauges"
ALL="ui perf full color lens lenslook flat stab chapters card equirect follow zoom seamcheck scrubback speed strip protrim snap markers pool gauges airtime drop tour report odd long export tenbitexport rider layers masks beta8 motion finish"
modes="$ALL"; [ "${1:-}" = "--quick" ] && modes="$QUICK"

"$HERE/selftest.sh" --build ui >/dev/null 2>&1 || true   # build once up front
rc=0
for m in $modes; do
  if line="$("$HERE/selftest.sh" "$m")"; then echo "$line"; continue; fi
  if retry="$("$HERE/selftest.sh" "$m")"; then echo "$retry (passed on retry; first: ${line#"$m "})"; else echo "$retry"; rc=1; fi
done
exit $rc

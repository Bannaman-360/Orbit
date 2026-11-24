#!/bin/sh
# Builds the Mac half of a release on this Mac and adds it to the GitHub release, which sends the
# update to every installed Mac app.
#
# Order: first Run workflow on GitHub (Actions → Installers, on main). It tags main and publishes
# the release with the Windows files. Then run this, from a checkout of that tag:
#   git fetch origin --tags && git checkout v<version> && scripts/release-mac.sh
#
# Needs: Node and pnpm (see CLAUDE.md), the GitHub command-line tool `gh`, signed in
# (`gh auth login`), and the bundled ffmpeg (scripts/build-ffmpeg-mac.sh; built once, then kept).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
say() { printf '\n== %s\n' "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "This builds the Mac installers, so it has to run on a Mac."
command -v gh >/dev/null || fail "The GitHub command-line tool isn't installed (brew install gh, then gh auth login)."
gh auth status >/dev/null 2>&1 || fail "Not signed in to GitHub: run gh auth login."
command -v pnpm >/dev/null || fail "pnpm isn't available: see Commands in CLAUDE.md for setting up Node."

V="$(node -p "require('./apps/desktop/package.json').version")"
T="v$V"
say "Mac half of $T"

# Build exactly what was released, with nothing left uncommitted.
git fetch -q origin --tags
git rev-parse -q --verify "refs/tags/$T" >/dev/null || fail "$T doesn't exist yet. Run the Installers workflow on GitHub first (it makes the tag and the release)."
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$T^{commit}")" ] || fail "This checkout isn't $T. Run: git checkout $T"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "There are uncommitted changes. Commit or stash them first."

say "Waiting for the release to appear (the Windows half publishes it)"
i=0
until gh release view "$T" >/dev/null 2>&1; do
  i=$((i + 1)); [ $i -le 90 ] || fail "No release $T on GitHub after 30 minutes. Check the Installers run on GitHub."
  sleep 20
done

FF="apps/desktop/resources/ffmpeg/ffmpeg"
if [ ! -x "$FF" ]; then
  [ -f build-deps/ffmpeg-dl/ffmpeg-7.1.1.tar.xz ] || fail "The bundled ffmpeg isn't built, and its source isn't downloaded. See scripts/build-ffmpeg-mac.sh."
  say "Building the bundled ffmpeg (once)"
  scripts/build-ffmpeg-mac.sh
fi

say "Building the installers"
rm -rf apps/desktop/release
pnpm install --frozen-lockfile
pnpm --filter action-cam-editor dist:mac
R="apps/desktop/release"
APP_ARM="$R/mac-arm64/Action Cam Editor.app"
APP_X64="$R/mac/Action Cam Editor.app"
[ -d "$APP_ARM" ] && [ -d "$APP_X64" ] || fail "The build didn't make both apps (Apple Silicon and Intel)."

say "Checking the app starts (hidden)"
HOST_APP="$APP_ARM"; [ "$(uname -m)" = arm64 ] || HOST_APP="$APP_X64"
rm -f selftest-out/report.json
ACE_REPO_ROOT="$ROOT" perl -e 'alarm 180; exec @ARGV' "$HOST_APP/Contents/MacOS/Action Cam Editor" --selftest --selftest-mode=startup || true
[ -f selftest-out/report.json ] || fail "The app didn't finish its start-up check (no selftest-out/report.json)."
node -e "const r=require('./selftest-out/report.json'); if ((r.fails||[]).length) { console.error(r.fails); process.exit(1) }" || fail "The app's start-up check failed: see selftest-out/report.json. Nothing was uploaded."

say "Zipping the apps (what installed copies update from)"
ditto -c -k --sequesterRsrc --keepParent "$APP_ARM" "$R/Action-Cam-Editor-$V-mac-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP_X64" "$R/Action-Cam-Editor-$V-mac-x64.zip"
DMG_ARM="$R/Action-Cam-Editor-$V-mac-arm64.dmg"
DMG_X64="$R/Action-Cam-Editor-$V-mac-x64.dmg"
[ -f "$DMG_ARM" ] && [ -f "$DMG_X64" ] || fail "The .dmg files are missing."
(cd "$R" && shasum -a 512 "Action-Cam-Editor-$V-mac-arm64.zip" "Action-Cam-Editor-$V-mac-x64.zip" \
  "Action-Cam-Editor-$V-mac-arm64.dmg" "Action-Cam-Editor-$V-mac-x64.dmg" > checksums-mac.txt)

say "Adding them to the release"
# (Checksums last: Mac apps start updating once checksums-mac.txt is there.)
gh release upload "$T" "$DMG_ARM" "$DMG_X64" "$R/Action-Cam-Editor-$V-mac-arm64.zip" "$R/Action-Cam-Editor-$V-mac-x64.zip" --clobber
gh release upload "$T" "$R/checksums-mac.txt" --clobber
say "Done: $T now has the Mac installers. Installed Mac apps pick it up within a few hours (or Check for Updates)."

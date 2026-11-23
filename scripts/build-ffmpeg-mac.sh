#!/bin/sh
# Builds the small LGPL ffmpeg the app uses for 10-bit and ProRes export on a Mac: Apple's own
# encoders (VideoToolbox / AudioToolbox) plus AAC and the MP4/MOV writers. No GPL or non-free parts.
# Usage: scripts/build-ffmpeg-mac.sh   (needs build-deps/ffmpeg-dl/ffmpeg-7.1.1.tar.xz)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER=7.1.1
# (ffmpeg's configure can't work in a folder with spaces in its path, so it builds in a temp folder.)
WORK="${TMPDIR:-/tmp}/ace-ffmpeg-build"
SRC="$WORK/ffmpeg-$VER"
OUT="$ROOT/apps/desktop/resources/ffmpeg"
mkdir -p "$WORK" "$OUT"
[ -d "$SRC" ] || tar -xJf "$ROOT/build-deps/ffmpeg-dl/ffmpeg-$VER.tar.xz" -C "$WORK"
for ARCH in arm64 x86_64; do
  B="$WORK/build-$ARCH"
  rm -rf "$B"; mkdir -p "$B"; cd "$B"
  CROSS=""; [ "$ARCH" = "$(uname -m)" ] || CROSS="--enable-cross-compile --target-os=darwin"
  "$SRC/configure" --arch=$ARCH $CROSS --cc="clang -arch $ARCH" \
    --extra-cflags="-mmacosx-version-min=12.0" --extra-ldflags="-mmacosx-version-min=12.0" \
    --disable-everything --disable-autodetect --disable-doc --disable-ffplay --disable-ffprobe \
    --disable-network --disable-debug --disable-x86asm --enable-pthreads \
    --enable-videotoolbox --enable-audiotoolbox \
    --enable-protocol=file,pipe --enable-demuxer=rawvideo,wav --enable-decoder=rawvideo,pcm_s16le,pcm_f32le \
    --enable-encoder=hevc_videotoolbox,prores_videotoolbox,prores_ks,aac,aac_at,pcm_s16le \
    --enable-muxer=mp4,mov,null --enable-parser=hevc \
    --enable-filter=scale,format,aresample,anull,null --enable-swscale --enable-swresample > configure.log
  make -j"$(sysctl -n hw.ncpu)" ffmpeg > make.log 2>&1
  cp ffmpeg "$OUT/ffmpeg-$ARCH"
done
lipo -create "$OUT/ffmpeg-arm64" "$OUT/ffmpeg-x86_64" -output "$OUT/ffmpeg"
rm "$OUT/ffmpeg-arm64" "$OUT/ffmpeg-x86_64"
cp "$SRC/COPYING.LGPLv2.1" "$OUT/LICENSE-ffmpeg.txt"
printf 'ffmpeg %s, LGPL 2.1 build (no GPL/non-free parts). Source: https://ffmpeg.org/releases/ffmpeg-%s.tar.xz\nBuilt by scripts/build-ffmpeg-mac.sh.\n' "$VER" "$VER" > "$OUT/README.txt"
"$OUT/ffmpeg" -hide_banner -version | head -1

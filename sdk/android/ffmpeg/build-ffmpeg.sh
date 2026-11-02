#!/usr/bin/env bash
set -euo pipefail

# LGPL-only, audio-only FFmpeg. No native networking: authenticated remote bytes
# enter through the host's seekable input provider, retaining its ticket policy.
version=7.1.2
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to Android NDK r27 or newer}"
prefix="${1:?Usage: build-ffmpeg.sh <output-root> [ABI ...]}"
shift
abis=("$@")
if [ ${#abis[@]} -eq 0 ]; then abis=(arm64-v8a x86_64 armeabi-v7a x86); fi
mkdir -p "$prefix"
prefix="$(cd "$prefix" && pwd)"
cache="$prefix/source"
mkdir -p "$cache"
if [ ! -f "$cache/ffmpeg-$version.tar.xz" ]; then
  curl --fail --location --retry 2 "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz" -o "$cache/ffmpeg-$version.tar.xz.part"
  mv "$cache/ffmpeg-$version.tar.xz.part" "$cache/ffmpeg-$version.tar.xz"
fi
if [ ! -d "$cache/ffmpeg-$version" ]; then tar -xJf "$cache/ffmpeg-$version.tar.xz" -C "$cache"; fi
case "$(uname -s)" in
  *MINGW*|*MSYS*) host=windows-x86_64; ANDROID_NDK_HOME="$(cygpath -u "$ANDROID_NDK_HOME")" ;;
  Linux*) host=linux-x86_64 ;;
  Darwin*) host=darwin-x86_64 ;;
  *) echo 'Unsupported build host' >&2; exit 1 ;;
esac
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$host"
export PATH="$toolchain/bin:$PATH"
sysroot="$toolchain/sysroot"
installPrefix="$prefix"
if [ "$host" = windows-x86_64 ]; then
  sysroot="$(cygpath -m "$sysroot")"
  installPrefix="$(cygpath -m "$prefix")"
fi
for abi in "${abis[@]}"; do
  case "$abi" in
    arm64-v8a) arch=aarch64; target=aarch64-linux-android ;;
    armeabi-v7a) arch=arm; target=armv7a-linux-androideabi ;;
    x86_64) arch=x86_64; target=x86_64-linux-android ;;
    x86) arch=x86; target=i686-linux-android ;;
    *) echo "Unsupported ABI: $abi" >&2; exit 1 ;;
  esac
  build="$prefix/work-$abi"
  mkdir -p "$build"
  # An in-source work tree also supports native Windows GNU make (no /d/... includes).
  if [ ! -f "$build/configure" ]; then tar -xJf "$cache/ffmpeg-$version.tar.xz" -C "$build" --strip-components=1; fi
  (
    cd "$build"
    ./configure \
      --prefix="$installPrefix/$abi" --target-os=android --arch="$arch" --enable-cross-compile \
      --cc="clang --target=${target}26" --cxx="clang++ --target=${target}26" \
      --ar=llvm-ar --ranlib=llvm-ranlib --strip=llvm-strip --nm=llvm-nm \
      --sysroot="$sysroot" --enable-pic --enable-shared --disable-static \
      --disable-autodetect --disable-gpl --disable-nonfree --disable-programs --disable-doc \
      --disable-debug --disable-asm --disable-network --disable-everything \
      --enable-avcodec --enable-avformat --enable-avutil --enable-swresample \
      --disable-avdevice --disable-avfilter --disable-swscale --disable-postproc \
      --enable-protocol=file,pipe \
      --enable-demuxer=flac,mp3,wav,mov,ogg,aac,aiff,ape,wv,dsf,iff \
      --enable-parser=flac,mpegaudio,aac,opus,vorbis \
      --enable-decoder=flac,mp1float,mp2float,mp3float,aac,alac,ape,opus,vorbis,wavpack,dsd_lsbf,dsd_msbf,dsd_lsbf_planar,dsd_msbf_planar,dst,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s24be,pcm_s32be,pcm_f32be,pcm_f64be,pcm_u8 \
      --extra-ldflags='-Wl,-z,max-page-size=16384' \
      --extra-cflags='-O2' --enable-small
    make -j"${JOBS:-2}"
    make install
  )
  mkdir -p "$prefix/$abi/share/ffmpeg"
  cp "$cache/ffmpeg-$version/COPYING.LGPLv2.1" "$prefix/$abi/share/ffmpeg/"
  cp "$build/config.h" "$prefix/$abi/share/ffmpeg/"
done

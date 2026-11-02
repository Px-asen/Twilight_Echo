# libsoxr 0.1.3

Source: https://github.com/chirlu/soxr, tag `0.1.3`, commit
`945b592b70470e29f917f4de89b4281fbbd540c0` (annotated tag dereferenced).
`upstream/src/`, license files, release notes and the original CMake files are
retained. The project-local CMake wrapper builds constant-rate float/double
engines and available SIMD32 kernels without OpenMP, libav FFT or LSR bindings.
It produces a separate replaceable `twilight-soxr` shared library.
Build it through `audio-engine/CMakeLists.txt` with `TAE_ENABLE_SOXR=ON` (the
default). The runtime filename has the stable `libtwilight-soxr` prefix on all
platforms; Android uses the project's NDK toolchain and 16 KiB page alignment.
This directory is also a standalone CMake project, so the supplied library source
can be rebuilt without FFmpeg, the player or model assets:

```sh
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target twilight_soxr
```

For Android, pass the NDK `build/cmake/android.toolchain.cmake`,
`-DANDROID_ABI=arm64-v8a` (or the matching ABI), `-DANDROID_PLATFORM=android-26`
and `-DANDROID_STL=c++_static`. Replace the matching APK library, then repackage
and sign the APK. The acceptance package includes the exact compiler version
and Android build parameters.

Two source fixes match the existing vcpkg soxr 0.1.3 port:

- `src/soxr.c`: initialize the optional oneshot handle before error cleanup.
- `src/pffft.c`: recognize AArch64 NEON as well as 32-bit ARM.

License: LGPL-2.1-or-later, see `upstream/LICENCE` and `upstream/COPYING.LGPL`.
PFFFT's embedded BSD-like notice is in `upstream/src/pffft.c`; the FFT4G notice
is in `upstream/src/fft4g.c`. Android packages these notices alongside the
license. Desktop staging includes this complete modified source directory with
the runtime; Android debug acceptance packages include the corresponding source.

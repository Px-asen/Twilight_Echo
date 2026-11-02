# libusb 1.0.29 for Android USB Host

`upstream/` is the unmodified release archive from
https://github.com/libusb/libusb/releases/download/v1.0.29/libusb-1.0.29.tar.bz2.
The CMake wrapper follows `upstream/android/jni/libusb.mk` and uses the upstream Android configuration.
It builds the separately replaceable `libtwilight-usb.so` with 16 KiB ELF alignment.

License: LGPL-2.1-or-later (`upstream/COPYING`). The application distributes the license and this source.
Only a file descriptor already authorized through Android UsbManager is wrapped; native device discovery is disabled.

## Rebuild the replaceable library

Use CMake 3.25+ and Android NDK r27+ from this directory, for example:

```powershell
cmake -S . -B build/arm64-v8a -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$env:ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" `
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 -DCMAKE_BUILD_TYPE=Release
cmake --build build/arm64-v8a --target twilight_usb
```

Repeat with `armeabi-v7a`, `x86_64` or `x86` as needed. The output is
`build/<ABI>/libtwilight-usb.so`; no Twilight Echo engine sources are required.
To replace it in the app, rebuild the APK from the app sources with this library's
source changes in the adjacent `audio-engine/third_party/libusb` directory.
The app's `native-integration/build.gradle.kts` packages the CMake output and license assets.

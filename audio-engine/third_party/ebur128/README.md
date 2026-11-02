# libebur128 1.2.6 for Android loudness metering

`upstream/` contains nine unmodified source/provenance files from
https://github.com/jiixyj/libebur128/tree/67b33abe1558160ed76ada1322329b0e9e058b02
(tag `v1.2.6`). Source archive:
https://codeload.github.com/jiixyj/libebur128/zip/67b33abe1558160ed76ada1322329b0e9e058b02.

The wrapper builds a PIC static library with hidden symbols and the upstream
portable queue header. It does not execute upstream tests/install scripts or
change global `BUILD_SHARED_LIBS`. Android always links this source-built library;
other platforms retain their existing system-library discovery and fallback.
Host targets `twilight_android_loudness_tests` and
`twilight_android_loudness_realtime_tests` use this same dependency to check the
Android meter's numerical behavior and allocation-free processing.

License: MIT (`upstream/COPYING`, `upstream/doc/license/R128Scan.txt`), with the
BSD-3-Clause queue notice in `upstream/doc/license/queue.txt`. All three notices
and this provenance file are packaged as Android application assets under
`licenses/libebur128-1.2.6/`. No upstream source patches are applied.

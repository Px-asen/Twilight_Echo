# BS2B 3.1.0 reference and MIT notice

Upstream: [Bauer stereophonic-to-binaural DSP](https://bs2b.sourceforge.net/).
The source snapshot is from Debian's unmodified upstream repack:
[libbs2b_3.1.0+dfsg.orig.tar.gz](https://deb.debian.org/debian/pool/main/libb/libbs2b/libbs2b_3.1.0+dfsg.orig.tar.gz).
`upstream/` contains the original `bs2b.c`, `bs2b.h`, `bs2btypes.h`,
`bs2bversion.h`, `AUTHORS` and `COPYING`; these files are unchanged.

`dsp/CrossfeedProcessor.cpp` adapts the original coefficient calculation and
double-precision low-pass/high-boost recurrence. Its `bauer` and `bs2b` values
both select the official default (700 Hz, 4.5 dB); `meier` selects the official
JMEIER profile (650 Hz, 9.5 dB). Upstream describes JMEIER as close to the CORDA
crossfeeder parameters. It is the BS2B profile, rather than a circuit simulation.

Local integration changes:

- Existing strength is a dry/wet interpolation; strength 1 uses the full profile.
- Coefficients use the actual engine sample rate through 768 kHz. The upstream
  public setter only accepts 2–384 kHz and otherwise substitutes 44.1 kHz.
- The engine's existing ±4 DSP clamp is retained instead of the library's ±1
  sample-format clipping. Custom delay/low-pass behavior remains unchanged.
- No allocation or external library call occurs in the audio callback. Named
  float and double paths keep double histories, with one output conversion.

The unmodified C source is compiled **only into host numerical tests**. The
production engine compiles the adaptation without an additional runtime DLL or
Android library. Tests compare the adaptation with the original implementation
at 8–384 kHz, and with the published H-transform through 768 kHz.

The MIT permission notice in `upstream/COPYING` applies to the adaptation.
Android packages carry it under `assets/licenses/libbs2b-3.1.0/`; desktop
distributions include it in `THIRD-PARTY-NOTICES.txt`.

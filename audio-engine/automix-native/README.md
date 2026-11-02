# Twilight AutoMix native core

This module owns bounded analysis, transition planning and prepared audio.
The existing audio engine owns playback transport. Numerical kernels use Win64
NASM with explicit SSE2/AVX2 dispatch and portable C11 operators for Android.

## Current contracts

The shared application contract is [twilightAutoMix.ts](../../src/shared/twilightAutoMix.ts).
The current planner rule is `twilight-rules-5`, material format is version 2,
and optional stem arrangement is `twilight-stem-arrangement-1`.

- New profiles default to Off; users can select Natural or DJ in playback settings.
- Release availability permits opt-in use. `TWILIGHT_AUTOMIX_RELEASE_READY`
  remains false; availability and a selected mode do not pass delivery acceptance.
- Missing or stale analysis retains ordinary playback and reports its fallback reason.
- Source bytes, CUE ranges, model identity, playback/queue revisions and format
  identity bind analysis and preparation. Cancellation invalidates pending work.
- Preparation is bounded by the native memory budget and the live source position.
  The callback consumes immutable prepared materials and gains.

## Analysis and planning

Only allowlisted, publicly licensed Beat This small0 and YAMNet assets are staged
for native analysis. [dependencies.lock.json](./dependencies.lock.json) records
the pinned inputs. ONNX/PyTorch/TensorFlow are development export/comparison
tools for these graphs; native analysis uses the converted graph assets.

Attention batches at most 32 queries within the graph's declared scratch
budget, retaining every key/value without storing the full score matrix.
Portable GEMM uses 4-by-8 output tiles and preserves each output's accumulation
order. Softmax uses the Win64 kernel's sixth-order, range-reduced exponential
on maximum-subtracted scores: relative error is below 1e-6 on [-87, 0],
with smaller tails set to zero. Strict FP flags remain enabled; the Android
compiler can vectorize independent lanes without fast-math. Model parity,
complete analysis features and the original device boundary test remain the
acceptance checks for inference changes.

The region planner estimates tempo from Beat This events within each candidate
region, using stable local evidence. Natural/DJ tempo limits remain ±4%/±8%;
half/double beat correspondence does not change that playback-speed limit.
Scoring considers active energy, vocal activity, reliable key compatibility and
processing magnitude. Missing evidence remains unknown.

Original-speed routes include instrumental outro, DJ tail overlap and the
short `release-boundary` route. The latter runs after existing routes fail,
requires covered voice/music and spectral evidence, nearby positive music,
continuous decay and a verified mixed envelope, and keeps a 2–8 second overlap.
It reports zero beat confidence.

Codec tails are cached under their actual decoded end. Reuse binds source bytes,
ranges, models, parameters and window starts. Prepared gain is applied only in
the transition body; source endpoints retain their original PCM. Peak limiting
does not certify intersample true peaks or output after user DSP/routing.

## Authorized online sources

Provider preparation uses authorized sources and actual quality when supplied
by the endpoint. Unknown quality remains unknown. Complete cache files bind
their SHA-256 and native file lease.

When provider caching is enabled, preparation is cancellable, single-concurrency,
streamed to disk, limited to 256 MiB and a 10-second deadline. Truncated,
expired, mismatched or unrecognized audio data is rejected. Disabled caching,
an already-playing direct stream or failed preparation retains ordinary playback.

## Optional stem enhancement

The pinned Demucs worker is separate from native graph analysis. Its runtime
and cache contract is [stems/RUNTIME.md](./stems/RUNTIME.md); package creation is
documented in [stems/PACKAGING.md](./stems/PACKAGING.md).

The player detects installed CPU/GPU capability before making a device choice
available. The local ZIP installer checks Windows paths, entry types, collisions,
file count, unpacked size and disk space, then verifies CRC/SHA-256, the model
lock and available inventory. It probes the immutable final installation
before atomically activating its registry. Failure/cancellation preserves
previous packs and preferences.

Installation offers an explicit enable choice. Enabled enhancement reports
RAM/VRAM use; entering DJ mode requests confirmation about skipped boundaries
and overlapping music. Cache choices are Off/256/512/1024/2048 MiB, defaulting to
512 MiB. A worker timeout or invalid returned material keeps base-mix fallback.

## Reproducible checks

Run application regressions from the repository root:

```powershell
pnpm run test:twilight-automix
pnpm run test:automix
```

- Native CMake/CTest fixtures cover reference/assembly numerical agreement,
  planning, prepared PCM, cancellation, source identity and transport.
- `tools/render_pairs.py CORPUS OUTPUT --create-manifest MUSIC_DIRECTORY`
  fixes a corpus before inference; `--dll`, `--assets` and `--probe` render
  comparisons. `--reuse-analysis-from` verifies source/model/raw-analysis
  provenance before reusing inference.
- `tools/evaluate_rules3.py` accepts explicit `--rule-version`, `--baseline`,
  `--comparison`, `--probe` and `--windows-probe` inputs.
- `tools/verify_listening.py CORPUS EVIDENCE_DIRECTORY RATINGS_JSON`
  checks digests, prior suitability labels, category coverage and human ratings.
- `node scripts/automix-evaluation-smoke.cjs --package UNPACKED_APP --output REPORT_JSON`
  checks the real packaged main/preload/renderer and native utility processes.
  `--playback EXTERNAL_PAIRS_JSON` adds authorized real-source transport checks.
- `scripts/automix-native-device-soak.cjs` requires a concrete device ID
  and verified real-pair inputs. Its 24-hour gate requires a completed final report.

Write listening artifacts, validation reports and machine-specific run logs
outside the checkout or into ignored output directories. Preparation counts,
silent transport checks and short device runs do not establish human listening
acceptance or long-duration acceptance. Historical evaluation journals are
not part of the runtime contract.

# Measure desktop memory

Build the desktop and stage its native audio runtime, then run the benchmark from a normal Windows desktop terminal:

```powershell
pnpm run build
pnpm run benchmark:memory -- --output .artifacts/memory-after
```

The default run uses 1,057, 10,000 and 100,000 synthetic library records, three separate application launches per size, 50 navigation cycles and 30 minutes of continuous native playback per launch. It keeps hardware acceleration, the production sandbox, image quality and audio buffers enabled. All runs are sequential. Each launch gets a new profile under the output directory; existing user settings and library files are not imported or changed. The audio fixture is silence.

The fixture includes deterministic streaming recommendations and playlist pages through the real plugin host, 12 generated covers, one playable 8 kHz mono silent WAV and synthetic metadata for the remaining records. It exercises startup, library browsing, bulk favorite queries, streaming detail/back navigation, player/DSP navigation, return to idle, sustained playback, Afterglow and window restoration. It does not represent 100,000 decoded audio files or a live streaming service's network behavior. The system's selected WASAPI device and output format are recorded in the playback snapshot; keep that device fixed between candidates.

## Compare the same workload

Before editing production sources, preserve `out/main`, `out/preload`, `out/renderer` and `resources/audio-engine` under a separate build root. The runner uses the installed Electron version and workspace dependencies for both candidates. Keep these fixed during the comparison.

```powershell
pnpm run benchmark:memory -- --build-root .artifacts/memory-baseline --output .artifacts/memory-before
pnpm run benchmark:memory -- --build-root . --output .artifacts/memory-after
```

Use `--sizes`, `--runs`, `--cycles`, `--soak-seconds` and `--settle-seconds` for shorter development probes. Shortened runs are explicitly ineligible for the full acceptance workload. Normal runs never force garbage collection or trim working sets. Fixture construction happens before the application startup phase.

Select `--core-host node` to measure the packaged desktop Node workers. The selected build root must include `out/desktop-core`, staged by `scripts/build-desktop-core.cjs`; the default remains `--core-host electron`. The runner decodes the desktop supervision protocol for fixture injection and samples each actual Node child. It does not route service business traffic through the parent.

`--electron-executable <absolute path>` can select an explicitly installed copy of the same Electron version. Both sides must use the same supported execution environment. Moving an executable to escape a Windows integrity restriction is not production acceptance.

After both full workloads complete, `node scripts/compare-memory.cjs <before/report.json> <after/report.json>` reports repetition medians and ranges per size, phase and process role. It rejects incomplete or pressure-aborted runs and different window/DPI/compositor settings. GPU is separate. The full workload now includes a measured paused phase after restoration.

For ordinary idle and playback residency, select the steady scenario:

```powershell
pnpm run benchmark:memory -- --scenario steady --sizes 1057 --runs 3 --settle-seconds 45 --soak-seconds 60 --output .artifacts/memory-steady
```

This scenario opens the library, waits for `settle-seconds`, plays the same native silent WAV for `soak-seconds`, then pauses for `settle-seconds`. It records the same process, heap and GPU counters and checks playback advancement. It does not take navigation screenshots or exercise other pages, Afterglow or restoration. Use matching settings and builds for before/after comparisons. It remains ineligible for the existing full-scenario acceptance, whose default workload is unchanged.

Every run stops if available physical memory falls below 1 GiB. The report retains the interrupted phase and the reason. Release unrelated memory pressure before retrying into a new output directory. Do not compare a pressure-aborted run with a complete run.

## Read the report

`report.json` contains the launch inventory, settings, completion status and per-phase summary. Each launch directory also contains:

- `windows.jsonl`: timestamped private working set, private committed memory and total working set for the application process tree; dedicated/shared GPU counters are separate.
- `runtime.jsonl`: main/utility V8 heap, external and ArrayBuffer usage, renderer heap/backing storage, DOM counters and Electron process metrics.
- `runtime.log`, `run.json` and `summary.json`: errors, phase timings, playback continuity and summary values.
- PNG captures of the actual library, streaming home/detail, playing page, DSP workspace and restored UI. Navigation checks visibility and finite transition completion, then captures after foreground painting.

All byte fields use bytes; divide by 1,048,576 for MiB. Summaries use the median of the final 30 seconds or final half of a phase, whichever is shorter. A stable phase needs at least three valid Windows samples. Peaks are sampled peaks, not guaranteed maxima between samples; the sampler can miss a short cold-start phase. Processes in the same role are added within each timestamp before taking the median, with zero for processes that have exited. Runtime heap summaries keep each process ID. Shared pages and GPU memory are not added to private working set. V8 external memory can include ArrayBuffers; these fields are not additive.

Windows process membership uses both parent PIDs and process creation times. A process born before its apparent parent is excluded: Windows can reuse a departed parent's PID for an unrelated application. Each process sample records `createdAt`, and sampling stops if the root PID is reused. Earlier reports without this check require an ancestry audit before being used as a baseline.

The `events` array records complete navigation round trips, including sidebar operations, application animations and readiness polling at 100 ms intervals. The last streaming and player/DSP cycle also includes screenshot time. These are scenario durations, not input-to-frame latency or an audio latency measurement. Compare the same cycle positions. `bulk.durationMs` measures the renderer's complete paged query. The desktop workload never forces GC.

`acceptanceEligible` requires a complete run, the production sandbox, hardware compositing, the full cycle/soak/repetition counts, and valid stable samples for each steady-state phase. The top-level flag additionally requires every requested launch to finish. Compare the three repetitions at a fixed size and report their range as well as the median. A lower OS working set caused by memory pressure is not a reduction in retained application data.

## Diagnose a launch failure

A renderer that fails before Vue mounts yields a failed run, not a zero-memory measurement. Inspect `runtime.log` and reproduce the launch failure in a blank Electron window before attributing it to application memory. Restore a working desktop execution environment before collecting acceptance data.

`--diagnostic-no-sandbox` is an explicit harness troubleshooting option for these isolated synthetic profiles. It is never enabled automatically, does not change the app's production configuration, and always makes the result ineligible for production acceptance. Such results can verify scenario plumbing and suggest contributors; they cannot establish the requested production memory floor.

The two memory fixes have focused regression coverage:

```powershell
pnpm run test:memory
```

Bulk favorite summaries now discard page results after counting instead of expanding the display cache. Ordinary display queries keep their cache behavior and notify reactive consumers without copying the entire Map. Late replies cannot resurrect an invalidated cache. Metadata failure history expires after its retry deadline plus one maximum backoff interval; active or queued queries retain their retry history. After a longer idle period, a query starts a fresh backoff sequence. Shutdown disposes the cleanup timer after joining accepted work.

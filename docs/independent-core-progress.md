# Independent Core — production cutover and acceptance

Updated: 2026-10-23

## Production cutover and Windows package acceptance are complete

**Music business now runs in the independent Core. Rebuilding the frontend only reconnects it.**

Run the verified local application at `dist/win-unpacked/TwilightEcho.exe`.

- `src/main/index.ts` calls `startCoreApp()`. `coreApplicationRuntime.ts` creates
  the supervised utility Core and the window/system/settings bridges, without
  constructing the legacy music service composition.
- SQLite is the only production library runtime. Do not implement a parallel JSON
  library backend. One-time JSON library imports and the existing versioned JSON
  settings, playlists, playback sessions and backup formats remain supported.
- The renderer player/music/settings stores are Core projections and command
  adapters. Inbox, dashboard, search, playlist, provider and plugin consumers have
  moved to the Core path. The old renderer playback owner, session writer and
  HTMLAudio fallback are removed from production use.
- Main, auxiliary windows, tray, system controls and remote/plugin clients use the
  same business owner. Afterglow unloads/recreates windows; it no longer transfers
  playback ownership. The single-instance, close-to-tray and explicit-quit behavior
  is retained.
- OPRA search, profile, refresh and status are Core-owned; the equalizer consumes
  the finite Core API and confirmed DSP state. Final OPRA/EQ checks and the
  integrated production build have passed.

Legacy entry points and compatibility/extraction tests remain in the repository;
production no longer selects the legacy application entry. This task does not add
independent-server deployment, multi-room playback or a replacement remote protocol.

## Process and authority boundaries

```text
renderer / auxiliary windows
    -> controlled preload -> main window/permission bridge
    -> utility Core: domain commands, authoritative state, repositories
       -> private MessagePorts: audio, database, scan, analysis, plugin hosts
```

- Main supervises fixed registered service entries and owns windows, dialogs,
  OS credentials, grants, system media integration and update installation. Core
  receives explicit platform capabilities; clients cannot select launch paths,
  executables, environment overrides or arbitrary native methods.
- `src/core` owns music business policy without Electron, Vue, DOM, browser storage
  or `window.api`. Native audio still owns rendering, preload, EOF transitions,
  gapless and crossfade; Core owns selection and orchestration.
- Finite domain requests carry request IDs and a Core epoch, plus existing resource
  revisions. Main binds client identity and permissions; plugins retain their
  permission cuts. Reconnection obtains a consistent snapshot and ordered events,
  resnapshotting a gap rather than replaying a command.
- Public state excludes media authorization and credentials. Libraries, queues,
  playlist membership and large task results use bounded pages/references. FFT is
  a separate subscription and stops collecting without consumers.
- Pause/Stop do not wait on slow provider resolution, searches, scans, analysis or
  configuration transactions. Unknown write results are reconciled by explicit
  reads or stopped recovery, never automatic mutation replay.

## Business ownership already moved

### Playback, queues and background continuation

- One session owns durable SQL queues, logical cursors, occurrence IDs, source
  selection, expiring-URL refresh, cross-source repair, FM/radar/heart refills,
  queue edits/undo, named sessions and paused cold restoration. Duplicate tracks,
  CUE/SACD selectors and original order retain their established identities.
- Native adoption keeps revision/occurrence fences and the existing conditional
  handoff contract. Restoring a window only attaches a projection; it does not
  restore playback by issuing Play, Seek or LoadQueue.
- Single-target Cast uses that session, including source/cache leases, independent
  position samples and statistics. Unknown LOAD is not retried or replaced with
  local audio. Main's stop-only lease supervises the exact remote receiver session.
- Desktop Cast's CUE temporary files, TLS certificate issuance and UDP DLNA discovery
  live in `src/adapters-node/{castPcmSegments,remoteTlsIdentity,dlnaDiscovery}.ts`.
  The Core process composes these adapters; this does not move playback ownership
  into Electron main. `createCastBackend` receives DLNA discovery explicitly, while
  SOAP controls, certificate fingerprints and pairing codes remain in Core. Existing
  desktop discovery options and persisted certificate/trust formats are unchanged.
- Sleep deadlines, natural-boundary decisions and fade run in Core. Output routing,
  profiles, DSP assets/VST, automatic EQ compensation, audition and output-test
  orchestration retain native ACK, durable commit, rollback and safe-stop rules.
  OPRA's UI adapter uses the same Core settings/DSP owner.

### Library, sources and personal music data

- Core composes database, durable scans, watcher/polling recovery, network source
  profiles/indexes, automatic metadata enrichment and manual matching. Native
  watchers and startup scans activate after migration, not when a window attaches.
- Frozen SQL selections drive tag edits/restoration, library removal/trash,
  exclusions/reset, playlist repair, duplicate review and Inbox decisions. File
  maintenance joins affected decoders/writers; CUE rows do not duplicate file work.
- Core owns playlists/favorites/import previews and jobs, recording relationships,
  complete-query queue selection and unified song/collection search. Matching,
  ordering, CAS recovery and import occurrence semantics reuse the existing code.
- Lyrics selection/loading, manual edits/offsets, playback bookmarks and actual
  playback history/workspace are Core-owned. UI keeps editing drafts and rendering.
- Radio favorites, podcast subscriptions/progress/default speed and listening
  statistics update from authoritative playback, not per-window observers.
  Statistics retain five-second ticks, completion at >=90%, skips below 50%,
  730-day detail retention and the 10,000-track bound.

### Other long-running owners and consumers

- Provider/plugin hosts, NetEase gateway/cache, downloads/import indexing and cloud
  transfers run under Core. Detached accepted jobs continue; cancellation and quit
  join actual work before services or temporary results are released.
- AutoMix preparation/stems, BPM/loudness analysis, model-pack operations and
  visualization subscriptions use Core lifetimes and existing fixed platform
  launch capabilities. This does not change native DSP or model availability.
- Settings have one Core writer and retain the existing encrypted credential
  format. Main applies an epoch-bound settings projection. Renderer appearance
  and lyric presets can keep drafts; confirmed settings come back from Core.
- Cache maintenance coordinates network/NCM/scanner/protocol writers and preserves
  active native/Cast sources. Chromium cache uses the session API, not recursive
  deletion of its active directory.
- Ten-category personal backup/restore and settings backup/import read/write Core
  repositories directly. Plugin experiences, desktop/mini-player/lyrics overlays,
  tray/shortcuts/SMTC and LAN remote adapters no longer depend on a main-window
  state relay. LAN remote keeps its default-off, pairing and authentication rules.

## Persistence, upgrade and recovery contracts

- Keep the existing library SQLite schema and versioned files. A separate
  `core-state.sqlite` connection in the database service stores migrated browser
  data: version relationships, statistics/history, Inbox decisions, podcast speed
  and playback-related EQ preferences.
- A one-time client in the normal window reads the old browser stores, stages
  bounded batches and atomically publishes validated data with a completion
  marker. Related business writes wait for migration. Interrupted imports can
  retry; existing Core data is not overwritten and browser originals remain.
  There is no hidden resident migration renderer.
- Legacy array sessions import into durable queues; current, last-good and named
  session references protect their occurrences from GC. Queue schema upgrades
  retain the existing WAL-consistent backup and transactional migration behavior.
- Personal restore redo runs before repositories initialize. Old
  `personal-restore-renderer.json` requests are consumed by the database/Core
  repositories; statistics, versions and the restore token publish together.
  Lost replies cannot reapply a restore over newer data.
- Core starts before the normal migration window. Ready follows required recovery,
  migration and authorization initialization; UI may show loading before then but
  cannot mutate business state early. Closing a window leaves Core running.
- Explicit quit drains accepted work, samples the final native cursor, waits for
  persistence ACK and then stops services. Core death invalidates the epoch and
  requires confirmed audio/Cast stop before one paused automatic restart. A second
  failure waits for explicit retry. Audio-service recovery never auto-resumes sound.

## Evidence available for this cutover

Counts below describe separate, overlapping runs; do not add them into one total.

### Latest focused checks

- **Lifecycle/application/Afterglow/diagnostics: 17 passed** — production entry,
  pre-window Core startup, window reconstruction, tray versus quit, final
  persistence ACK and renderer-free SMTC anchor. `.core-cutover-lifecycle.log`.
- **TaskCenter/settings projection: 2 passed** — real renderer behavior and
  confirmed settings versus drafts. `.core-task-cache-tests.log`.
- **Real Electron UX flow: 1 passed** — import preservation, search paging,
  keyboard, download focus, radio races and podcast undo. `.core-ux-resume-tests.log`.
- **Read/model operations: 24 passed** — bounded public library/artwork reads,
  accepted model installation lifetime and cancellation. `.core-read-model-tests.log`.
- **Architecture boundaries: 3 passed** — portable imports, no browser-owned Core
  storage/DOM bridge, no HTMLAudio implementation/enablement.
  `.core-cutover-boundaries.log`.
- **Store/search/queue/database regressions: 136 passed in 22 files** — real Core
  SQLite/services, playlist CAS, bounded public projections, reconnect-only
  lyrics/sleep state and queue pagination. New queue tests cover 200/200/5 ACK
  revisions, non-playing staging and unknown-result/cancellation behavior.
  `.store-final-regressions.log`. Scoped store/app/component `vue-tsc` is clean in
  `.store-tests-types.log`.
- **Integrated production main/preload/renderer build and full node/web types
  passed** — `.core-cutover-build.log`, `.core-cutover-node-types.log`,
  `.core-cutover-web-types.log`. Use the established typecheck scripts'
  `--composite false` option. Font stripping and renderer budgets passed:
  674 files, fonts 8,907,800 bytes. `.core-cutover-renderer-budget.log`.
- **Actual production entry, browser migration and zero-window integration:
  3 passed** — `.core-production-final.log`. The built main starts the real
  native engine with a silent WAV. Two full window destruction/rebuild cycles
  preserve epoch, occurrence and advancing position without additional Play,
  Seek, LoadQueue or renderer playback commands. Statistics count one play;
  same-profile cold start retains the paused position and occurrence, performs
  no migration or playback replay, and exits normally. The captured production
  UI is `.core-production-render.png`.
- **Native progress sampling: 329 passed** — `.core-native-sampling-tests.log`.
  Position-only samples reach Core observers without increasing renderer
  playback-info fanout or replaying native transport.
- **NCM shutdown and affected search regressions: 26 passed** —
  `.core-final-search-ncm-tests.log`. Client pooled connections close before
  waiting for their server listener; actual partial-response cancellation
  preserves single dispatch. No timeout or forced socket teardown was added.
- **Real native zero-window continuation and crash recovery: 1 passed** —
  `.core-native-continuation.log`. CUE first/second, local and loopback provider
  audio naturally advance through four occurrences. Expired URL refresh precedes
  any HTTP open; native progress triggers FM and heart refill. Slow provider
  cancellation produces no late Play/Seek/LoadQueue. Killing the audio utility
  preserves identity and recovers paused without Play. Killing Core while playing
  obtains a positive native stop ACK before the new Core is forked; recovery is
  paused with no replay and final shutdown leaves no services.
- **Database queue conflict transport: 81 passed** —
  `.core-queue-conflict-tests.log`. Queue revision conflicts now retain
  `STALE_REVISION` through the database worker reply. Failed edits leave queue
  content unchanged, and unrelated errors retain their original classification.
  The affected node typecheck is clean in `.core-queue-conflict-types.log`.
- **Actual Core desktop/mini/paired-HTTP concurrency: 1 passed** —
  `.core-multiclient-runtime.log`. Three clients compete on one revision: one
  edit succeeds and two return `STALE_REVISION`. Undo restores all occurrences;
  disconnect cancels an actual platform request with `OUTCOME_UNKNOWN` and no
  duplicate insertion. Reattachment issues no playback mutations, authenticated
  remote reads work with no windows, and every service exits.
- **Volume and streaming-layout renderer regressions: 1 passed each** —
  `.core-volume-restart.log`, `.core-streaming-layout-final.log`. Four actual
  renderer rebuilds retain Core-owned volume, including zero/unity and debounce/
  flush, without startup-default writes. The real streaming page retains detail
  placement and current-track navigation through its finite Core adapter.
  An additional 54 player/mini structure checks passed in
  `.core-final-player-structure.log`.
- **Plugin import/experience regressions: 62 passed, plus real zero-window plugin
  integration** — `.plugin-import-tests.log`, `.plugin-headless-tests.log`.
  Final OPRA/equalizer/DSP checks passed in `.renderer-opra-domain-tests.log`
  and `.renderer-opra-types.log`.
- **Final Windows package: 1 passed, including first and cold starts** —
  `.core-packaged-runtime.log`, `.core-packaged-result.json`. The real executable
  and native addon load directly from `dist/win-unpacked`. Two window rebuilds
  issue zero Play/Seek/LoadQueue and zero renderer playback commands; statistics
  count once. Cold start preserves the same occurrence at 7.57 seconds, paused,
  without migration or transport replay. Both exits are graceful with zero live
  services and no Core/renderer errors. The final screenshot was visually checked:
  `.core-packaged-render.png`.
- **Final release closure/branding passed** — `.core-packaged-build.log` verifies
  283 packaged dependencies and Windows application identity. The generated
  package inherited this workspace's Low integrity label; only that generated
  directory/files were restored to normal Medium integrity before direct-path
  verification. Parent directory permissions and the Chromium sandbox are unchanged.
- **Isolated native-service loading: 1 passed** — `.core-native-service-final.log`.
  The fixture uses the standard staged `resources/audio-engine` inputs, not a
  manually prepared private build directory; private ports, stopped startup and
  no-consumer FFT shutdown are verified.

Two earlier aggregate logs retain their diagnostic failures: the browser Inbox
order expectation and the scan-completion race in `.core-cutover-electron.log`
were corrected and passed in `.core-production-final.log`. The obsolete collection
artwork assertion in `.core-final-unit-tests.log` was corrected and its full search
file passed with the NCM regressions in `.core-final-search-ncm-tests.log`. These
changes preserve complete migrated values and private-path rejection.

### Earlier real-process evidence to retain

- `.core-current-electron-tests.log`: four real Electron fixtures passed for
  zero-window Core/database service transport, detached downloads, loopback Cast
  crash-stop recovery and sandboxed finite window bridges. These precede the final
  production-entry/OPRA integration.
- `.core-watch-electron.log` / `.core-settings-final-electron.log`: zero-window
  scan/recovery, 300 WAV files plus CUE -> 303 tracks, watcher addition -> 304,
  configured-root import -> 305; the same durable job and settings survive a Core
  crash. Service communication uses private MessagePorts.
- `.core-metadata-electron.log` / `.core-fallback-electron-fixed.log`: detached
  provider metadata, source expiry/repair, lyrics/search and SQL identity repair;
  reconnect does not replay a lost committed reply or change the occurrence.
- `.core-backup-electron.log`: pending legacy restore, all ten backup categories,
  duplicate queue occurrences/selected occurrence, paused restart and repository
  round-trip without a BrowserWindow. Browser migration fixtures also cover 201
  complete IndexedDB history records, day totals, version relationships, Inbox,
  podcast speed and EQ, with interrupted staging and preserved originals.
- `.core-automix-final-electron.log` / `.core-analysis-headless-final.log`:
  client-free AutoMix/analysis continuation, stable occurrence across reconnects,
  paused crash recovery, library maintenance and scan recovery.

These fixtures use isolated profiles. The newer native continuation and production
fixtures above use the real audio engine; Cast uses loopback receivers. Output/DSP
transaction ACK and rollback checks retain the existing native processing contract.

## Run and reproduce

- Application: `dist/win-unpacked/TwilightEcho.exe`. First upgrade uses the normal
  window for one-time browser data migration; subsequent windows only attach.
- `pnpm run typecheck` and `pnpm run build` check and bundle the source.
- `pnpm run test:core` runs the finite contracts, business, persistence and
  architecture checks. Existing playback/database/plugin/lyrics/remote suites
  retain their own entries.
- `pnpm run test:core:electron` runs the real Core integration fixtures serially,
  including production entry, native continuation and paired multi-client control.
  Build first and retain the normal native resources used by the application.
- `node scripts/build-app-package.cjs --dir` creates the local unpacked package;
  `pnpm run test:core:packaged` verifies that executable with isolated profiles.
  Electron integration and packaging jobs must run serially.

All five implementation stages and the acceptance items above are complete.
No remote publishing or installer deployment was performed.

Baseline: `5a495b98`, 2026-10-21. SQLite-only scope decision: 2026-10-22.

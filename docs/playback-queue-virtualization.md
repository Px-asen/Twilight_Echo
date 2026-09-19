# TE-3.4 Playback Queue Virtualization

The PlayerBar queue drawer renders a fixed-height virtual window instead of one DOM row per queued track. It uses a 54 px row, 6 rows of overscan on both sides, and centers the active queue item whenever the drawer opens or playback changes.

Playback queue state stores compact snapshots: identity, display fields, routing target, duration, format, and audio normalization metadata. Lyrics, translations, and metadata-match payloads remain on the library/current-track paths and are not duplicated for every queue entry. The queue and its original ordering use shallow reactive arrays, so Vue does not proxy nested fields for thousands of entries.

Native queue synchronization captures a monotonic revision with the queue snapshot. A request that becomes stale while authorization or IPC is pending does not update native delegated state or issue a later stale configuration step.

## Drawer interactions

The drawer operates on a per-entry `queueEntryId`, not the provider media ID or a virtual row's DOM position. This keeps duplicate tracks distinct and makes a drag/drop safe if the visible window moves or queue state changes while the pointer is down. Row actions for play-next, add-tail, and removal all resolve that identity immediately before calling the store command. Each addition receives a fresh entry ID even when it copies an existing row. The header exposes undo, session management, locating the current entry, and clear. Saving to a playlist remains available through the existing playlist picker.

## Queue commands and undo

`stores/player/queueCommandController.ts` owns add, remove, move, clear, replace and undo. Add/remove/move retain operation deltas and compact entry references. Clear/replace retain the previous immutable queue arrays. The stack keeps at most 20 commands and 80,000 retained entry references; a 20,000-entry queue can retain two complete queue/original-order replacement snapshots. Ordinary edits reuse the existing Track objects and replace shallow arrays rather than cloning the full queue metadata.

Undo requires the current command revision. Each successful undo advances the revision and rebases the next stack entry, allowing consecutive undo while rejecting an older toast action. External structural replacements, library pruning, automatic recommendation appends and playback-mode changes invalidate old undo records. Metadata-only refreshes preserve entry identity and do not invalidate the stack.

Edits preserve the current entry and its position when it survives. Removing the current entry stops playback and prepares its successor (or the last remaining entry) paused. Clear stops playback and removes the selection before publishing or saving state. Preparing a restored selection stops renderer/native playback and requests the existing cast stop when a cast is active; failures use the audio error UI. Undo preserves a surviving current entry; otherwise it restores the previously selected entry and position paused. Undo never starts playback. Manual edits end personalized/heart recommendation ownership so a pending refill cannot overwrite the edited queue.

`playbackSelectionController.ts` carries the selected occurrence's entry ID into playback. Native queue reports prefer a matching delegated queue index before a provider-media hint; single-item native loads retain the renderer occurrence. Queue/session restoration cancels pending loads and invalidates native queue synchronization, and ignores old native start/progress events while the restored selection is waiting for playback. Automatic startup restore also resolves the saved entry identity before accepting a numeric index; legacy indices must be integers matching the saved track, and changing the selected entry resets position to zero. The mini player and LAN remote continue consuming the same queue, selection and transport refs; stale remote queue revisions are rejected after undo too.

## Sessions and actual playback order

The drawer's **会话** action and the command palette open `QueueWorkspaceDialog.vue`. Named sessions support save, explicit overwrite, rename, delete, restore and a separate restore-and-play action. Their stable-source persistence and missing-resource rules are specified in [Playlist Lifecycle](./playlist-lifecycle.md#named-queue-sessions).

`playbackHistoryController.ts` records actual successful playback starts separately from cumulative listening statistics, including successful cast queue switches. It retains duplicate occurrences, explicit replays and native repeat boundaries, including sequential, loop, shuffle and heart modes. Pausing/resuming or refreshing playback info does not add duplicate records. `queueWorkspaceStore.ts` debounces writes for 1.2 seconds and flushes on application close. The last 200 starts survive restart; the history panel renders a fixed-height virtual window in newest-first order.

The queue-virtualization test entry also runs `usePlaybackQueueDrawerActions.test.ts`. It exercises a drag beginning in a 20,000-item visible window while a queue update shifts indexes, and confirms that the stable source/target IDs resolve to the new current indexes.

## Authoritative Artifacts

- Runner: `scripts/playback-queue-virtualization-benchmark.ts`
- Runner test: `scripts/playback-queue-virtualization-benchmark.test.ts`
- Queue/composable/revision behavior tests: `src/renderer/src/utils/playbackQueueVirtualization.test.ts` and `src/renderer/src/utils/nativeQueueRevision.test.ts`
- Package-protected test entry point: `pnpm run test:queue-virtualization`
- Package benchmark entry point: `pnpm run benchmark:queue-virtualization`
- Formal machine-readable evidence: `docs/audit-evidence/te-3.4-queue-virtualization-2026-07-17.json`

There is no `scripts/playback-queue-virtualization-benchmark.cjs` runner or CJS test. The TypeScript paths above are the only supported paths.

From a clean candidate after frozen installation, run the package-protected test and benchmark commands. Set temporary state to E before either command:

```powershell
$env:TEMP = 'E:\twilight-audit-20260716\tmp-te34'
$env:TMP = $env:TEMP
pnpm run test:queue-virtualization
pnpm run benchmark:queue-virtualization
```

The benchmark command writes the formal evidence path above. The runner does not create an untracked build directory; its only output is the requested JSON evidence file.

The benchmark imports the production `toPlaybackQueueSnapshots`, `getPlaybackQueueWindow`, and `createPlaybackQueueDisplayItems` implementation. It generates 5,000 and 20,000 real `Track`-shaped entries with independent large lyrics, translations, metadata matches, and BPM tempo maps. It proves that the retained snapshot heavy-payload bytes are zero, verifies first/middle/last current-item visibility, and enforces p95 snapshot/window time, window heap, and mounted-row thresholds. Browser DOM allocation remains bounded by the same 18-row cap because the production template iterates only over `visibleQueueItems`.

## Queue workspace verification — 2026-09-14

The 20,000-entry benchmark passed with an 18-row maximum, 24.27 ms snapshot p95, 0.081 ms window
p95 and 9,328 bytes of maximum window heap growth. Retained heavy payloads are zero. The formal
artifact above retains its historical filename and records this run in `generatedAt`.

`test:queue-virtualization` passed 36 tests, `test:playback-routing` 550, `test:playlist-lifecycle`
51, `test:radio-remote` 155, `test:network-sources` 66 and `test:app` 356. `test:plugins` passed 390
with one existing skip. Lint, typecheck, formatting, IPC consistency and diff checks passed.

The hidden Electron `QueueWorkspaceDialog.behavior.test.ts` exercises the actual component and
controllers with a 20,000-entry named session. It verifies save/restore selection, paused default,
explicit playback, undo, CRUD, failed-write retry, keyboard/focus handling and bounded history DOM;
its rendered screenshot was inspected. Remote revision and mini-player tests exercise the shared
queue command controller. Real audio/cast devices and live provider accounts were not exercised.

# Local Library Metadata Enrichment

New or changed local tracks are committed to the renderer immediately. Cover art, lyrics, and
provider metadata are then requested by a background queue; enrichment must never delay the
first local-library render or change a local track into a provider track.

## Library Organization Inbox

The local-library tools menu opens **曲库整理收件箱**. Opening it derives issues from the
already-loaded immutable library snapshot; it does not parse audio, hash files, or search providers.
Missing covers include both cached cover and durable cover origin. Required-tag review covers
title/artist/album, empty or known placeholder values, and titles equal to the filename stem.
Filename matches are explicitly possible fallbacks, not proof that a file lacks a title tag.
Enrichment review means an existing medium-confidence provider match; absence of a provider match
alone is not an error. CUE entries retain distinct identities.

Users can filter, select, ignore, mark reviewed, and reopen issues. These review decisions are saved
in renderer localStorage under `twilight.library-inbox.v1`, bounded to the latest 20,000 decisions.
They are local to this application profile and do not alter tracks or files. Identity plus a content
fingerprint fences old decisions; changed metadata, reimport timestamps, or duplicate membership
produce pending issues again. The current snapshot replaces the issue index; duplicate results are
discarded on any intervening library replacement and require explicit rechecking. A read/write
storage failure is visible, and a failed save does not pretend the decision persisted.

Issue rows, duplicate members, tag previews, and write results render in pages of 50. Selection uses
an issue-key index and stores only selected keys. The explicit **全库后台重扫与补全** command reuses
`startFullLibraryScan`; scan/enrichment progress and cancellation remain owned by the existing
Settings library panel. Closing the inbox does not cancel that shared background job. F loudness
jobs are not included in this inbox.

Tag editing requires a per-file before/after preview and separate confirmation. Empty/whitespace
text fields leave existing tags intact, including fields that were typed then cleared. CUE/container
subtracks cannot be written through this file-level form; users edit the source file and rescan.
At most 1,000 distinct files can be submitted in one existing tag transaction. Both preview/submit
and returned cache updates compare source track objects with the current snapshot; a concurrent
scan or edit invalidates old work. This is a renderer snapshot fence, not an external-file lock.
Only confirmed successes still matching the snapshot refresh cached metadata. Cover art, year,
and file-backed tag recovery require explicit rescan to reflect their authoritative file values.
Failed, rolled-back, or unattempted files can be previewed and retried separately.

## Queue Contract

- The queue uses six workers by default and clamps configuration to four through eight workers.
- Requests are deduplicated by normalized title-and-artist query within a queued run. A failed
  query is retained with exponential retry backoff, so repeated scans do not repeatedly call an
  unavailable provider.
- Status is exposed separately from the file scan: the Settings library panel reports scanning,
  enriching, completed, failed, and cancelled states. Cancelling discards queued work and settles
  callers immediately.
- Each update carries both the enriched track and the exact local-track object it was derived
  from. The renderer accepts it only while that object is still the current record at the same
  local identity. A scan replacement, remove, reload, or later update therefore quarantines a
  late provider result before it reaches UI state or persistence.

## Cancellation Boundary

`LibraryMetadataEnrichmentQueue` supplies an `AbortSignal` to provider adapters and aborts every
active controller on cancellation. This is used when an adapter supports request aborting.

The current renderer-to-plugin provider IPC method has no `AbortSignal` or cancel-request field,
so plugin searches cannot yet be physically interrupted by the renderer. Those calls use logical
cancellation: queue generation fencing prevents result processing, and source-snapshot fencing
prevents stale updates from changing UI or scheduling `saveMusicLibrary`. The regression tests
cover both actual `AbortSignal` aborting and the no-abort late-result path. A future provider IPC
cancel protocol must retain both fences; transport abort alone is not sufficient for a result that
has already crossed a process boundary.

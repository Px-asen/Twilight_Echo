# Playlist Lifecycle

Local playlists support rename, cover selection, copying, manual ordering, and moving a selected group
to another playlist. A playlist update is queued as one versioned persistence transaction; a bulk action
does not create one JSON write per track.

## Named Queue Sessions

The queue drawer and command palette provide a **队列与会话** dialog. A session stores its name,
current and original queue orders, selected `queueEntryId`, position and playback mode. Save creates
a new name; overwrite, rename and delete are explicit actions. The limits are 20 sessions, 20,000
entries per session and 40,000 entries in total. A heart queue is saved as its already generated
sequential list; restoring it does not restart recommendation requests.

The shared DTO is `src/shared/queueWorkspace.ts`. `queue-workspace.json` stores named sessions and
the last 200 actual playback starts in a versioned envelope, with a 32 MiB byte limit, atomic writes
and backup recovery. `data:loadQueueWorkspace` and `data:saveQueueWorkspace` are registered in the
persistence IPC owner. The main handler checks trusted senders, schema/size and the expected
revision. Writes are serialized; a conflict adopts the authoritative document and requires the user
to retry the intended edit. Read and write errors remain visible in the dialog.

Saved entries contain stable source identities and compact display metadata. They omit resolved
stream URLs, media grants, cache paths, covers, lyrics and analysis payloads. Local entries resolve
against the current library by ID, and file availability/authorization is checked in batches of at
most 256 unique paths. Radio and podcast entries use the current station/subscription data. Network
entries retain their profile ID and entry identity; provider entries retain their provider/song IDs.
Network/profile and provider availability are rechecked when restoring; playable URLs are resolved
fresh on playback, rather than retained across sessions.

Missing local files, removed stations/episodes, absent network profiles and disabled providers are
skipped and reported. If the saved current entry was skipped, the first surviving entry is selected
at position zero. If no entries survive, the existing queue is retained. Remote resources whose
connection is checked on playback are explicitly identified as deferred; a later connection failure
uses the normal playback error UI.

Default restore prepares the new queue and selected position paused. **恢复并播放** is a separate
action through the existing playback controller. A restore that is cancelled, superseded, or sees a
new queue revision/selection cannot apply its old result. Queue replacement is undoable. The
existing startup resume preference and named session management remain independently usable.
The legacy automatic `playback-session.json` retains its existing 2 MiB limit; the 20,000-entry
save/restore validation applies to the named workspace format.

## Import And Export

The playlist detail toolbar imports and exports `M3U`, `M3U8`, and `PLS` files. The renderer
matches imported entries to known local-library paths. Entries that are not currently in the library are
reported as unmatched and are never fabricated as playable tracks.

The parser is deliberately bounded:

- input is limited to 8 MiB and 20,000 entries;
- comments, malformed PLS fields, empty paths, and NUL-containing paths are skipped or rejected;
- PLS entries are ordered by numeric `FileN` index, not input line order.

## Missing Files

Use the locate action in a playlist detail to choose a directory and scan it for replacement candidates.
Automatic repair only changes a playlist when there is one unambiguous match, preferring an exact filename
and then `title + artist + duration` (within two seconds). Multiple candidates remain untouched and are
reported for manual resolution. A repair replaces the stored playlist snapshot and track id together, so
the persisted order remains stable after restart.

## Covers

Playlist covers accept user-selected PNG, JPEG, and WebP files only. The UI rejects files larger than
6 MiB and images above 16 million pixels before writing a data URL. Covers are persisted with the same
versioned playlist transaction as the metadata edit.
